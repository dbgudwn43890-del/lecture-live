import assert from 'node:assert/strict';
import test,{mock} from 'node:test';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,next){try{return next(s,c);}catch(e){for(const ext of ['.ts','.js']){try{return next(s+ext,c);}catch{}}throw e;}}});
let identity:{id:string}|null=null;let allowed=true;let calls: {name:string; args:unknown}[]=[];let rpcError:unknown=null;
mock.module('../../lib/admin-access.ts',{namedExports:{getAdminIdentity:async()=>identity}});
mock.module('../../lib/rate-limit.ts',{namedExports:{checkSharedRateLimit:async()=>({allowed})}});
mock.module('../../lib/supabase/admin.ts',{namedExports:{createAdminClient:()=>({rpc:async(name:string,args:unknown)=>{calls.push({name,args});return {data:{users:[],replayed:true},error:rpcError};}})}});
const {GET,POST}=await import('./route.ts');
const actor='11111111-1111-4111-8111-111111111111', user='22222222-2222-4222-8222-222222222222', key='33333333-3333-4333-8333-333333333333';
const body={userId:user,key,credits:600,days:60,reason:'support compensation'};
const request=(value:unknown=body,origin='https://www.lecue.app')=>new Request('https://www.lecue.app/api/admin',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
test.beforeEach(()=>{identity=null;allowed=true;calls=[];rpcError=null;});
test('anonymous and ordinary users cannot read or grant, including direct API requests',async()=>{
 assert.equal((await GET(new Request('https://www.lecue.app/api/admin'))).status,403);
 assert.equal((await POST(request())).status,403);assert.equal(calls.length,0);
});
test('cross-origin and malformed grant requests cannot reach the mutation',async()=>{
 identity={id:actor};assert.equal((await POST(request(body,'https://evil.example'))).status,403);
 for(const value of [{...body,credits:'600'},{...body,credits:100001},{...body,days:0},{...body,reason:''},null])assert.equal((await POST(request(value))).status,400);
 assert.equal((await POST(request({...body,reason:'x'.repeat(5000)}))).status,413);assert.equal(calls.length,0);
});
test('grants use server actor and the supplied stable idempotency key; all replies forbid caching',async()=>{
 identity={id:actor};const response=await POST(request({...body,actorId:user}));
 assert.equal(response.status,200);assert.match(response.headers.get('cache-control')!,/no-store/);
 assert.deepEqual(calls,[{name:'admin_grant_credits_service',args:{p_actor:actor,p_user:user,p_key:key,p_credits:600,p_days:60,p_reason:body.reason}}]);
});
test('failed telemetry is unavailable, never a zero-filled success; query and rate limits are enforced',async()=>{
 identity={id:actor};assert.equal((await GET(new Request('https://www.lecue.app/api/admin?page=-1'))).status,400);
 allowed=false;assert.equal((await GET(new Request('https://www.lecue.app/api/admin'))).status,429);allowed=true;
 rpcError={message:'private database error'};const response=await GET(new Request('https://www.lecue.app/api/admin'));
 assert.equal(response.status,502);assert.ok(!(await response.text()).includes('private database error'));
});
