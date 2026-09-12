import { NextResponse } from 'next/server';
import { createAdminClient } from '../../../lib/supabase/admin';
import { isUuid } from '../../../lib/billing';
import { relayTicketHash, validRelaySecret } from '../../../lib/stt-relay';
export const runtime = 'nodejs';
export const maxDuration = 15;

export async function POST(request: Request) {
  const headers = { 'Cache-Control':'no-store' };
  if (!validRelaySecret(request.headers.get('authorization'),process.env.STT_RELAY_SECRET)) return NextResponse.json({error:'Unauthorized'},{status:401,headers});
  const raw = await request.text();
  if (raw.length>2048) return NextResponse.json({error:'Invalid request'},{status:400,headers});
  let body: {action?:unknown;ticket?:unknown;connectionId?:unknown;processedBytes?:unknown;extend?:unknown};
  try { body=JSON.parse(raw); } catch { return NextResponse.json({error:'Invalid request'},{status:400,headers}); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isUuid(body.connectionId)) return NextResponse.json({error:'Invalid connection'},{status:400,headers});
  const admin=createAdminClient();
  if (!admin) return NextResponse.json({error:'Unavailable'},{status:503,headers});
  if (body.action==='open') {
    if (typeof body.ticket!=='string'||!/^[\w-]{43}$/.test(body.ticket)) return NextResponse.json({error:'Invalid ticket'},{status:400,headers});
    const {data,error}=await admin.rpc('open_stt_relay_service',{p_token_hash:relayTicketHash(body.ticket),p_connection_id:body.connectionId});
    if (error) return NextResponse.json({error:'Unavailable'},{status:503,headers});
    if (!data || data.error) return NextResponse.json({error:data?.error??'Unauthorized'},{status:data?.error==='NO_CREDITS'?402:409,headers});
    const provider=data.configuration?.provider;
    const providerKey=provider==='soniox'?process.env.SONIOX_API_KEY:provider==='deepgram'?process.env.DEEPGRAM_API_KEY:undefined;
    if (!providerKey) {
      await admin.rpc('advance_stt_relay_service', { p_connection_id: body.connectionId, p_processed_bytes: data.baseBytes, p_extend: false, p_close: true });
      return NextResponse.json({error:'Provider unavailable'},{status:503,headers});
    }
    // Only the authenticated server relay receives this value. It is never a browser response.
    return NextResponse.json({...data,providerKey},{headers});
  }
  if (!['progress','close'].includes(String(body.action)) || !Number.isSafeInteger(body.processedBytes)||Number(body.processedBytes)<0||Number(body.processedBytes)>345600000) return NextResponse.json({error:'Invalid usage'},{status:400,headers});
  const {data,error}=await admin.rpc('advance_stt_relay_service',{p_connection_id:body.connectionId,p_processed_bytes:body.processedBytes,p_extend:body.extend===true,p_close:body.action==='close'});
  if (error) return NextResponse.json({error:'Unavailable'},{status:503,headers});
  return NextResponse.json(data??{error:'Unavailable'},{status:!data?503:data.error?409:200,headers});
}
