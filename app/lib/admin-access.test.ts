import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { registerHooks } from "node:module";
registerHooks({ resolve(s,c,next) { if(s==='server-only') return { url:'data:text/javascript,export{}', shortCircuit:true }; try{return next(s,c);}catch(e){for(const ext of ['.ts','.js']){try{return next(s+ext,c);}catch{}}throw e;} } });
let user: Record<string, unknown> | null = null;
let authError: unknown = null;
mock.module('./supabase/server.ts',{namedExports:{createClient:async()=>({auth:{getUser:async()=>({data:{user},error:authError})}})}});
const {getAdminIdentity}=await import('./admin-access.ts');
const originalEmails=process.env.ADMIN_EMAILS, originalIds=process.env.ADMIN_USER_IDS;
test.after(()=>{ if(originalEmails===undefined)delete process.env.ADMIN_EMAILS;else process.env.ADMIN_EMAILS=originalEmails; if(originalIds===undefined)delete process.env.ADMIN_USER_IDS;else process.env.ADMIN_USER_IDS=originalIds; });
test('operator access requires verified server identity, fails closed, and ID configuration outranks email',async()=>{
 process.env.ADMIN_EMAILS='owner@example.test';delete process.env.ADMIN_USER_IDS;
 for(const value of [null,{id:'owner',email:'owner@example.test'}, {id:'owner',email:'owner@example.test',email_confirmed_at:'2026-09-13',is_anonymous:true}, {id:'other',email:'other@example.test',email_confirmed_at:'2026-09-13',user_metadata:{role:'admin'}}]) { user=value;assert.equal(await getAdminIdentity(),null); }
 user={id:'owner',email:'OWNER@example.test',email_confirmed_at:'2026-09-13'};
 assert.deepEqual(await getAdminIdentity(),{id:'owner'});
 process.env.ADMIN_USER_IDS='different';assert.equal(await getAdminIdentity(),null);
 process.env.ADMIN_USER_IDS='owner';assert.deepEqual(await getAdminIdentity(),{id:'owner'});
 authError={message:'revoked'};assert.equal(await getAdminIdentity(),null);authError=null;
 delete process.env.ADMIN_USER_IDS;delete process.env.ADMIN_EMAILS;assert.equal(await getAdminIdentity(),null);
});
