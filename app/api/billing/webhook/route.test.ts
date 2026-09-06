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
test("one atomic call grants exactly the stored purchase and expiry", async () => { assert.equal((await deliver(event())).status,200); assert.equal(calls.length,1); assert.equal(calls[0].name,"apply_billing_event"); assert.deepEqual(calls[0].params.p_grant,{user_id:USER,source_type:"payment",source_id:"txn_test",plan_code:"semester",credits:14400,starts_at:"2026-09-06T00:00:00Z",expires_at:"2027-01-06T00:00:00.000Z",paid_subtotal:9900}); });
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
