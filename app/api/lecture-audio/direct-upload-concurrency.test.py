"""Actual PostgreSQL upload admission/lease races in a disposable local cluster."""
import concurrent.futures
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

HERE = Path(__file__).resolve().parent
PG_BIN = Path(shutil.which('pg_ctl') or '/opt/homebrew/opt/postgresql@18/bin/pg_ctl').parent

def command(args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, timeout=30, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result.stdout.strip()

with tempfile.TemporaryDirectory(prefix='lecue-audio-direct-', dir='/tmp') as root:
    root = Path(root)
    cluster = root / 'data'
    command([str(PG_BIN / 'initdb'), '-D', str(cluster), '-U', 'audio_test', '-A', 'trust', '--no-locale'])
    command([str(PG_BIN / 'pg_ctl'), '-D', str(cluster), '-l', str(root / 'postgres.log'),
             '-o', f"-k {root} -h '' -p 56532", '-w', 'start'])
    psql = [str(PG_BIN / 'psql'), '-h', str(root), '-p', '56532', '-U', 'audio_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt']
    def run(sql):
        return command(psql, input=sql)
    def result(sql):
        try:
            return json.loads(run(sql))
        except RuntimeError as error:
            return str(error)
    def parallel(sqls):
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            return list(pool.map(result, sqls))
    def prepare(user, key):
        return f"select prepare_audio_upload_service('{user}',null,'Lecture','lecture.wav',5000000,'en','{key}')"
    try:
        command(psql + ['-f', str(HERE / 'direct-upload.test.sql')])
        assert run("select inet_server_addr() is null and current_user='audio_test'") == 't'
        user = str(uuid.uuid4())
        run(f"insert into auth.users values('{user}')")
        results = parallel([prepare(user, str(uuid.uuid4())) for _ in range(20)])
        accepted = [item for item in results if isinstance(item, dict)]
        assert len(accepted) == 2, results
        assert all('AUDIO_UPLOAD_PENDING_LIMIT' in item for item in results if isinstance(item, str))
        upload_id = accepted[0]['upload']['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            claims = list(pool.map(run, [f"select claim_audio_verification_service('{user}','{upload_id}','{uuid.uuid4()}')" for _ in range(20)]))
        assert claims.count('t') == 1, claims

        # Same idempotency key in twenty transactions returns one object/lesson.
        user = str(uuid.uuid4()); key = str(uuid.uuid4())
        run(f"insert into auth.users values('{user}')")
        results = parallel([prepare(user, key) for _ in range(20)])
        assert all(isinstance(item, dict) for item in results), results
        assert len({item['upload']['id'] for item in results}) == 1
        assert run(f"select uploads from audio_upload_daily_budget where user_id='{user}'") == '1'

        # One final daily token cannot be oversubscribed across independent keys.
        run(f"delete from lecture_sessions where user_id='{user}'; update audio_upload_daily_budget set uploads=19 where user_id='{user}'")
        results = parallel([prepare(user, str(uuid.uuid4())) for _ in range(20)])
        assert sum(isinstance(item, dict) for item in results) == 1, results
        assert all('AUDIO_UPLOAD_DAILY_LIMIT' in item for item in results if isinstance(item, str))
        print('PASS: actual migration + 20-way pending limit, verification lease, idempotency, daily budget; private disposable PostgreSQL only')
    finally:
        command([str(PG_BIN / 'pg_ctl'), '-D', str(cluster), '-m', 'immediate', '-w', 'stop'])
