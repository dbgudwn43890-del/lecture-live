import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getCreditStatus } from "./credit-status.ts";

const now = new Date("2026-09-08T00:00:00Z");

function grant(overrides: Partial<ReturnType<typeof baseGrant>> = {}) {
  return { ...baseGrant(), ...overrides };
}

function baseGrant() {
  return {
    id: "grant-1",
    plan_code: "monthly",
    granted_credits: 2400,
    refunded_credits: 0,
    remaining_credits: 1200,
    starts_at: "2026-09-01T00:00:00Z",
    expires_at: "2026-10-01T00:00:00Z",
    revoked_at: null as string | null,
    created_at: "2026-09-01T00:00:00Z",
  };
}

function clientFor(grants: ReturnType<typeof grant>[], rpcRow: Record<string, unknown> = { credits: 1200 }) {
  let refreshed = false;
  const client = {
    async rpc(name: string) {
      assert.equal(name, "get_credit_status");
      await Promise.resolve();
      refreshed = true;
      return { data: [rpcRow], error: null };
    },
    from(table: string) {
      assert.ok(refreshed, "Read the status RPC before grants");
      assert.equal(table, "credit_grants");
      let rows = [...grants];
      const query = {
        select(columns: string) {
          assert.ok(columns.includes("granted_credits"));
          assert.ok(columns.includes("refunded_credits"));
          return query;
        },
        lte(column: string, value: string) {
          assert.equal(column, "starts_at");
          rows = rows.filter((row) => Date.parse(row.starts_at) <= Date.parse(value));
          return query;
        },
        or(filter: string) {
          const match = /^expires_at\.gt\.(.+),plan_code\.eq\.trial$/.exec(filter);
          assert.ok(match);
          rows = rows.filter((row) => Date.parse(row.expires_at) > Date.parse(match[1]) || row.plan_code === "trial");
          return query;
        },
        is(column: string, value: null) {
          assert.equal(column, "revoked_at");
          assert.equal(value, null);
          rows = rows.filter((row) => row.revoked_at === null);
          return query;
        },
        order(column: "created_at" | "id", options: { ascending: boolean }) {
          assert.equal(options.ascending, false);
          if (column === "created_at") rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
          return query;
        },
        async range(start: number, end: number) {
          return { data: rows.slice(start, end + 1), error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return client;
}

async function readStatus(client: SupabaseClient, at = now) {
  const status = await getCreditStatus(client, at);
  assert.ok(!("error" in status), JSON.stringify(status));
  return status;
}

test("legacy purchases retain their plan label without scheduled-plan metadata", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "topup", granted_credits: 2000, remaining_credits: 1234 }),
  ], { credits: 1234 }));
  assert.equal(status.planCode, "topup");
  assert.equal(status.credits, 1234);
  assert.equal(status.nextGrantAt, null);
  assert.equal(status.topupGrantedCredits, 2000);
  assert.equal(status.topupCredits, 1234);
  assert.equal(status.planEndsAt, null);
});

test("an active prepaid plan is not relabelled Top-up after an extra purchase", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "annual", remaining_credits: 2400, starts_at: "2026-09-08T00:00:00Z", expires_at: "2026-10-08T00:00:00Z" }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 1000, created_at: "2026-09-08T00:00:00Z", expires_at: "2027-09-08T00:00:00Z" }),
  ], { credits: 3400, scheduled_plan_code: "annual", next_grant_at: "2026-10-08T00:00:00Z", next_grant_credits: 2400, scheduled_ends_at: "2027-09-08T00:00:00Z" }));
  assert.equal(status.planCode, "annual");
  assert.equal(status.nextGrantCredits, 2400);
  assert.equal(status.nextGrantAt, "2026-10-08T00:00:00Z");
  assert.equal(status.scheduledEndsAt, "2027-09-08T00:00:00Z");
  assert.equal(status.planEndsAt, "2027-09-08T00:00:00Z");
  assert.equal(status.regularExpiresAt, "2026-10-08T00:00:00Z");
  assert.equal(status.regularGrantedCredits, 2400);
  assert.equal(status.topupCredits, 1000);
});

test("credit RPC failures are not presented as an empty balance", async () => {
  const client = { async rpc() { return { data: null, error: { code: "DB_ERROR" } }; } } as unknown as SupabaseClient;
  assert.deepEqual(await getCreditStatus(client), { error: "DB_ERROR" });
});

test("an exhausted free trial retains its allocation and end date", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "trial", granted_credits: 120, remaining_credits: 0 }),
  ], { credits: 0, next_expiry: null }));
  assert.equal(status.planCode, "trial");
  assert.equal(status.regularCredits, 0);
  assert.equal(status.regularGrantedCredits, 120);
  assert.equal(status.planEndsAt, "2026-10-01T00:00:00Z");
  assert.equal(status.regularExpiresAt, "2026-10-01T00:00:00Z");
  assert.equal(status.nextExpiry, null);
});

