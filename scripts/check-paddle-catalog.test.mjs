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
  else if(path==='/prices') {
   const price=JSON.parse(init.body);
   assert.equal(price.custom_data.entitlement_version,'monthly_v1');
   assert.equal(price.custom_data.installment_count,({monthly:1,semester:4,halfyear:6,annual:12,topup:1})[price.custom_data.plan]);
   assert.ok(price.custom_data.lecue_key.startsWith('monthly_v1:'));
   assert.equal(price.custom_data.credits,price.custom_data.monthly_credits ? price.custom_data.monthly_credits*price.custom_data.installment_count:1000);
   const plan=price.custom_data.plan;
   assert.deepEqual(price.unit_price,{amount:({monthly:'999',semester:'3599',halfyear:'5199',annual:'9999',topup:'599'})[plan],currency_code:'USD'});
   assert.deepEqual(price.unit_price_overrides,[{country_codes:['KR'],unit_price:{amount:({monthly:'7900',semester:'27900',halfyear:'39900',annual:'74900',topup:'5900'})[plan],currency_code:'KRW'}}]);
   data={...price,id:'pri_mock',status:'active'};
  }
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

// A temporary catalog key must not require product-write or webhook access.
for (const reuse of [false, true]) {
 const preload = `
 import assert from 'node:assert/strict';
 import { PLANS } from ${JSON.stringify(new URL('../app/lib/plans.ts', import.meta.url).href)};
 let created=0;
 const prices=Object.entries(PLANS).map(([plan,p])=>({
   id:'pri_'+plan,status:'active',unit_price:{amount:String(Math.round(p.usd*100)),currency_code:'USD'},
   unit_price_overrides:[{country_codes:['KR'],unit_price:{amount:String(p.krw),currency_code:'KRW'}}],
   tax_mode:'internal',quantity:{minimum:1,maximum:1},trial_period:null,billing_cycle:p.recurring?{interval:'month',frequency:1}:null,
   custom_data:{lecue_key:['monthly_v1',plan,Math.round(p.usd*100),p.krw,p.credits,p.installmentCount,p.recurring?'month':'once'].join(':')}
 }));
 globalThis.fetch=async(url,init={})=>{
   const path=new URL(url).pathname;
   let data;
   if(path==='/products/pro_existing' && !init.method) data={id:'pro_existing',name:'Lecue',status:'active'};
   else if(path==='/prices' && !init.method) data=${reuse ? 'prices' : '[]'};
   else if(path==='/prices' && init.method==='POST') { created++;data={...JSON.parse(init.body),id:'pri_created',status:'active'}; }
   else throw Error('unexpected access '+path);
   return {ok:true,json:async()=>({data})};
 };
 process.on('exit',()=>assert.equal(created,${reuse ? 0 : 5}));
 `;
 const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(preload)}`,decodeURIComponent(new URL(script).pathname),'--env','live','--product','pro_existing','--skip-webhook'],{env:{...process.env,PADDLE_CATALOG_API_KEY:'pdl_live_fake'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/PADDLE_SEMESTER_V3_PRICE_ID=pri_/);
 assert.doesNotMatch(result.stdout,/PADDLE_API_KEY|PADDLE_WEBHOOK_SECRET/);
 console.log('PASS limited-permission catalog '+(reuse?'reuses current version':'creates five versioned prices')+' (no network)');
}
