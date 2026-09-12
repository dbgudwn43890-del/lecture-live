#!/usr/bin/env python3
"""Self-contained backup/encryption/restore drill with synthetic identities only."""
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import sys
import tarfile
import tempfile

root = pathlib.Path(__file__).resolve().parents[2]
pg_bin = os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@18/bin')
age_bin = os.environ.get('AGE_BIN', 'age')
age_keygen = os.environ.get('AGE_KEYGEN_BIN', str(pathlib.Path(age_bin).with_name('age-keygen')))
with tempfile.TemporaryDirectory(prefix='lecue-backup-restore-test-') as temp:
    os.chmod(temp, 0o700)
    directory = pathlib.Path(temp)
    pg = directory / 'pg'
    started = False
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        test_port = reservation.getsockname()[1]
    def command(name, *args, env=None):
        return subprocess.run([str(pathlib.Path(pg_bin) / name), *args], env=env,
                              check=True, capture_output=True, text=True, timeout=120).stdout
    try:
        command('initdb', '-D', str(pg), '-A', 'trust', '--no-locale')
        command('pg_ctl', '-D', str(pg), '-l', str(directory / 'pg.log'), '-o', f'-k {temp} -p {test_port} -h 127.0.0.1', 'start')
        started = True
        sql_args = ['-h', temp, '-p', str(test_port), '-d', 'postgres', '-XqAt', '-v', 'ON_ERROR_STOP=1']
        fixture = """
CREATE SCHEMA auth; CREATE SCHEMA supabase_migrations; CREATE SCHEMA vault;
CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,encrypted_password text);
CREATE TABLE auth.identities(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),provider text);
CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,token text);
CREATE TABLE public.classrooms(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),title text);
CREATE TABLE public.lecture_sessions(id uuid PRIMARY KEY,user_id uuid REFERENCES auth.users(id),classroom_id uuid REFERENCES public.classrooms(id),title text);
CREATE TABLE public.transcript_segments(id serial PRIMARY KEY,session_id uuid REFERENCES public.lecture_sessions(id),text text);
CREATE TABLE public.lecture_notes(session_id uuid PRIMARY KEY REFERENCES public.lecture_sessions(id),content jsonb);
CREATE TABLE public.credit_grants(id integer PRIMARY KEY,user_id uuid REFERENCES auth.users(id),remaining_credits integer);
CREATE TABLE public.user_llm_credentials(user_id uuid PRIMARY KEY,api_key text);
CREATE TABLE public.lecture_index_queue(session_id uuid PRIMARY KEY REFERENCES public.lecture_sessions(id),state text);
CREATE TABLE public.lecture_summary_generations(session_id uuid PRIMARY KEY REFERENCES public.lecture_sessions(id),state text);
CREATE TABLE public.lecture_summary_daily_usage(user_id uuid PRIMARY KEY REFERENCES auth.users(id),attempts integer);
CREATE TABLE public.material_upload_daily_budget(user_id uuid PRIMARY KEY REFERENCES auth.users(id),attempts integer);
CREATE TABLE public.material_upload_reservations(id integer PRIMARY KEY,claim_token text);
CREATE TABLE vault.secrets(id integer PRIMARY KEY,secret text);
CREATE SEQUENCE auth.excluded_secret_seq;
ALTER TABLE public.classrooms ENABLE ROW LEVEL SECURITY;
CREATE TABLE supabase_migrations.schema_migrations(version text PRIMARY KEY);
INSERT INTO auth.users VALUES ('11111111-1111-4111-8111-111111111111','synthetic@example.test','synthetic-password-hash');
INSERT INTO auth.identities VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','email');
INSERT INTO auth.sessions VALUES ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','SECRET-SESSION-MUST-NOT-BACK-UP');
INSERT INTO public.classrooms VALUES ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','Synthetic room');
INSERT INTO public.lecture_sessions VALUES ('55555555-5555-4555-8555-555555555555','11111111-1111-4111-8111-111111111111','44444444-4444-4444-8444-444444444444','Synthetic lecture');
INSERT INTO public.transcript_segments VALUES (1,'55555555-5555-4555-8555-555555555555','Synthetic private lecture text');
INSERT INTO public.lecture_notes VALUES ('55555555-5555-4555-8555-555555555555','{"summary":"Synthetic note"}');
INSERT INTO public.credit_grants VALUES (1,'11111111-1111-4111-8111-111111111111',2359);
INSERT INTO public.user_llm_credentials VALUES ('11111111-1111-4111-8111-111111111111','SECRET-API-MUST-NOT-BACK-UP');
INSERT INTO public.lecture_index_queue VALUES ('55555555-5555-4555-8555-555555555555','queued');
INSERT INTO public.lecture_summary_generations VALUES ('55555555-5555-4555-8555-555555555555','complete');
INSERT INTO public.lecture_summary_daily_usage VALUES ('11111111-1111-4111-8111-111111111111',2);
INSERT INTO public.material_upload_daily_budget VALUES ('11111111-1111-4111-8111-111111111111',3);
INSERT INTO public.material_upload_reservations VALUES (1,'TRANSIENT-CLAIM-MUST-NOT-BACK-UP');
INSERT INTO vault.secrets VALUES (1,'VAULT-MUST-NOT-BACK-UP');
INSERT INTO supabase_migrations.schema_migrations VALUES ('20260908010000'),('20260911010000'),('20260911020000'),('20260911030000'),('20260911040000');
"""
        command('psql', *sql_args, '-c', fixture)
        provision = subprocess.run([sys.executable, str(root / 'scripts/backup/provision-role.py')], check=True, capture_output=True, text=True).stdout
        command('psql', *sql_args, '-c', provision)
        command('psql', *sql_args, '-c', 'ALTER ROLE lecue_backup LOGIN')
        def refuses(setup, cleanup, expected, label):
            command('psql', *sql_args, '-c', setup)
            try:
                result = subprocess.run([str(pathlib.Path(pg_bin) / 'psql'), *sql_args, '-c', provision],
                                        capture_output=True, text=True, timeout=120)
                assert result.returncode != 0, label
                assert expected in result.stderr, f'{label}: {result.stderr}'
            finally:
                command('psql', *sql_args, '-c', cleanup)

        table_privileges = [('SELECT','public.user_llm_credentials'), ('SELECT (api_key)','public.user_llm_credentials'),
                            ('UPDATE','public.classrooms'), ('UPDATE (title)','public.classrooms'), ('TRUNCATE','public.classrooms')]
        if int(command('psql', *sql_args, '-c', 'SHOW server_version_num').strip()) >= 170000:
            table_privileges.append(('MAINTAIN','public.classrooms'))
        for privilege, relation in table_privileges:
            refuses(f'GRANT {privilege} ON {relation} TO PUBLIC', f'REVOKE {privilege} ON {relation} FROM PUBLIC',
                    'retains SELECT on excluded relation' if privilege.startswith('SELECT') else 'retains write privileges',
                    f'PUBLIC {privilege} survives direct role revocation')
        for privilege, sequence in [('USAGE','public.transcript_segments_id_seq'), ('UPDATE','public.transcript_segments_id_seq'),
                                    ('SELECT','auth.excluded_secret_seq')]:
            refuses(f'GRANT {privilege} ON SEQUENCE {sequence} TO PUBLIC', f'REVOKE {privilege} ON SEQUENCE {sequence} FROM PUBLIC',
                    'retains SELECT on excluded sequence' if privilege == 'SELECT' else 'retains sequence USAGE or UPDATE',
                    f'PUBLIC sequence {privilege} survives direct role revocation')
        original_owner = command('psql', *sql_args, '-c', 'SELECT quote_ident(current_user)').strip()
        refuses('ALTER TABLE public.user_llm_credentials OWNER TO lecue_backup',
                f'ALTER TABLE public.user_llm_credentials OWNER TO {original_owner}',
                'owns database objects', 'existing role ownership must be refused')
        # PostgreSQL 16+ gives a CREATEROLE operator this administrative edge
        # automatically. It neither inherits privileges nor permits SET ROLE.
        command('psql', *sql_args, '-c', f'GRANT lecue_backup TO {original_owner} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE')
        command('psql', *sql_args, '-c', provision)
        command('psql', *sql_args, '-c', 'ALTER ROLE lecue_backup LOGIN')
        for option in ('INHERIT', 'SET'):
            refuses(f'GRANT lecue_backup TO {original_owner} WITH {option} TRUE',
                    f'GRANT lecue_backup TO {original_owner} WITH {option} FALSE',
                    'memberships in either direction', f'creator {option} privilege must be refused')
        refuses('CREATE ROLE backup_test_member; GRANT lecue_backup TO backup_test_member',
                'REVOKE lecue_backup FROM backup_test_member; DROP ROLE backup_test_member',
                'memberships in either direction', 'incoming role membership must be refused')
        refuses('CREATE ROLE backup_test_parent; GRANT backup_test_parent TO lecue_backup',
                'REVOKE backup_test_parent FROM lecue_backup; DROP ROLE backup_test_parent',
                'memberships in either direction', 'outgoing role membership must be refused')
        refuses('CREATE FUNCTION public.backup_test_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$',
                'DROP FUNCTION public.backup_test_definer()', 'Review PUBLIC definer privileges',
                'PUBLIC SECURITY DEFINER function must be refused')
        trigger = '''CREATE FUNCTION public.backup_test_trigger() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN UPDATE public.credit_grants SET remaining_credits=0; RETURN NEW; END $$'''
        command('psql', *sql_args, '-c', trigger)
        try:
            # EXECUTE on a definer trigger is an indirect write path through an
            # owned temporary table; read-only defaults can be overridden.
            assert command('psql', *sql_args, '-U', 'lecue_backup', '-c', '''BEGIN READ WRITE;
CREATE TEMP TABLE backup_trigger_target(id integer);
CREATE TRIGGER test_write AFTER INSERT ON backup_trigger_target FOR EACH ROW EXECUTE FUNCTION public.backup_test_trigger();
INSERT INTO backup_trigger_target VALUES (1); SELECT remaining_credits FROM public.credit_grants; ROLLBACK;''').strip() == '0'
            result = subprocess.run([str(pathlib.Path(pg_bin) / 'psql'), *sql_args, '-c', provision], capture_output=True, text=True, timeout=120)
            assert result.returncode != 0, 'PUBLIC SECURITY DEFINER trigger must be refused'
            assert 'Review PUBLIC definer privileges' in result.stderr
        finally:
            command('psql', *sql_args, '-c', 'DROP FUNCTION public.backup_test_trigger()')
        # Clean re-provisioning remains idempotent and login is enabled only in
        # this synthetic test's final operator step.
        command('psql', *sql_args, '-c', provision)
        command('psql', *sql_args, '-c', 'ALTER ROLE lecue_backup LOGIN')
        denied = subprocess.run([str(pathlib.Path(pg_bin) / 'psql'), *sql_args, '-U', 'lecue_backup', '-c', 'SELECT api_key FROM public.user_llm_credentials'], capture_output=True, text=True)
        assert denied.returncode != 0, 'backup login can read excluded BYOK credentials'
        denied = subprocess.run([str(pathlib.Path(pg_bin) / 'psql'), *sql_args, '-U', 'lecue_backup', '-c', 'SELECT token FROM auth.sessions'], capture_output=True, text=True)
        assert denied.returncode != 0, 'backup login can read active session tokens'
        privileges = command('psql', *sql_args, '-c', "SELECT has_table_privilege('lecue_backup','public.classrooms','INSERT,UPDATE,DELETE,TRUNCATE') OR has_sequence_privilege('lecue_backup','public.transcript_segments_id_seq','USAGE,UPDATE')").strip()
        assert privileges == 'f', 'backup login has write privileges'
        assert command('psql', *sql_args, '-U', 'lecue_backup', '-c', 'SELECT count(*) FROM public.classrooms').strip() == '1', 'RLS hides included rows from backup'
        identity = directory / 'identity.agekey' 
        subprocess.run([age_keygen, '-o', str(identity)], check=True, capture_output=True)
        recipient = subprocess.run([age_keygen, '-y', str(identity)], check=True, capture_output=True, text=True).stdout.strip()
        env = dict(os.environ, BACKUP_DATABASE_URL=f'postgresql://lecue_backup@127.0.0.1:{test_port}/postgres?sslmode=disable',
                   BACKUP_ALLOW_LOCAL='1', BACKUP_AGE_RECIPIENT=recipient, BACKUP_OUTPUT_DIR=str(directory / 'encrypted'), PG_BIN=pg_bin, AGE_BIN=age_bin)
        subprocess.run([sys.executable, str(root / 'scripts/backup/create.py')], env=env, check=True, capture_output=True, text=True, timeout=180)
        files = list((directory / 'encrypted').iterdir())
        assert len(files) == 1 and files[0].suffix == '.age', 'Only encrypted artifacts may survive'
        encrypted = files[0].read_bytes()
        assert b'Synthetic private lecture text' not in encrypted and b'synthetic@example.test' not in encrypted
        clear_tar = directory / 'snapshot.tar'
        subprocess.run([age_bin, '-d', '-i', str(identity), '-o', str(clear_tar), str(files[0])], check=True, capture_output=True)
        with tarfile.open(clear_tar) as archive:
            assert set(archive.getnames()) == {'manifest.json', 'database.dump'}
            manifest = json.load(archive.extractfile('manifest.json'))
            dump = directory / 'database.dump'
            dump.write_bytes(archive.extractfile('database.dump').read())
        assert hashlib.sha256(dump.read_bytes()).hexdigest() == manifest['dumpSha256']
        assert manifest['scope'] == 'database-only' and manifest['filesIncluded'] is False
        assert manifest['migrationVersions'] == ['20260908010000','20260911010000','20260911020000','20260911030000','20260911040000']
        assert manifest['rowCounts']['auth.users'] == 1 and manifest['rowCounts']['public.credit_grants'] == 1
        command('createdb', '-h', temp, '-p', str(test_port), 'recovered')
        command('psql', '-h', temp, '-p', str(test_port), '-d', 'recovered', '-c', 'DROP SCHEMA public')
        command('pg_restore', '-h', temp, '-p', str(test_port), '-d', 'recovered', '--no-owner', '--no-acl', '--exit-on-error', str(dump))
        restored = ['-h', temp, '-p', str(test_port), '-d', 'recovered', '-XqAt', '-v', 'ON_ERROR_STOP=1']
        for name, expected in manifest['rowCounts'].items():
            assert int(command('psql', *restored, '-c', f'SELECT count(*) FROM {name}').strip()) == expected, name
        assertions = """DO $$BEGIN
ASSERT (SELECT encrypted_password='synthetic-password-hash' FROM auth.users), 'password hash restore';
ASSERT (SELECT remaining_credits=2359 FROM public.credit_grants), 'balance restore';
ASSERT (SELECT text='Synthetic private lecture text' FROM public.transcript_segments), 'transcript restore';
ASSERT (SELECT content->>'summary'='Synthetic note' FROM public.lecture_notes), 'note restore';
ASSERT (SELECT count(*)=1 FROM auth.identities i JOIN auth.users u ON i.user_id=u.id), 'identity owner relation';
ASSERT (SELECT state='queued' FROM public.lecture_index_queue), 'durable index queue restore';
ASSERT (SELECT state='complete' FROM public.lecture_summary_generations), 'summary completion restore';
ASSERT (SELECT attempts=2 FROM public.lecture_summary_daily_usage), 'summary budget restore';
ASSERT (SELECT attempts=3 FROM public.material_upload_daily_budget), 'material budget restore';
ASSERT to_regclass('public.material_upload_reservations') IS NULL, 'transient material claim excluded';
ASSERT to_regclass('public.user_llm_credentials') IS NULL, 'BYOK schema/data excluded';
ASSERT to_regclass('auth.sessions') IS NULL, 'session schema/data excluded';
ASSERT to_regclass('auth.excluded_secret_seq') IS NULL, 'excluded sequence not copied';
ASSERT to_regnamespace('vault') IS NULL, 'Vault excluded';
BEGIN INSERT INTO public.credit_grants VALUES (2,'99999999-9999-4999-8999-999999999999',1);
RAISE EXCEPTION 'restored FK missing'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END$$;"""
        command('psql', *restored, '-c', assertions)
        # Truncation/corruption must fail authenticated decryption.
        tampered = directory / 'tampered.age'
        tampered.write_bytes(encrypted[:-16] + bytes([encrypted[-16] ^ 1]) + encrypted[-15:])
        check = subprocess.run([age_bin, '-d', '-i', str(identity), str(tampered)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        assert check.returncode != 0, 'modified backup authenticated successfully'
        print('PASS: inherited privilege/ownership/membership/definer guards, least-privilege login, RLS complete rows, no writes or excluded secret access, encrypted snapshot, synthetic identities/relations/credits/notes and current recovery budgets restore, tamper rejection')
    except subprocess.CalledProcessError as error:
        # All data in this drill is synthetic. Preserve concise diagnostic only.
        print(error.stderr or str(error), file=sys.stderr)
        raise
    finally:
        if started:
            command('pg_ctl', '-D', str(pg), 'stop', '-m', 'fast')
