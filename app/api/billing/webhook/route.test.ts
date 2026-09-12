import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

const USER = "2f4fd830-c135-4ab7-bd81-6d060b5625b9", ORDER = "2f4fd830-c135-4ab7-bd81-6d060b5625b0", SECRET = "webhook-test-secret";
let calls: { name: string; params: any }[] = [], fail = false, available = true;
let order: Record<string, unknown> | null;
const admin = { from() { const query = { select() { return query; }, eq() { return query; }, maybeSingle() { return Promise.resolve({ data: order, error: null }); } }; return query; }, async rpc(name: string, params: unknown) { calls.push({ name, params }); return { error: fail ? { code: "XX000" } : null }; } };
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, { namedExports: { createAdminClient: () => available ? admin : null } });
registerHooks({ resolve(specifier, context, next) { try { return next(specifier, context); } catch(error) { for (const ext of [".ts", ".js"]) { try { return next(specifier + ext, context); } catch {} } throw error; } } });
const { POST } = await import("./route.ts");
test.beforeEach(() => { process.env.PADDLE_WEBHOOK_SECRET = SECRET; process.env.PADDLE_ENVIRONMENT = "sandbox"; calls = []; fail = false; available = true; order = { user_id: USER, plan_code: "semester", credits: 14400, months: 4, price_id: "pri_v2", transaction_id: "txn_test", environment: "sandbox" }; });
function event(overrides: Record<string, unknown> = {}) { return { event_id: "evt_test", event_type: "transaction.completed", occurred_at: "2026-09-06T00:00:00Z", data: { id: "txn_test", status: "completed", customer_id: "ctm_test", custom_data: { lecue_order_id: ORDER }, items: [{ price: { id: "pri_v2" }, quantity: 1 }], details: { totals: { grand_total: "9900", subtotal: "9900", discount: "0" } }, billed_at: "2026-09-06T00:00:00Z", ...overrides } }; }
function deliver(payload: unknown, signature?: string) { const body = JSON.stringify(payload), ts = Math.floor(Date.now()/1000); return POST(new Request("https://lecue.test/api/billing/webhook", { method: "POST", body, headers: { "paddle-signature": signature ?? `ts=${ts};h1=${createHmac("sha256", SECRET).update(`${ts}:${body}`).digest("hex")}` } })); }
test("forged and stale signatures cannot reach storage", async () => { assert.equal((await deliver(event(), "ts=1;h1=00")).status, 401); assert.equal(calls.length, 0); });
test("missing secret fails closed", async () => { delete process.env.PADDLE_WEBHOOK_SECRET; assert.equal((await deliver(event())).status, 503); });
test("null JSON is rejected cleanly", async () => { assert.equal((await deliver(null)).status,400); });
test("one atomic call preserves the original upfront purchase dates", async () => { assert.equal((await deliver(event())).status,200); assert.equal(calls.length,1); assert.equal(calls[0].name,"apply_billing_event"); assert.deepEqual(calls[0].params.p_grant,{user_id:USER,source_type:"payment",source_id:"txn_test",plan_code:"semester",credits:14400,months:4,entitlement_version:"upfront_v2",order_id:ORDER,starts_at:"2026-09-06T00:00:00Z",expires_at:"2027-01-06T00:00:00.000Z",paid_at:"2026-09-06T00:00:00Z",paid_subtotal:9900}); });
test("unknown order cannot grant credits", async () => { order=null; await deliver(event()); assert.equal(calls[0].params.p_grant,null); });
test("modified price and quantity do not change entitlement", async () => { await deliver(event({items:[{price:{id:"pri_cheap"},quantity:1}]})); assert.equal(calls[0].params.p_grant,null); await deliver(event({items:[{price:{id:"pri_v2"},quantity:2}]})); assert.equal(calls[1].params.p_grant,null); });
test("zero and malformed totals cannot grant credits", async () => { for(const grand_total of ["0","NaN","-1"]){await deliver(event({details:{totals:{grand_total,subtotal:"9900"}}})); assert.equal(calls.at(-1)?.params.p_grant,null);} });
test("unpaid transaction cannot grant credits", async () => { await deliver(event({status:"ready"})); assert.equal(calls.length,0); });
test("sandbox order is not honored in production", async () => { process.env.PADDLE_ENVIRONMENT="production"; await deliver(event()); assert.equal(calls[0].params.p_grant,null); });
test("database failure is retryable without a surviving separate claim", async () => { fail=true; assert.equal((await deliver(event())).status,500); assert.equal(calls.length,1); });
test("both immediate and delayed approved refunds use atomic adjustment ledger", async () => { for(const type of ["adjustment.created","adjustment.updated"]){await deliver({event_id:"evt_refund",event_type:type,occurred_at:"2026-09-07T00:00:00Z",data:{id:"adj_test",status:"approved",action:"refund",transaction_id:"txn_test",totals:{subtotal:"3300"}}}); assert.deepEqual(calls.at(-1)?.params.p_adjustment,{id:"adj_test",transaction_id:"txn_test",subtotal:3300});} });
test("pending refunds are not applied", async () => { await deliver({event_id:"evt_refund",event_type:"adjustment.created",occurred_at:"2026-09-07T00:00:00Z",data:{status:"pending_approval",action:"refund"}}); assert.equal(calls.length,0); });
test("tax-only adjustment carries zero credit reduction", async () => { await deliver({event_id:"evt_refund",event_type:"adjustment.created",occurred_at:"2026-09-07T00:00:00Z",data:{id:"adj_tax",status:"approved",action:"refund",transaction_id:"txn_test",totals:{subtotal:"0"}}}); assert.equal(calls[0].params.p_adjustment.subtotal,0); });
test("discounted purchase uses paid subtotal for proportional refunds", async()=>{await deliver(event({details:{totals:{grand_total:"8800",subtotal:"9900",discount:"1100"}}}));assert.equal(calls[0].params.p_grant.paid_subtotal,8800);});
test("missing storage fails closed",async()=>{available=false;assert.equal((await deliver(event())).status,503);});

