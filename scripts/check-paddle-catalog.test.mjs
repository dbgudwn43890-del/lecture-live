import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const script = new URL('./scripts/paddle-catalog.mjs', `file://${process.cwd()}/`).href;
for (const existing of [false, true]) {
 const preload = `
 import assert from 'node:assert/strict';
 let writes=0;
 globalThis.fetch = async (url, init={}) => {
  const path = new URL(url).pathname;
  let data;
  if(path==='/products') data=[{id:'pro_mock',name:'Lecue'}];
  else if(path==='/prices' && !init.method) data=[];
  else if(path==='/prices') data={id:'pri_mock'};
  else if(path==='/notification-settings' && !init.method) data=${existing ? '[{id:"ntf_mock",active:true,destination:"https://www.lecue.app/api/billing/webhook",subscribed_events:[{name:"transaction.completed"},{name:"transaction.payment_failed"}]}]' : '[]'};
  else if(path.startsWith('/notification-settings')) {
   const body=JSON.parse(init.body);
   for(const name of ['transaction.completed','subscription.updated','adjustment.created','adjustment.updated']) assert.ok(body.subscribed_events.includes(name));
   ${existing ? "assert.equal(init.method,'PATCH'); assert.ok(body.subscribed_events.includes('transaction.payment_failed'));" : "assert.equal(init.method,'POST');"}
   writes++; data={id:'ntf_mock',endpoint_secret_key:'fake',subscribed_events:body.subscribed_events};
  } else throw Error('unexpected '+path);
  return {ok:true,json:async()=>({data})};
 };
 process.on('exit',()=>assert.equal(writes,1));
 `;
 const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(preload)}`,decodeURIComponent(new URL(script).pathname),'--env','sandbox'],{env:{...process.env,PADDLE_CATALOG_API_KEY:'pdl_sdbx_fake'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 console.log('PASS Paddle catalog '+(existing?'updates and preserves events':'creates required events')+' (no network)');
}
