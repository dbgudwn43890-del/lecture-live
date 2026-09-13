import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import test,{mock} from 'node:test';
import {transformSync} from 'next/dist/build/swc/index.js';
registerHooks({
 resolve(s,c,next){try{return next(s,c);}catch(e){for(const ext of ['.ts','.tsx','.js']){try{return next(s+ext,c);}catch{}}throw e;}},
 load(url,c,next){if(new URL(url).pathname.endsWith('.css'))return {format:'module',shortCircuit:true,source:''};if(new URL(url).pathname.endsWith('.tsx'))return {format:'module',shortCircuit:true,source:transformSync(readFileSync(new URL(url),'utf8'),{filename:new URL(url).pathname,module:{type:'es6'},jsc:{parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}},target:'es2022'}}).code};return next(url,c);},
});
let identity:{id:string}|null=null;
mock.module('../lib/admin-access.ts',{namedExports:{getAdminIdentity:async()=>identity}});
mock.module('next/navigation',{namedExports:{notFound:()=>{throw new Error('NOT_FOUND');}}});
mock.module('./dashboard.tsx',{defaultExport:()=>null});
const {default:Page}=await import('./page.tsx');
test('server rejects a non-admin before returning dashboard markup',async()=>{
 await assert.rejects(Page(),/NOT_FOUND/);
 identity={id:'operator'};assert.ok(await Page());
});
