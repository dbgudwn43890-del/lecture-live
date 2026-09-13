import { NextRequest } from "next/server";
import { ANALYTICS_CONSENT, ANALYTICS_EVENTS, CAMPAIGN, analyticsEnabled } from "../../../lib/analytics-policy";

// A dedicated empty document keeps automatic Google events away from the app's
// URL, DOM, titles, forms and lecture content. It is destroyed on withdrawal.
export function GET(request: NextRequest) {
  const id = process.env.NEXT_PUBLIC_GA4_MEASUREMENT_ID;
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
  if (!analyticsEnabled(id) || request.cookies.get(ANALYTICS_CONSENT)?.value !== "granted") {
    return new Response(null, { status: 204, headers });
  }
  const script = `
const consentKey = ${JSON.stringify(ANALYTICS_CONSENT)};
const id = ${JSON.stringify(id)};
const CAMPAIGN = ${JSON.stringify(CAMPAIGN)};
function safeLocation(raw) {
  const url=new URL(raw,'https://www.lecue.app');
  const routes=['/','/en','/ko','/login','/en/login','/classroom','/en/classroom','/billing','/en/billing','/privacy','/en/privacy','/terms','/en/terms'];
  const safe=new URL(routes.includes(url.pathname)?url.pathname:'/other','https://www.lecue.app');
  for(const [key,value] of Object.entries(CAMPAIGN)){if(url.searchParams.get(key)===value)safe.searchParams.set(key,value);}
  for(const key of ['gclid','gbraid','wbraid']){const value=url.searchParams.get(key);if(value && /^[A-Za-z0-9_-]{10,256}$/.test(value))safe.searchParams.set(key,value);}
  return safe.href;
}
function granted() { try { return document.cookie.split('; ').includes(consentKey+'=granted') && localStorage.getItem(consentKey)==='granted'; } catch { return false; } }
if (granted()) {
  window.dataLayer = [];
  function gtag(){dataLayer.push(arguments);}
  gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
  gtag('set','allow_google_signals',false);
  gtag('set','allow_ad_personalization_signals',false);
  gtag('set','ads_data_redaction',true);
  gtag('set','url_passthrough',false);
  gtag('consent','update',{analytics_storage:'granted',ad_storage:'granted',ad_user_data:'granted',ad_personalization:'denied'});
  gtag('js',new Date());
  const base={send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,page_location:'https://www.lecue.app/',page_referrer:'',page_title:'Lecue',ignore_referrer:true,cookie_expires:7776000,cookie_update:false};
  addEventListener('message',event=>{
    if(event.source!==parent || event.origin!==location.origin || !granted()) return;
    const data=event.data;
    if(!data || data.type!=='lecue-measure' || !${JSON.stringify(ANALYTICS_EVENTS)}.includes(data.event) || typeof data.location!=='string')return;
    const page_location=safeLocation(data.location);
    gtag('config',id,{...base,page_location});
    gtag('event',data.event,{send_to:id,page_location,page_referrer:'',page_title:'Lecue',...(data.event==='sign_up'?{method:'verified_account'}:{})});
  });
  function stopIfWithdrawn(){if(!granted()){window['ga-disable-'+id]=true;location.replace('about:blank');}}
  addEventListener('storage',stopIfWithdrawn);
  if(typeof BroadcastChannel!=='undefined'){const channel=new BroadcastChannel(consentKey);channel.onmessage=stopIfWithdrawn;}
  const tag=document.createElement('script');tag.async=true;tag.referrerPolicy='no-referrer';
  tag.src='https://www.googletagmanager.com/gtag/js?id='+id;
  tag.onload=()=>{if(granted())parent.postMessage({type:'lecue-measure-ready'},location.origin);};
  document.head.append(tag);
}
`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lecue</title><meta name="referrer" content="no-referrer"></head><body><script>${script}</script></body></html>`, {
    headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
  });
}
