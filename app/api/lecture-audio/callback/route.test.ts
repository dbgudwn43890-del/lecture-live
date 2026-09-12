import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { callbackToken } from "../../../lib/lecture-audio.ts";

process.env.LECTURE_AUDIO_CALLBACK_SECRET = "isolated-test-key";
delete process.env.OPENAI_API_KEY;
const uploadId = "11111111-1111-4111-8111-111111111111";
const sessionId = "22222222-2222-4222-8222-222222222222";
const userId = "33333333-3333-4333-8333-333333333333";
let reads = 0;
let creditError = false;
let status = "processing";
let claimed = false;
let settlements = 0;
let deletes = 0;
let saveError = false;
let saved: Array<{end_ms:number}> = [];

const admin = {
  from(table: string) {
    reads++;
    let operation = "select";
    let update: Record<string, unknown> = {};
    const settle = async () => {
      if (operation === "delete") deletes++;
      if (operation === "update" && table === "uploads") {
        if (update.status) status = String(update.status);
        if (update.callback_claimed_at === null) claimed = false;
      }
      if (table === "transcript_segments" && operation === "upsert" && saveError) return { data: null, error: { code: "TEST_SAVE_FAILURE" } };
      return { data: operation === "select" ? table === "uploads"
        ? { id: uploadId,session_id:sessionId,user_id:userId,status,duration_ms:180000,object_key:`${userId}/audio.flac`,provider_request_id:"provider-job" }
        : {id:sessionId,user_id:userId,classroom_id:null,status:"recording"} : null,error:null };
    };
    const query = {
      select(){return query;},eq(){return query;},
      update(value: Record<string,unknown>){operation="update";update=value;return query;},
      delete(){operation="delete";return query;},
      upsert(rows: Array<{end_ms:number}>){operation="upsert";saved=rows;return query;},
      maybeSingle:settle,
      then(resolve: (value: unknown)=>unknown,reject?: (reason:unknown)=>unknown){return settle().then(resolve,reject);},
    };
    return query;
  },
  async rpc(name:string) {
    if(name==="claim_audio_callback_service") {const allowed=!claimed;claimed=true;return {data:allowed,error:null};}
    if(name==="settle_audio_credits_service") {settlements++;return creditError ? {data:null,error:{code:"CREDIT_UNAVAILABLE"}} : {data:3,error:null};}
    throw new Error(`Unexpected RPC ${name}`);
  },
};
registerHooks({resolve(specifier,context,nextResolve){try{return nextResolve(specifier,context);}catch(error){for(const extension of[".ts",".js"]){try{return nextResolve(specifier+extension,context);}catch{}}throw error;}}});
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href,{namedExports:{createAdminClient:()=>admin}});
mock.module(pathToFileURL("app/lib/storage-cleanup.ts").href,{namedExports:{enqueueStorageDeletion:async()=>{},drainStorageDeletions:async()=>({})}});
const {POST}=await import("./route.ts");
const realFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error("Tests must not contact providers");};
test.after(()=>{globalThis.fetch=realFetch;});
test.beforeEach(()=>{reads=0;creditError=false;status="processing";claimed=false;settlements=0;deletes=0;saveError=false;saved=[];});
function callback(empty=false){return new Request(`https://lecue.test/api/lecture-audio/callback?uploadId=${uploadId}&token=${callbackToken(uploadId)}`,{method:"POST",body:JSON.stringify({metadata:{request_id:"provider-job",duration:1},results:{utterances:empty?[]:[{start:0,end:999,transcript:"A useful explanation."}]}})});}

test("settles verified audio duration, caps transcript, and ignores a duplicate callback",async()=>{
  assert.equal((await POST(callback())).status,200);
  assert.equal(saved[0].end_ms,180000);
  assert.equal(settlements,1);
  assert.equal((await POST(callback())).status,200);
  assert.equal(settlements,1);
});
test("concurrent callbacks claim one processing lease",async()=>{
  const results=await Promise.all([POST(callback()),POST(callback())]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,503]);
  assert.equal(settlements,1);
});
test("silence still settles the provider processing reservation",async()=>{
  assert.equal((await POST(callback(true))).status,200);
  assert.equal(settlements,1);
  assert.equal(status,"failed");
});
test("a transient transcript save failure releases the callback lease for retry",async()=>{
  saveError=true;
  assert.equal((await POST(callback())).status,500);
  assert.equal(claimed,false);
  assert.equal(status,"processing");
  assert.equal(deletes,0);
});


test("a forged token is rejected before reading a row", async () => {
  const request = new Request(`https://lecue.test/api/lecture-audio/callback?uploadId=${uploadId}&token=${"0".repeat(64)}`, { method: "POST", body: "{}" });
  assert.equal((await POST(request)).status, 404);
  assert.equal(reads, 0);
});
test("a token of the wrong length is rejected without throwing", async () => {
  const request = new Request(`https://lecue.test/api/lecture-audio/callback?uploadId=${uploadId}&token=short`, { method: "POST", body: "{}" });
  assert.equal((await POST(request)).status, 404);
  assert.equal(reads, 0);
});
test("unsettled processing does not deliver a transcript or erase the upload", async () => {
  creditError = true;
  assert.equal((await POST(callback())).status, 500);
  assert.deepEqual(saved, []);
  assert.equal(status, "processing");
  assert.equal(deletes, 0);
  assert.equal(claimed, false);
});