test("old plans retain their stored validity rather than receiving a new year", async () => {
  for (const [plan_code, months, expires] of [["monthly",1,"2026-10-06"],["term",4,"2027-01-06"],["semester",6,"2027-03-06"],["annual",12,"2027-09-06"],["topup",12,"2027-09-06"]] as const) {
    order = { ...order, plan_code, months };
    await deliver(event());
    assert.equal(calls.at(-1)?.params.p_grant.expires_at, `${expires}T00:00:00.000Z`);
  }
});
test("old monthly credits retain subscription period dates even when captured later", async () => {
  order = { ...order, plan_code: "monthly", months: 1 };
  await deliver(event({ subscription_id: "sub_test", billing_period: { starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" }, payments: [{ status: "captured", captured_at: "2026-09-05T12:00:00Z" }] }));
  assert.equal(calls[0].params.p_grant.starts_at, "2026-09-01T00:00:00Z");
  assert.equal(calls[0].params.p_grant.expires_at, "2026-10-01T00:00:00Z");
  assert.equal(calls[0].params.p_account.period_ends_at, "2026-10-01T00:00:00Z");
});
test("new installment anchor uses capture rather than earlier invoice or cycle dates", async () => {
  order = { ...order, entitlement_version: "monthly_v1" };
  const payload = event({ billed_at: "2024-02-01T00:00:00Z", billing_period: { starts_at: "2024-02-01T00:00:00Z" }, payments: [
    { status: "captured", captured_at: "2024-02-29T11:00:00Z" },
    { status: "error", captured_at: "2024-03-01T01:00:00Z" },
    { status: "captured", captured_at: "2024-02-29T12:00:00Z" },
    { status: "captured", captured_at: "invalid" },
    { status: "captured", captured_at: "2025-01-01T00:00:00Z" },
    null,
  ] });
  payload.occurred_at = "2024-03-01T00:00:00Z";
  await deliver(payload);
  assert.equal(calls[0].params.p_grant.paid_at, "2024-02-29T12:00:00Z");
  assert.equal(calls[0].params.p_grant.expires_at, "2024-03-29T12:00:00.000Z");
});
test("new missing-capture anchor uses signed completion time", async () => {
  order = { ...order, entitlement_version: "monthly_v1" };
  await deliver(event({ billed_at: "2026-08-01T00:00:00Z", payments: [{ status: "error", captured_at: null }] }));
  assert.equal(calls[0].params.p_grant.paid_at, "2026-09-06T00:00:00Z");
});
test("payment failures, pending and canceled transactions never grant credits", async () => {
  for (const status of ["ready", "paid", "past_due", "canceled"]) {
    await deliver(event({ status }));
  }
  await deliver({ ...event(), event_type: "transaction.payment_failed" });
  assert.equal(calls.length, 0);
});
test("approved refunds request only the adjustment", async () => {
  await deliver({ event_id: "evt_refund", event_type: "adjustment.created", occurred_at: "2026-09-07T00:00:00Z", data: { id: "adj_test", status: "approved", action: "refund", transaction_id: "txn_test", totals: { subtotal: "9900" } } });
  assert.equal(calls[0].params.p_grant, null);
  assert.equal(calls[0].params.p_account, null);
});

test("new purchases carry immutable monthly entitlement terms to the database", async () => {
  for (const [plan_code, credits, months] of [["monthly", 2400, 1], ["semester", 9600, 4], ["halfyear", 14400, 6], ["annual", 28800, 12], ["topup", 1000, 12]] as const) {
    order = { ...order, plan_code, credits, months, entitlement_version: "monthly_v1" };
    assert.equal((await deliver(event())).status, 200);
    const grant = calls.at(-1)?.params.p_grant;
    assert.equal(grant.entitlement_version, "monthly_v1");
    assert.equal(grant.order_id, ORDER);
    assert.equal(grant.credits, credits);
    assert.equal(grant.months, months);
    assert.equal(grant.expires_at, plan_code === "topup" ? "2027-09-06T00:00:00.000Z" : "2026-10-06T00:00:00.000Z");
  }
});
test("earlier orders keep their stored upfront quantity and version", async () => {
  for (const credits of [10000, 14400, 18000]) {
    order = { ...order, credits, entitlement_version: "upfront_v2" };
    await deliver(event());
    assert.equal(calls.at(-1)?.params.p_grant.credits, credits);
    assert.equal(calls.at(-1)?.params.p_grant.entitlement_version, "upfront_v2");
  }
});
test("cancellation only updates subscription state, never retracts or creates installments", async () => {
  order = { ...order, plan_code: "monthly", credits: 2400, months: 1, entitlement_version: "monthly_v1" };
  process.env.PADDLE_API_KEY = "test-key";
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ data: { subscription_id: "sub_test", customer_id: "ctm_test" } }));
  try {
    const response = await deliver({ event_id: "evt_cancel", event_type: "subscription.canceled", occurred_at: "2026-09-07T00:00:00Z", data: {
      id: "sub_test", customer_id: "ctm_test", status: "canceled", custom_data: { lecue_order_id: ORDER },
      items: [{ price: { id: "pri_v2" }, quantity: 1 }], current_billing_period: null,
    } });
    assert.equal(response.status, 200);
    assert.equal(calls[0].params.p_grant, null);
    assert.equal(calls[0].params.p_adjustment, null);
    assert.equal(calls[0].params.p_account.status, "canceled");
  } finally { fetchMock.mock.restore(); delete process.env.PADDLE_API_KEY; }
});
test("subscription renewal uses the original order version and validates its binding", async () => {
  process.env.PADDLE_API_KEY = "test-key";
  const fetchMock = mock.method(globalThis, "fetch", async () => Response.json({ data: { subscription_id: "sub_test", customer_id: "ctm_test" } }));
  try {
    for (const entitlement_version of ["upfront_v2", "monthly_v1"]) {
      order = { ...order, plan_code: "monthly", credits: entitlement_version === "monthly_v1" ? 2400 : 3600, months: 1, entitlement_version };
      await deliver(event({ id: "txn_renewal", subscription_id: "sub_test" }));
      assert.equal(calls.at(-1)?.params.p_grant.entitlement_version, entitlement_version);
      assert.equal(calls.at(-1)?.params.p_grant.credits, order.credits);
      await deliver(event({ id: "txn_forged", subscription_id: "sub_other" }));
      assert.equal(calls.at(-1)?.params.p_grant, null);
    }
  } finally { fetchMock.mock.restore(); delete process.env.PADDLE_API_KEY; }
});

test("new Monthly late capture expires at verified cycle end to avoid renewal overlap", async () => {
  order = { ...order, plan_code: "monthly", credits: 2400, months: 1, entitlement_version: "monthly_v1" };
  await deliver(event({ subscription_id: "sub_test", billing_period: { starts_at: "2026-09-01T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" },
    payments: [{ status: "captured", captured_at: "2026-09-03T00:00:00Z" }] }));
  assert.equal(calls[0].params.p_grant.starts_at, "2026-09-03T00:00:00Z");
  assert.equal(calls[0].params.p_grant.expires_at, "2026-10-01T00:00:00Z");
  for (const ends_at of [null, "bad-date", "2026-09-02T00:00:00Z"]) {
    await deliver(event({ billing_period: { ends_at }, payments: [{ status: "captured", captured_at: "2026-09-03T00:00:00Z" }] }));
    assert.equal(calls.at(-1)?.params.p_grant.expires_at, "2026-10-03T00:00:00.000Z");
  }
});
