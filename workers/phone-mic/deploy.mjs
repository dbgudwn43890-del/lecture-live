// Deploy only the isolated phone bridge; never changes STT, billing, or database state.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const parse = file => Object.fromEntries(readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i=l.indexOf('='); return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]; }));
const local = parse(resolve(root,'.env.local'));
const setup = parse(resolve(root,'.env.security-setup.local'));
const account = setup.CLOUDFLARE_ACCOUNT_ID || local.CLOUDFLARE_ACCOUNT_ID;
const token = setup.CLOUDFLARE_API_TOKEN;
if (!/^[a-f0-9]{32}$/.test(account ?? '') || !token) throw new Error('Workers deployment credential missing');
async function cf(path, method='GET', body, allow404=false) {
 const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {method,headers:{Authorization:`Bearer ${token}`,...(body===undefined||body instanceof FormData?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:body instanceof FormData?body:JSON.stringify(body)}),signal:AbortSignal.timeout(50_000),redirect:'error'});
 if(allow404&&response.status===404)return null;
 const data=await response.json();
 if(!response.ok||!data.success)throw new Error(`Cloudflare ${method} ${response.status}; codes ${(data.errors??[]).map(e=>e.code).join(',')}`);
 return data.result;
}
const name='lecue-phone-mic';
const secretFile=resolve(root,'.env.phone-mic.local');
if(!existsSync(secretFile))writeFileSync(secretFile,`PHONE_MIC_SECRET=${randomBytes(32).toString('hex')}\n`,{mode:0o600});
const secret=parse(secretFile).PHONE_MIC_SECRET;
if(!/^[a-f0-9]{64}$/.test(secret??''))throw new Error('Invalid bridge secret');
const subdomain=(await cf(`accounts/${account}/workers/subdomain`)).subdomain;
if(!/^[a-z0-9-]+$/.test(subdomain??''))throw new Error('Missing workers.dev subdomain');
const url=`https://${name}.${subdomain}.workers.dev`;
const origins=['https://www.lecue.app','https://lecue.app','http://localhost:3000','http://127.0.0.1:3000'];
for(const value of process.argv.filter(v=>v.startsWith('--allow-origin=')).map(v=>v.slice(15))){
 if(!/^https:\/\/lecue-[a-z0-9-]+\.vercel\.app$/.test(value))throw new Error('Invalid release origin');
 origins.push(value);
}
const current=await cf(`accounts/${account}/workers/scripts/${name}/settings`,'GET',undefined,true);
const existingClass=current?.bindings?.some(binding=>binding.name==='PHONE_MIC_ROOMS'&&binding.type==='durable_object_namespace'&&binding.class_name==='PhoneMicRoom');
if(current&&!existingClass)throw new Error('Unexpected bridge binding configuration');
const source=readFileSync(resolve(import.meta.dirname,'index.mjs'));
const form=new FormData();
form.append('metadata',new Blob([JSON.stringify({main_module:'index.mjs',compatibility_date:'2026-08-06',bindings:[{name:'PHONE_MIC_ROOMS',type:'durable_object_namespace',class_name:'PhoneMicRoom'},{name:'PHONE_MIC_SECRET',type:'secret_text',text:secret},{name:'ALLOWED_ORIGINS',type:'plain_text',text:origins.join(',')}],...(!existingClass?{migrations:{new_tag:'phone-v1',new_sqlite_classes:['PhoneMicRoom']}}:{}),observability:{enabled:false},limits:{cpu_ms:30_000}})],{type:'application/json'}));
form.append('index.mjs',new Blob([source],{type:'application/javascript+module'}),'index.mjs');
const result=await cf(`accounts/${account}/workers/scripts/${name}`,'PUT',form);
await cf(`accounts/${account}/workers/scripts/${name}/subdomain`,'POST',{enabled:true,previews_enabled:false});
const values={PHONE_MIC_SECRET:secret,PHONE_MIC_RELAY_URL:url};
if(process.argv.includes('--configure')){
 const project=JSON.parse(readFileSync(resolve(root,'.vercel/project.json'),'utf8')).projectId;
 for(const [key,value] of Object.entries(values)){
  try{execFileSync('vercel',['api',`/v10/projects/${project}/env?upsert=true`,'--method','POST','--input','-','--silent'],{input:JSON.stringify({key,value,type:key==='PHONE_MIC_SECRET'?'encrypted':'plain',target:['production']}),stdio:['pipe','pipe','pipe'],timeout:50_000});}
  catch{throw new Error(`Could not configure ${key}`);}
 }
 let content=readFileSync(resolve(root,'.env.local'),'utf8');
 for(const [key,value]of Object.entries(values))content=content.replace(new RegExp(`^${key}=.*(?:\\n|$)`,'mg'),'')+`\n${key}=${value}\n`;
 writeFileSync(resolve(root,'.env.local'),content,{mode:0o600});
}
writeFileSync(secretFile,Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30_000)});
if(!response.ok)throw new Error('Cannot verify deployed source');
const deployed=await response.formData();
const module=deployed.get('index.mjs');
if(!module)throw new Error(`Missing deployed module; parts: ${Array.from(deployed.keys()).join(',')}`);
const hash=value=>createHash('sha256').update(value).digest('hex');
if(hash(source)!==hash(typeof module==='string'?module:Buffer.from(await module.arrayBuffer())))throw new Error('Worker source mismatch');
console.log(JSON.stringify({worker:name,url,sourceSha256:hash(source),sourceVerified:true,migrationTag:result.migration_tag??'phone-v1',origins,configured:process.argv.includes('--configure')}));