test("an expired trial keeps the free-plan end date without counting expired allocation", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "trial", granted_credits: 120, remaining_credits: 0, expires_at: now.toISOString() }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 600, created_at: now.toISOString() }),
  ], { credits: 600 }));
  assert.equal(status.planCode, "trial");
  assert.equal(status.planEndsAt, now.toISOString());
  assert.equal(status.regularGrantedCredits, 0);
  assert.equal(status.regularCredits, 0);
  assert.equal(status.regularExpiresAt, null);
  assert.equal(status.topupCredits, 600);
});

test("monthly rollover counts only the current installment and ignores revoked or refunded grants", async () => {
  const status = await readStatus(clientFor([
    grant({ starts_at: "2026-08-08T00:00:00Z", expires_at: now.toISOString(), remaining_credits: 2000 }),
    grant({ starts_at: now.toISOString(), expires_at: "2026-10-08T00:00:00Z", remaining_credits: 2300 }),
    grant({ starts_at: "2026-10-08T00:00:00Z", expires_at: "2026-11-08T00:00:00Z", remaining_credits: 2400 }),
    grant({ revoked_at: "2026-09-07T00:00:00Z" }),
    grant({ refunded_credits: 2400, remaining_credits: 0 }),
  ], { credits: 2300 }));
  assert.equal(status.regularCredits, 2300);
  assert.equal(status.regularGrantedCredits, 2400);
  assert.equal(status.regularExpiresAt, "2026-10-08T00:00:00Z");
});

test("multiple active top-ups include their spent allocation until expiry", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 0, expires_at: "2026-09-10T00:00:00Z" }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 500, expires_at: "2026-11-01T00:00:00Z" }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 800, expires_at: now.toISOString() }),
  ], { credits: 500 }));
  assert.equal(status.topupCredits, 500);
  assert.equal(status.topupGrantedCredits, 2000);
  assert.equal(status.topupExpiresAt, "2026-11-01T00:00:00Z");
  assert.equal(status.regularGrantedCredits, 0);
});

test("an exhausted top-up bucket retains its earliest allocation expiry", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 0, expires_at: "2026-09-10T00:00:00Z" }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 0, expires_at: "2026-11-01T00:00:00Z" }),
  ], { credits: 0 }));
  assert.equal(status.topupCredits, 0);
  assert.equal(status.topupGrantedCredits, 2000);
  assert.equal(status.topupExpiresAt, "2026-09-10T00:00:00Z");
});

test("legacy regular grants use their stored allocation and take priority over a newer top-up", async () => {
  const status = await readStatus(clientFor([
    grant({ plan_code: "term", granted_credits: 8000, remaining_credits: 0, expires_at: "2026-12-01T00:00:00Z" }),
    grant({ plan_code: "topup", granted_credits: 1000, remaining_credits: 700, created_at: now.toISOString() }),
  ], { credits: 700 }));
  assert.equal(status.planCode, "term");
  assert.equal(status.regularGrantedCredits, 8000);
  assert.equal(status.regularCredits, 0);
  assert.equal(status.planEndsAt, "2026-12-01T00:00:00Z");
});

test("refunds reduce the allocation denominator instead of appearing as usage", async () => {
  const status = await readStatus(clientFor([
    grant({ granted_credits: 2400, refunded_credits: 400, remaining_credits: 1200 }),
    grant({ plan_code: "topup", granted_credits: 1000, refunded_credits: 300, remaining_credits: 500 }),
  ], { credits: 1700 }));
  assert.equal(status.regularGrantedCredits, 2000);
  assert.equal(status.regularCredits, 1200);
  assert.equal(status.topupGrantedCredits, 700);
  assert.equal(status.topupCredits, 500);
});

test("grant-query failures are not presented as zero usage", async () => {
  const query = {
    select() { return query; }, lte() { return query; }, or() { return query; },
    is() { return query; }, order() { return query; },
    async range() { return { data: null, error: { code: "GRANT_QUERY_FAILED" } }; },
  };
  const client = {
    async rpc() { return { data: [{ credits: 1200, scheduled_plan_code: "annual" }], error: null }; },
    from() { return query; },
  } as unknown as SupabaseClient;
  assert.deepEqual(await getCreditStatus(client, now), { error: "GRANT_QUERY_FAILED" });
});

test("an absent status row is unavailable instead of an empty balance", async () => {
  const client = { async rpc() { return { data: [], error: null }; } } as unknown as SupabaseClient;
  assert.deepEqual(await getCreditStatus(client, now), { error: "CREDIT_STATUS_UNAVAILABLE" });
});

test("all active allocations are counted beyond the default database page size", async () => {
  const grants = Array.from({ length: 1001 }, (_, index) => grant({
    id: `topup-${index}`, plan_code: "topup", granted_credits: 1000, remaining_credits: 100,
  }));
  const status = await readStatus(clientFor(grants, { credits: 100100 }));
  assert.equal(status.topupCredits, 100100);
  assert.equal(status.topupGrantedCredits, 1001000);
});
