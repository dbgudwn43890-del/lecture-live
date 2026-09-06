// A disposable Chrome profile checks the public plans in both languages.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const profile = mkdtempSync(join(tmpdir(), "lecue-billing-layout-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${profile}`, "--remote-debugging-port=9224", "about:blank"], { stdio: "ignore" });
let ws;
try {
  let pages;
  for (let i=0;i<50;i++) { try { pages = await (await fetch("http://127.0.0.1:9224/json")).json(); break; } catch { await new Promise(r=>setTimeout(r,100)); } }
  ws = new WebSocket(pages.find(p=>p.type==="page").webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ ws.onopen=resolve; ws.onerror=reject; });
  let id=0; const pending=new Map();
  ws.onmessage = event=>{const message=JSON.parse(event.data); if(pending.has(message.id)){ pending.get(message.id)(message); pending.delete(message.id); }};
  const send=(method,params={})=>new Promise(resolve=>{const next=++id;pending.set(next,resolve);ws.send(JSON.stringify({id:next,method,params}));});
  const evaluate=async expression=>(await send("Runtime.evaluate",{expression,returnByValue:true})).result?.result?.value;
  await send("Page.enable");
  for(const locale of ["ko","en"]) for(const width of [390,768,1440]) {
    await send("Emulation.setDeviceMetricsOverride",{width,height:900,deviceScaleFactor:1,mobile:width===390});
    await send("Page.navigate",{url:`http://localhost:3000/billing?lang=${locale}`});
    for(let i=0;i<100;i++){if(await evaluate(`document.documentElement.lang==='${locale}' && document.querySelector('h1') && document.body.innerText.includes('3,600')`))break;await new Promise(r=>setTimeout(r,100));}
    const result=await evaluate(`({lang:document.documentElement.lang,width:innerWidth,scroll:document.documentElement.scrollWidth,heading:document.querySelector('h1')?.innerText,trial:document.body.innerText.includes('300 credits'),korean:document.querySelector('main').innerText.match(/[^\\n]*[가-힣][^\\n]*/g)})`);
    if(result.lang!==locale || result.width!==width || result.scroll>width || !result.trial || locale==='en'&&result.korean) throw Error(JSON.stringify(result));
    console.log(locale,width,"PASS");
    if(width===390){const shot=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:true});writeFileSync(`/tmp/lecue-billing-${locale}-mobile.png`,Buffer.from(shot.result.data,"base64"));}
  }
} finally { ws?.close(); chrome.kill("SIGTERM"); }
