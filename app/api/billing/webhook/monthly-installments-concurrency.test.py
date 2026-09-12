"""Only the isolated /tmp PostgreSQL fixture. No app credentials/network calls."""
import concurrent.futures
import json
import subprocess
import uuid

PSQL = ['/opt/homebrew/opt/postgresql@18/bin/psql', '-h', '/tmp/lecue-credit-renewal-pg',
        '-p', '56439', '-U', 'credit_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt']
USER = str(uuid.uuid4())
ORDER = str(uuid.uuid4())
TAG = 'installment_concurrency_' + uuid.uuid4().hex
TX = 'txn_' + TAG


def run(sql):
    result = subprocess.run(PSQL, input=sql, text=True, capture_output=True, timeout=20)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def parallel(statements):
    with concurrent.futures.ThreadPoolExecutor(len(statements)) as pool:
        for result in pool.map(run, statements):
            pass


assert run("select inet_server_addr() is null and current_user='credit_test' and current_database()='postgres'") == 't'
try:
    run(f"""insert into auth.users(id,email) values('{USER}','{TAG}@example.invalid');
      insert into public.billing_orders(id,user_id,plan_code,price_id,credits,months,environment,transaction_id,entitlement_version)
      values('{ORDER}','{USER}','semester','pri_fixture',9600,4,'sandbox','{TX}','monthly_v1');
      insert into public.lecture_sessions(id,user_id,status) values('{USER}','{USER}','recording');""")
    grant = json.dumps(dict(user_id=USER, source_type='payment', source_id=TX, plan_code='semester',
                           credits=9600, months=4, entitlement_version='monthly_v1', order_id=ORDER, paid_subtotal=1000))
    parallel([f"""begin; select public.apply_billing_event('{TAG}_pay_{i}','transaction.completed',now(),
      '{grant}'::jsonb||jsonb_build_object('paid_at',now())); select pg_sleep(0.05); commit;""" for i in range(6)])
    assert run(f"select count(*)||':'||sum(granted_credits) from public.credit_grants where user_id='{USER}'") == '4:9600'

    refund = json.dumps(dict(id='adj_' + TAG, transaction_id=TX, subtotal=250))
    parallel([
        f"begin; select public.apply_billing_event('{TAG}_refund_{i}','adjustment.created',now(),null,null,'{refund}'); select pg_sleep(0.05); commit;"
        for i in range(2)
    ] + [f"begin; select public.consume_lecture_credits_service('{USER}','{USER}',0); select pg_sleep(0.05); commit;" for _ in range(2)]
      + [f"begin; select set_config('request.jwt.claim.sub','{USER}',true); select public.get_credit_status(); commit;"])
    assert run(f"select count(*) from public.billing_adjustments where transaction_id='{TX}'") == '1'
    assert run(f"select count(*) from public.lecture_credit_usage where user_id='{USER}'") == '1'
    assert run(f"select sum(remaining_credits)||':'||sum(refunded_credits) from public.credit_grants where user_id='{USER}'") == '7199:2400'
    assert run(f"select remaining_credits from public.credit_grants where purchase_transaction_id='{TX}' and installment_index=3") == '0'
    assert run(f"begin; select set_config('request.jwt.claim.sub','{USER}',true); select credits from public.get_credit_status(); commit;").splitlines()[-1] == '2399'
    print('PASS: parallel payment replays, duplicate refunds, same-minute charges, status reads serialize without double grants/charges or deadlocks')
finally:
    run(f"""delete from public.lecture_credit_usage where user_id='{USER}';
      delete from public.lecture_sessions where user_id='{USER}';
      delete from auth.users where id='{USER}';
      delete from public.billing_adjustments where transaction_id='{TX}';
      delete from public.billing_webhook_events where event_id like '{TAG}%';""")
