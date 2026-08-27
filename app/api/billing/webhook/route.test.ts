import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

import { PLAN_CREDITS } from "../../../lib/billing.ts";

// Every call the handler makes against Supabase, in order, so a test can assert
// on what was written rather than on what the handler returned.
type Call = {
  table: string;
  op: "insert" | "upsert" | "update" | "delete" | "select" | "rpc";
  payload?: unknown;
  options?: unknown;
  filters: string[];
};

type Outcome = { data?: unknown; error?: unknown };

let calls: Call[] = [];
let outcomes: Record<string, Outcome> = {};

function outcomeFor(call: Call): Outcome {
  return outcomes[`${call.table}.${call.op}`] ?? { data: null, error: null };
}

function queryBuilder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  const settle = () => Promise.resolve(outcomeFor(call));
  const api = {
    insert(payload: unknown) { call.op = "insert"; call.payload = payload; calls.push(call); return api; },
    upsert(payload: unknown, options?: unknown) { call.op = "upsert"; call.payload = payload; call.options = options; calls.push(call); return api; },
    update(payload: unknown) { call.op = "update"; call.payload = payload; calls.push(call); return api; },
    delete() { call.op = "delete"; calls.push(call); return api; },
    select(columns?: string) { if (call.op === "select") { call.payload = columns; calls.push(call); } return api; },
    eq(column: string, value: unknown) { call.filters.push(`eq:${column}=${String(value)}`); return api; },
    is(column: string, value: unknown) { call.filters.push(`is:${column}=${String(value)}`); return api; },
    maybeSingle: settle,
    then(resolve: (value: Outcome) => unknown, reject?: (reason: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return api;
}

const admin = {
  from: queryBuilder,
  rpc(name: string, params: unknown) {
    const call: Call = { table: `rpc:${name}`, op: "rpc", payload: params, filters: [] };
    calls.push(call);
    return Promise.resolve(outcomeFor(call));
  },
};

let adminClient: unknown = admin;

mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: { createAdminClient: () => adminClient },
});

// The route imports "next/server" and "../../../lib/billing" the way a bundler
// resolves them — no file extension. Node needs one, so retry with the
// extensions the repo actually uses before giving up.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* try the next one */ }
      }
      throw error;
    }
  },
});

const { POST } = await import("./route.ts");

const SECRET = "pdl_ntfset_test";
const USER_ID = "2f4fd830-c135-4ab7-bd81-6d060b5625b9";

process.env.PADDLE_WEBHOOK_SECRET = SECRET;
process.env.PADDLE_MONTHLY_PRICE_ID = "pri_monthly";
process.env.PADDLE_MONTHLY_NO_TRIAL_PRICE_ID = "pri_monthly_no_trial";
process.env.PADDLE_TERM_PRICE_ID = "pri_term";
process.env.PADDLE_SEMESTER_PRICE_ID = "pri_semester";

test.beforeEach(() => {
  calls = [];
  outcomes = {};
  adminClient = admin;
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
});

function deliver(event: unknown, options: { signature?: string } = {}) {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const digest = createHmac("sha256", SECRET).update(`${timestamp}:${body}`).digest("hex");
  return POST(new Request("https://lecue.test/api/billing/webhook", {
    method: "POST",
    headers: { "paddle-signature": options.signature ?? `ts=${timestamp};h1=${digest}` },
    body,
  }));
}

function transactionCompleted(overrides: Record<string, unknown> = {}) {
  return {
    event_id: "evt_tx_1",
    event_type: "transaction.completed",
    occurred_at: "2026-08-27T00:00:00.000Z",
    data: {
      id: "txn_1",
      customer_id: "ctm_1",
      custom_data: { lecue_user_id: USER_ID, plan_code: "term" },
      items: [{ price: { id: "pri_term" } }],
      details: { totals: { grand_total: "19900" } },
      billing_period: { starts_at: "2026-08-27T00:00:00.000Z", ends_at: null },
      billed_at: "2026-08-27T00:00:00.000Z",
      ...overrides,
    },
  };
}

const grants = () => calls.filter((call) => call.table === "credit_grants");

