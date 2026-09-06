import assert from "node:assert/strict";
import test from "node:test";
import { withGenerationLease } from "./generation-lease.ts";

test("busy and unavailable leases never start paid generation", async () => {
  for (const [data, error, status] of [[false, null, 202], [null, {code: "unavailable"}, 503]] as const) {
    let generated = 0;
    const db = { rpc: async () => ({ data, error }) };
    const result = await withGenerationLease(db as never, "session", "note", false, async () => { generated++; return new Response(); });
    assert.equal(result.status, status);
    assert.equal(generated, 0);
  }
});

test("success and failure both release only their own token", async () => {
  for (const fail of [false, true]) {
    const calls: {name: string; token: unknown}[] = [];
    const db = { rpc: async (name: string, args: Record<string, unknown>) => { calls.push({name, token: args.p_token}); return {data: true, error: null}; } };
    const work = withGenerationLease(db as never, "session", "summary", true, async () => {
      if (fail) throw new Error("provider failure");
      return new Response("saved");
    });
    if (fail) await assert.rejects(work, /provider failure/);
    else assert.equal(await (await work).text(), "saved");
    assert.deepEqual(calls.map(call => call.name), ["claim_generation_lease", "release_generation_lease"]);
    assert.equal(calls[0].token, calls[1].token);
  }
});
