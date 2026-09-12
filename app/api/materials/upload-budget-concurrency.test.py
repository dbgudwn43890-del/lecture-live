"""Actual PostgreSQL migration/concurrency; private temporary cluster, no app DB."""
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


with tempfile.TemporaryDirectory(prefix='lecue-material-upload-', dir='/tmp') as root:
    root = Path(root)
    cluster = root / 'data'
    command([str(PG_BIN / 'initdb'), '-D', str(cluster), '-U', 'material_test', '-A', 'trust', '--no-locale'])
    command([str(PG_BIN / 'pg_ctl'), '-D', str(cluster), '-l', str(root / 'postgres.log'),
             '-o', f"-k {root} -h '' -p 56531", '-w', 'start'])
    psql = [str(PG_BIN / 'psql'), '-h', str(root), '-p', '56531', '-U', 'material_test',
            '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt']

    def run(sql):
        return command(psql, input=sql)

    def parallel(statements):
        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            return list(pool.map(run, statements))

    def account():
        user, session = str(uuid.uuid4()), str(uuid.uuid4())
        run(f"insert into auth.users values('{user}'); insert into lecture_sessions values('{session}','{user}');")
        return user, session

    try:
        command(psql + ['-f', str(HERE / 'upload-budget.test.sql')])
        assert run("select inet_server_addr() is null and current_user='material_test'") == 't'

        # Twenty independent transactions race for ONE remaining session slot.
        user, session = account()
        run(f"insert into material_documents(user_id,session_id) select '{user}','{session}' from generate_series(1,19)")
        claims = [json.loads(value) for value in parallel([
            f"select reserve_material_upload('{session}','{user}')" for _ in range(20)
        ])]
        accepted = [claim for claim in claims if claim['allowed']]
        assert len(accepted) == 1, claims
        assert all(claim.get('reason') == 'document_limit' for claim in claims if not claim['allowed'])
        claim = accepted[0]['claim_token']
        assert json.loads(run(f"select charge_material_upload('{claim}','{user}',100,100,1)"))['allowed']
        run(f"insert into material_documents(id,user_id,session_id) values('{claim}','{user}','{session}')")
        assert run(f"select count(*) from material_documents where session_id='{session}'") == '20'

        # Two simultaneous uploads/user, even across different sessions.
        user, session = account()
        claims = [json.loads(value) for value in parallel([
            f"select reserve_material_upload('{session}','{user}')" for _ in range(20)
        ])]
        assert sum(claim['allowed'] for claim in claims) == 2

        # Migration-first rollout: old code still inserts, but never row 21.
        user, session = account()
        parallel([f"insert into material_documents(user_id,session_id) values('{user}','{session}')" for _ in range(20)])
        assert run(f"select count(*) from material_documents where session_id='{session}'") == '20'
        try:
            run(f"insert into material_documents(user_id,session_id) values('{user}','{session}')")
            raise AssertionError('legacy 21st insert accepted')
        except RuntimeError as error:
            assert 'material_document_limit' in str(error)
        print('PASS: actual migration + 20-way reservations, per-user concurrency, 20-way legacy inserts; no slot overshoot')
    finally:
        command([str(PG_BIN / 'pg_ctl'), '-D', str(cluster), '-m', 'immediate', '-w', 'stop'])