test("rejects a forged signature without touching the database", async () => {
  const response = await deliver(transactionCompleted(), { signature: "ts=1800000000;h1=deadbeef" });
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("refuses to process anything while the webhook secret is unset", async () => {
  delete process.env.PADDLE_WEBHOOK_SECRET;
  const response = await deliver(transactionCompleted());
  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});

test("acknowledges a replayed event without granting the credits twice", async () => {
  outcomes["billing_webhook_events.insert"] = { error: { code: "23505" } };
  const response = await deliver(transactionCompleted());
  assert.equal(response.status, 200);
  assert.deepEqual(grants(), []);
});

test("grants exactly the plan's credits, keyed to the transaction so a retry is a no-op", async () => {
  const response = await deliver(transactionCompleted());
  assert.equal(response.status, 200);
  const [grant] = grants();
  assert.deepEqual(grant.payload, {
    user_id: USER_ID,
    source_type: "payment",
    source_id: "txn_1",
    plan_code: "term",
    granted_credits: PLAN_CREDITS.term,
    remaining_credits: PLAN_CREDITS.term,
    starts_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-12-27T00:00:00.000Z",
  });
  assert.deepEqual(grant.options, { onConflict: "source_type,source_id", ignoreDuplicates: true });
});

test("ignores a transaction for a price we do not sell", async () => {
  const response = await deliver(transactionCompleted({ items: [{ price: { id: "pri_someone_elses" } }] }));
  assert.equal(response.status, 200);
  assert.deepEqual(grants(), []);
});

test("ignores a transaction that collected no money", async () => {
  const response = await deliver(transactionCompleted({ details: { totals: { grand_total: "0" } } }));
  assert.equal(response.status, 200);
  assert.deepEqual(grants(), []);
});

test("ignores a transaction whose custom_data names no valid user", async () => {
  const response = await deliver(transactionCompleted({ custom_data: { lecue_user_id: "not-a-uuid", plan_code: "term" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(grants(), []);
});

test("releases the event claim when granting fails so Paddle's retry can reprocess it", async () => {
  outcomes["credit_grants.upsert"] = { error: { code: "PGRST301" } };
  const response = await deliver(transactionCompleted());
  assert.equal(response.status, 500);
  const release = calls.find((call) => call.table === "billing_webhook_events" && call.op === "delete");
  assert.ok(release, "the claim row must be deleted");
  assert.deepEqual(release.filters, ["eq:event_id=evt_tx_1"]);
});

test("zeroes the credits an approved refund paid for", async () => {
  const response = await deliver({
    event_id: "evt_adj_1",
    event_type: "adjustment.updated",
    occurred_at: "2026-08-28T00:00:00.000Z",
    data: { action: "refund", status: "approved", transaction_id: "txn_1" },
  });
  assert.equal(response.status, 200);
  const [revocation] = grants();
  assert.equal((revocation.payload as { remaining_credits: number }).remaining_credits, 0);
  assert.equal((revocation.payload as { revoked_at: string }).revoked_at, "2026-08-28T00:00:00.000Z");
  assert.deepEqual(revocation.filters, [
    "eq:source_type=payment",
    "eq:source_id=txn_1",
    "is:revoked_at=null",
  ]);
});

test("leaves the credits alone while a refund is still pending", async () => {
  const response = await deliver({
    event_id: "evt_adj_2",
    event_type: "adjustment.updated",
    occurred_at: "2026-08-28T00:00:00.000Z",
    data: { action: "refund", status: "pending_approval", transaction_id: "txn_1" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(grants(), []);
});

test("grants the trial credits once when a subscription starts trialing", async () => {
  const response = await deliver({
    event_id: "evt_sub_1",
    event_type: "subscription.created",
    occurred_at: "2026-08-27T00:00:00.000Z",
    data: {
      id: "sub_1",
      customer_id: "ctm_1",
      status: "trialing",
      custom_data: { lecue_user_id: USER_ID, plan_code: "monthly" },
      items: [{ price: { id: "pri_monthly" } }],
      started_at: "2026-08-27T00:00:00.000Z",
      next_billed_at: "2026-09-03T00:00:00.000Z",
      current_billing_period: { starts_at: "2026-08-27T00:00:00.000Z", ends_at: "2026-09-03T00:00:00.000Z" },
    },
  });
  assert.equal(response.status, 200);
  assert.ok(calls.some((call) => call.table === "rpc:sync_billing_account"));
  const [grant] = grants();
  assert.deepEqual(grant.payload, {
    user_id: USER_ID,
    source_type: "trial",
    source_id: USER_ID,
    plan_code: "trial",
    granted_credits: 180,
    remaining_credits: 180,
    starts_at: "2026-08-27T00:00:00.000Z",
    expires_at: "2026-09-03T00:00:00.000Z",
  });
  assert.deepEqual(grant.options, { onConflict: "source_type,source_id", ignoreDuplicates: true });
});

test("ignores a subscription event for a price that is not the monthly plan", async () => {
  const response = await deliver({
    event_id: "evt_sub_2",
    event_type: "subscription.created",
    occurred_at: "2026-08-27T00:00:00.000Z",
    data: {
      id: "sub_2",
      customer_id: "ctm_1",
      status: "trialing",
      custom_data: { lecue_user_id: USER_ID, plan_code: "monthly" },
      items: [{ price: { id: "pri_someone_elses" } }],
      started_at: "2026-08-27T00:00:00.000Z",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.filter((call) => call.table !== "billing_webhook_events"), []);
});

test("reports storage as unconfigured instead of dropping a real payment", async () => {
  adminClient = null;
  const response = await deliver(transactionCompleted());
  assert.equal(response.status, 503);
  assert.deepEqual(calls, []);
});
