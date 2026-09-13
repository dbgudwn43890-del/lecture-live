import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL (WASM), with a minimal Supabase auth contract. This exercises
// the actual migration/RPCs, not a JS reimplementation. Production Supabase
// installation and a real OAuth/signup test are still separate release gates.
test("signup migration: new accounts only, confirmation, consent and atomic claim", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated;
      create schema auth;
      create table auth.users (
        id uuid primary key, raw_app_meta_data jsonb,
        email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
        confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored
      );
      create table auth.sessions(id uuid primary key, user_id uuid references auth.users(id) on delete cascade);
      create function auth.jwt() returns jsonb language sql stable as
      'select jsonb_build_object(''session_id'', current_setting(''request.jwt.claim.session_id'', true))';
      create function auth.uid() returns uuid language sql stable as
      'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
      grant usage on schema auth to authenticated, anon;
      -- Legacy accounts before installing the new migration.
      insert into auth.users(id, raw_app_meta_data, email_confirmed_at) values
        ('00000000-0000-0000-0000-000000000001', '{"provider":"google"}', now()),
        ('00000000-0000-0000-0000-000000000002', '{"provider":"email"}', null);
    `);
    await db.exec(await readFile(new URL("../../supabase/migrations/20260912000000_signup_analytics.sql", import.meta.url), "utf8"));

    async function count() {
      const result = await db.query<{ n: number }>("select count(*)::int n from public.signup_analytics_events");
      return result.rows[0].n;
    }
    const firstSession = (id: string) => `10000000${id.slice(8)}`;
    async function asUser(id: string, sql: string, session = firstSession(id)) {
      await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false); select set_config('request.jwt.claim.session_id', '${session}', false);`);
      try { return await db.query(sql); } finally { await db.exec("reset role"); }
    }
    async function create(id: string, confirmed = true, method = "google") {
      await db.query("insert into auth.users(id, raw_app_meta_data, email_confirmed_at) values ($1, $2::jsonb, $3)", [id, JSON.stringify({ provider: method }), confirmed ? new Date().toISOString() : null]);
      if (confirmed) await db.query("insert into auth.sessions(id, user_id) values ($1, $2)", [firstSession(id), id]);
    }
    const legacy = "00000000-0000-0000-0000-000000000001";
    const oldEmail = "00000000-0000-0000-0000-000000000002";
    const fresh = "00000000-0000-0000-0000-000000000003";
    const email = "00000000-0000-0000-0000-000000000004";
    const denied = "00000000-0000-0000-0000-000000000005";
    const expired = "00000000-0000-0000-0000-000000000006";

    assert.equal(await count(), 0, "no backfill");
    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [oldEmail]);
    assert.equal(await count(), 0, "legacy confirmation is not a new signup");
    await asUser(legacy, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(legacy, "select * from public.claim_signup_analytics()")).rows, []);

    await create(fresh);
    assert.equal(await count(), 1);
    assert.deepEqual((await asUser(fresh, "select * from public.claim_signup_analytics()")).rows, [], "callback must finalize first");
    await asUser(fresh, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(legacy, "select * from public.claim_signup_analytics()")).rows, [], "cannot claim another account's marker");
    assert.deepEqual((await asUser(fresh, "select * from public.claim_signup_analytics()")).rows, [{ method: "google" }]);
    assert.deepEqual((await asUser(fresh, "select * from public.claim_signup_analytics()")).rows, [], "second tab/retry returns no marker");
    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [fresh]);
    await asUser(fresh, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(fresh, "select * from public.claim_signup_analytics()")).rows, [], "repeat login cannot rearm");

    await create(email, false, "email");
    await asUser(email, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(email, "select * from public.claim_signup_analytics()")).rows, [], "unconfirmed accounts do not convert");
    await db.query("update auth.users set email_confirmed_at=now() where id=$1", [email]);
    await db.query("insert into auth.sessions(id, user_id) values ($1, $2)", [firstSession(email), email]);
    await asUser(email, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(email, "select * from public.claim_signup_analytics()")).rows, [{ method: "email" }]);

    await create(denied);
    await asUser(denied, "select public.finalize_signup_analytics(false)");
    await asUser(denied, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(denied, "select * from public.claim_signup_analytics()")).rows, [], "later opt-in must not count old signup");

    await create(expired);
    await db.query("update public.signup_analytics_events set expires_at=now()-interval '1 minute' where user_id=$1", [expired]);
    await asUser(expired, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(expired, "select * from public.claim_signup_analytics()")).rows, [], "abandoned old auth flow cannot be attributed to later login");

    // A failed opt-out finalization leaves pending, but another login must
    // never recover that marker using its later consent choice.
    const stranded = "00000000-0000-0000-0000-000000000007";
    const laterSession = "20000000-0000-0000-0000-000000000007";
    await create(stranded);
    await db.query("insert into auth.sessions(id, user_id) values ($1, $2)", [laterSession, stranded]);
    await asUser(stranded, "select public.finalize_signup_analytics(true)", laterSession);
    assert.deepEqual((await asUser(stranded, "select * from public.claim_signup_analytics()", laterSession)).rows, [], "later login cannot finalize a stranded marker");
    await asUser(stranded, "select public.finalize_signup_analytics(true)");
    assert.deepEqual((await asUser(stranded, "select * from public.claim_signup_analytics()", laterSession)).rows, [], "later login cannot claim even a ready marker");
    assert.deepEqual((await asUser(stranded, "select * from public.claim_signup_analytics()")).rows, [{ method: "google" }]);

    await assert.rejects(asUser(fresh, "select * from public.signup_analytics_events"), /permission denied/);
    await assert.rejects(asUser(fresh, "update public.signup_analytics_events set state='ready'"), /permission denied/);
    await db.exec("set role anon");
    await assert.rejects(db.query("select * from public.claim_signup_analytics()"), /permission denied/);
    await db.exec("reset role");
    await db.query("delete from auth.users where id=$1", [fresh]);
    assert.equal((await db.query("select * from public.signup_analytics_events where user_id=$1", [fresh])).rows.length, 0, "account erasure cascades");
  } finally {
    await db.close();
  }
});
