#!/usr/bin/env python3
"""Encrypted DB-only snapshot. Secrets are read from env, never argv/logs/artifacts."""
import datetime
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse

EXCLUDED_PUBLIC_DATA = {
    'user_llm_credentials', 'rate_limit_counters', 'generation_leases',
    'stt_relay_tickets', 'stt_relay_sessions',
    'material_upload_reservations',
}
PUBLIC_DATA = {
    'classrooms', 'lecture_sessions', 'transcript_segments', 'lecture_chunks',
    'lecture_questions', 'material_documents', 'material_chunks', 'lecture_notes',
    'lecture_concepts', 'lecture_summaries', 'lecture_reports', 'billing_accounts',
    'credit_grants', 'lecture_credit_usage', 'billing_webhook_events', 'billing_orders',
    'billing_adjustments', 'consents', 'uploads', 'storage_deletion_jobs',
    'audio_credit_allocations', 'audio_credit_reservations', 'lecture_index_daily_budget',
    'lecture_index_jobs',
    'lecture_index_queue', 'lecture_summary_generations', 'lecture_summary_daily_usage',
    'material_upload_daily_budget',
}
AUTH_DATA = {'users', 'identities'}
MIGRATION_DATA = {'schema_migrations'}


def main():
    os.umask(0o077)
    database_url = os.environ.get('BACKUP_DATABASE_URL', '')
    recipient = os.environ.get('BACKUP_AGE_RECIPIENT', '')
    if not database_url or not re.fullmatch(r'age1[0-9a-z]{58}', recipient):
        raise RuntimeError('BACKUP_DATABASE_URL and a valid age public recipient are required')
    parsed = urllib.parse.urlsplit(database_url)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname:
        raise RuntimeError('Invalid backup database connection')
    local = parsed.hostname in ('localhost', '127.0.0.1', '::1') and os.environ.get('BACKUP_ALLOW_LOCAL') == '1'
    params = urllib.parse.parse_qs(parsed.query)
    sslmode = params.get('sslmode', ['require'])[0]
    if not local and sslmode not in ('require', 'verify-ca', 'verify-full'):
        raise RuntimeError('Remote backups require TLS')
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'TMPDIR') if key in os.environ}
    env.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
               PGUSER=urllib.parse.unquote(parsed.username or 'postgres'),
               PGPASSWORD=urllib.parse.unquote(parsed.password or ''),
               PGDATABASE=urllib.parse.unquote(parsed.path.lstrip('/') or 'postgres'),
               PGSSLMODE=sslmode, PGCONNECT_TIMEOUT='20', PGAPPNAME='lecue-encrypted-backup')
    pg_bin = os.environ.get('PG_BIN', '')
    tool = lambda name: str(pathlib.Path(pg_bin) / name) if pg_bin else name
    age = os.environ.get('AGE_BIN', 'age')
    output_dir = pathlib.Path(os.environ.get('BACKUP_OUTPUT_DIR', 'backup-output')).resolve()
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = output_dir / f'lecue-database-{stamp}.tar.age'
    maximum = int(os.environ.get('BACKUP_MAX_BYTES', str(256 * 1024 * 1024)))

    def run(name, args, timeout=600):
        result = subprocess.run([tool(name), *args], env=env, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f'{name} failed (exit {result.returncode}); connection details withheld')
        return result.stdout

    with tempfile.TemporaryDirectory(prefix='lecue-db-backup-') as temp:
        directory = pathlib.Path(temp)
        keeper = subprocess.Popen([tool('psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], env=env,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        try:
            keeper.stdin.write('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n')
            keeper.stdin.flush()
            snapshot = keeper.stdout.readline().strip()
            if not re.fullmatch(r'[0-9A-Fa-f-]+', snapshot):
                raise RuntimeError('Could not create a consistent backup snapshot')

            def query(sql):
                command = f"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '{snapshot}'; {sql}; COMMIT;"
                return run('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', command], timeout=120).decode().strip()

            tables = [json.loads(line) for line in query("""
              SELECT json_build_object('schema', schemaname, 'table', tablename)
              FROM pg_tables WHERE schemaname IN ('public','auth','supabase_migrations')
              ORDER BY schemaname, tablename
            """).splitlines() if line]
            if not any(t['schema'] == 'auth' and t['table'] == 'users' for t in tables):
                raise RuntimeError('Missing auth.users; refusing an incomplete identity backup')
            if not any(t['schema'] == 'supabase_migrations' and t['table'] == 'schema_migrations' for t in tables):
                raise RuntimeError('Missing migration versions; refusing an unversioned backup')
            unknown_public = [t['table'] for t in tables if t['schema'] == 'public'
                              and t['table'] not in PUBLIC_DATA | EXCLUDED_PUBLIC_DATA]
            if unknown_public:
                raise RuntimeError('An unreviewed public table requires a backup allowlist update')
            excluded = [f"{t['schema']}.{t['table']}" for t in tables if
                        (t['schema'] == 'auth' and t['table'] not in AUTH_DATA) or
                        (t['schema'] == 'public' and t['table'] in EXCLUDED_PUBLIC_DATA) or
                        (t['schema'] == 'supabase_migrations' and t['table'] not in MIGRATION_DATA)]
            included = [t for t in tables if f"{t['schema']}.{t['table']}" not in excluded]
            # Excluded data must also be inaccessible to this login. pg_dump locks
            # every selected table even with --exclude-table-data, requiring SELECT.
            # Exclude its definition too; restore it from matching Supabase/migrations.
            sequences = [json.loads(line) for line in query("""
              SELECT json_build_object('schema',n.nspname,'name',c.relname,
                'ownerSchema',tn.nspname,'ownerTable',t.relname)
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
              LEFT JOIN pg_depend d ON d.objid=c.oid AND d.classid='pg_class'::regclass
                AND d.refclassid='pg_class'::regclass AND d.deptype IN ('a','i')
              LEFT JOIN pg_class t ON t.oid=d.refobjid
              LEFT JOIN pg_namespace tn ON tn.oid=t.relnamespace
              WHERE c.relkind='S' AND n.nspname IN ('public','auth','supabase_migrations')
            """).splitlines() if line]
            included_names = {(t['schema'], t['table']) for t in included}
            excluded_sequences = [f"{s['schema']}.{s['name']}" for s in sequences
                                  if (s['ownerSchema'], s['ownerTable']) not in included_names]
            quote = lambda identifier: '"' + identifier.replace('"', '""') + '"'
            counts = {}
            for table in included:
                key = f"{table['schema']}.{table['table']}"
                counts[key] = int(query(f"SELECT count(*) FROM {quote(table['schema'])}.{quote(table['table'])}"))
            migrations = query('SELECT coalesce(json_agg(version ORDER BY version),\'[]\'::json) FROM supabase_migrations.schema_migrations')
            dump = directory / 'database.dump'
            args = ['--format=custom', '--compress=6', '--no-owner', '--no-acl', '--enable-row-security', '--lock-wait-timeout=30000',
                    f'--snapshot={snapshot}', '--schema=public', '--schema=auth', '--schema=supabase_migrations',
                    '--file', str(dump)]
            args.extend(f'--exclude-table={name}' for name in excluded + excluded_sequences)
            run('pg_dump', args)
            archive_list = run('pg_restore', ['--list', str(dump)], timeout=60).decode()
            if not dump.stat().st_size or 'TABLE DATA auth users' not in archive_list:
                raise RuntimeError('Backup archive is missing required identity data')
            if any(f'TABLE DATA {name.replace(".", " ")}' in archive_list for name in excluded):
                raise RuntimeError('Backup contains excluded secret or transient table data')
            manifest = {
                'formatVersion': 2, 'scope': 'database-only', 'createdAtUtc': stamp,
                'sourceCommit': os.environ.get('GITHUB_SHA', ''),
                'postgresServerVersion': query('SHOW server_version'),
                'migrationVersions': json.loads(migrations), 'rowCounts': counts,
                'excludedTableData': excluded,
                'excludedTableSchemas': excluded,
                'excludedSequences': excluded_sequences,
                'excludedSchemas': ['vault', 'storage'],
                'filesIncluded': False,
                'restoreLimitations': ['PDF originals are not included; extracted material text is included.',
                    'Audio originals are ephemeral and intentionally excluded.',
                    'BYOK credentials must be entered again; active sessions require sign-in again.',
                    'Excluded tables and their sequences require matching Supabase schemas and the recorded application migrations before restore.',
                    'Restore included schemas/data and reconfigure providers/secrets separately.'],
                'dumpSha256': hashlib.sha256(dump.read_bytes()).hexdigest(),
            }
            (directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
            tar_path = directory / 'snapshot.tar'
            with tarfile.open(tar_path, 'w') as archive:
                for name in ('database.dump', 'manifest.json'):
                    archive.add(directory / name, arcname=name, recursive=False)
            if tar_path.stat().st_size > maximum:
                raise RuntimeError('Backup exceeds configured encrypted artifact size limit')
            result = subprocess.run([age, '-r', recipient, '-o', str(target), str(tar_path)],
                                    capture_output=True, timeout=120, env=env)
            if result.returncode:
                target.unlink(missing_ok=True)
                raise RuntimeError('Backup encryption failed')
            if target.stat().st_size > maximum:
                target.unlink(missing_ok=True)
                raise RuntimeError('Encrypted backup exceeds configured size limit')
            # Only encrypted file name and table count are printed, never the manifest.
            print(f'Encrypted database backup created: {target.name}; {len(included)} tables; file originals excluded.')
        finally:
            if keeper.poll() is None:
                try:
                    keeper.stdin.write('ROLLBACK;\n\\q\n')
                    keeper.stdin.flush()
                    keeper.wait(timeout=5)
                except (BrokenPipeError, subprocess.TimeoutExpired):
                    keeper.kill()
                    keeper.wait()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Connection strings, hashed passwords and provider content never reach CI logs.
        message = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f'Backup failed: {message}', file=sys.stderr)
        sys.exit(1)
