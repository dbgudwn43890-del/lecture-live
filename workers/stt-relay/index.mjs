// Server-owned PCM transport. Provider credentials never cross the browser boundary.
const BYTES_PER_SECOND = 32000;
const MAX_FRAME = 64000;
const CONTROL_TIMEOUT_MS = 8000;
// An extension can wait behind an eight-second heartbeat, then take another
// eight seconds. Keep normal PCM for both requests plus two seconds of jitter.
const MAX_QUEUE = BYTES_PER_SECOND * (2 * CONTROL_TIMEOUT_MS + 2000) / 1000;
const MAX_SESSION_BYTES = 345600000;

export function validGrant(grant) {
  return Number.isSafeInteger(grant?.baseBytes) && grant.baseBytes >= 0 &&
    Number.isSafeInteger(grant?.authorizedBytes) && grant.authorizedBytes >= grant.baseBytes &&
    grant.authorizedBytes <= MAX_SESSION_BYTES &&
    Number.isFinite(grant?.leaseMs) && grant.leaseMs > 0 && grant.leaseMs <= 20000;
}
const ALLOWED_ORIGINS = new Set(['https://www.lecue.app', 'https://lecue.app', 'http://localhost:3000']);

export function upstreamRequest(configuration, key) {
  const url = new URL(configuration.listenUrl);
  const deepgram = configuration.provider === 'deepgram';
  const soniox = configuration.provider === 'soniox';
  if (url.protocol !== 'wss:' || url.username || url.password || url.port || url.hash ||
      !(deepgram && url.hostname === 'api.deepgram.com' && url.pathname === '/v1/listen' ||
        soniox && url.hostname === 'stt-rt.soniox.com' && url.pathname === '/transcribe-websocket')) throw new Error('Invalid upstream');
  if (deepgram && (url.searchParams.get('encoding') !== 'linear16' || url.searchParams.get('sample_rate') !== '16000' || url.searchParams.get('channels') !== '1')) throw new Error('Invalid encoding');
  url.protocol = 'https:';
  return new Request(url, { headers: { Upgrade: 'websocket', ...(deepgram ? { Authorization: `Token ${key}` } : {}) } });
}

export function frameBytes(data) {
  return data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : -1;
}

export function validFrame(size, sent, elapsedMs) {
  return size > 0 && size <= MAX_FRAME && size % 2 === 0 && sent + size <= Math.max(0, elapsedMs) * BYTES_PER_SECOND / 1000 + MAX_FRAME;
}

export async function control(env, body, fetcher = fetch) {
  if (env.LECUE_ORIGIN !== 'https://www.lecue.app' || !env.STT_RELAY_SECRET || env.STT_RELAY_SECRET.length < 32) throw new Error('Unconfigured relay');
  const response = await fetcher(`${env.LECUE_ORIGIN}/api/stt/relay`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.STT_RELAY_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS), redirect: 'manual',
  });
  const data = await response.json();
  if (!response.ok || data.error) throw Object.assign(new Error('Control rejected'), { code: data.error });
  return data;
}

// Exported for deterministic socket/clock tests without real STT requests.
export function bridge({ client, upstream, configuration, grant, connectionId, invoke, now = Date.now, defer = () => {}, timers = globalThis }) {
  // Workerd follows the WebSocket binaryType default ('blob') on recent dates.
  // PCM validation and byte accounting require immediate ArrayBuffer frames.
  client.binaryType = 'arraybuffer';
  upstream.binaryType = 'arraybuffer';
  let processed = Number(grant.baseBytes);
  let authorized = Number(grant.authorizedBytes);
  const base = processed;
  const started = now();
  let lastUpstreamSentAt = started;
  let awaitingAllowance = false;
  let deadline = started + Math.min(20000, Number(grant.leaseMs));
  let closed = false;
  let closing = false;
  let queued = 0;
  let lastControlMessage = -Infinity;
  let chain = Promise.resolve();
  let controlChain = Promise.resolve();
  const provider = configuration.provider;
  let heartbeat;
  let watchdog;
  let finishTimeout;
  function sendUpstream(data) {
    upstream.send(data);
    lastUpstreamSentAt = now();
  }
  function finish(code = 1000, reason = 'Stream closed') {
    if (closed) return;
    closed = true;
    timers.clearInterval(heartbeat); timers.clearInterval(watchdog); timers.clearTimeout(finishTimeout);
    // Disable forwarding and close the upstream before releasing the database lease.
    try { upstream.close(code, reason); } catch { /* already closed */ }
    try { client.close(code, reason); } catch { /* already closed */ }
    defer(invoke({ action: 'close', connectionId, processedBytes: processed }).catch(() => {}));
  }
  function failed(error) {
    const code = error?.code === 'NO_CREDITS' ? 4002 : ['SESSION_NOT_RECORDING', 'SESSION_ENDED', 'SESSION_LIMIT'].includes(error?.code) ? 4003 : 4004;
    if (code === 4002) { try { client.send(JSON.stringify({ type: 'LecueCreditExhausted', credits: 0 })); } catch {} }
    finish(code, code === 4002 ? 'Credits exhausted' : 'Recording connection ended');
  }
  async function renew(extend) {
    if (closed || now() >= deadline) return finish(4004, 'Lease expired');
    const began = now();
    const state = await invoke({ action: 'progress', connectionId, processedBytes: processed, extend });
    if (closed) return;
    if (now() >= deadline) return finish(4004, 'Lease expired');
    authorized = Number(state.authorizedBytes);
    deadline = began + Math.min(20000, Number(state.leaseMs));
    if (!Number.isSafeInteger(state.authorizedBytes) || authorized < processed || authorized > MAX_SESSION_BYTES ||
        !Number.isFinite(state.leaseMs) || state.leaseMs <= 0 || state.leaseMs > 20000 || now() >= deadline) throw new Error('Lease expired');
  }
  function progress(extend = false) {
    // Serialize usage reports with allowance extensions, while already-prepaid
    // PCM keeps flowing during the control request's network round trip.
    const request = controlChain.then(() => renew(extend));
    controlChain = request.catch(failed);
    return request;
  }
  const enqueue = (work) => { chain = chain.then(() => closed ? undefined : work()).catch(failed); };
  client.addEventListener('message', ({ data }) => {
    if (closed || closing) return;
    // Guard on receipt AND immediately before upstream.send after asynchronous authorization.
    if (now() >= deadline) return finish(4004, 'Lease expired');
    if (typeof data === 'string') {
      if (data.length > 64) return finish(4005, 'Invalid control message');
      let type;
      try { type = JSON.parse(data).type; } catch { return finish(4005, 'Invalid control message'); }
      if (!['KeepAlive', 'CloseStream'].includes(type)) return finish(4005, 'Invalid control message');
      if (type === 'KeepAlive') {
        if (now() - lastControlMessage < 1000) return;
        lastControlMessage = now();
        enqueue(() => { if (now() >= deadline) return finish(4004, 'Lease expired'); sendUpstream(JSON.stringify({ type: provider === 'soniox' ? 'keepalive' : 'KeepAlive' })); });
      } else {
        closing = true;
        enqueue(() => {
          if (now() >= deadline) return finish(4004, 'Lease expired');
          sendUpstream(provider === 'soniox' ? '' : JSON.stringify({ type: 'CloseStream' }));
          finishTimeout = timers.setTimeout(() => finish(), 5000);
        });
      }
      return;
    }
    const size = frameBytes(data);
    if (size <= 0 || queued + size > MAX_QUEUE || !validFrame(size, processed - base + queued, now() - started)) return finish(4005, 'Invalid audio stream');
    queued += size;
    enqueue(async () => {
      queued -= size;
      if (processed + size > authorized) {
        awaitingAllowance = true;
        try { await progress(true); } finally { awaitingAllowance = false; }
      }
      if (closed) return;
      if (now() >= deadline || processed + size > authorized) return finish(4004, 'Audio allowance expired');
      sendUpstream(data);
      processed += size;
    });
  });
  upstream.addEventListener('message', ({ data }) => {
    if (closed) return;
    if (now() >= deadline) return finish(4004, 'Lease expired');
    if (typeof data !== 'string' || data.length > 1048576) return finish(4005, 'Invalid provider response');
    try { client.send(data); } catch { finish(); }
  });
  client.addEventListener('close', () => finish());
  client.addEventListener('error', () => finish(4004));
  upstream.addEventListener('close', () => finish());
  upstream.addEventListener('error', () => finish(4004));
  const settled = () => Promise.all([chain, controlChain]);
  if (!validGrant(grant)) { finish(4004, 'Invalid audio allowance'); return { finish, settled }; }
  heartbeat = timers.setInterval(() => { progress().catch(failed); }, 10000);
  watchdog = timers.setInterval(() => {
    if (closed) return;
    if (now() >= deadline) return finish(4004, 'Lease expired');
    // PCM must wait for payment, but the provider's idle timeout must not close
    // that otherwise healthy connection. This sends no audio or control RPC.
    if (awaitingAllowance && now() - lastUpstreamSentAt >= 4000) {
      try { sendUpstream(JSON.stringify({ type: provider === 'soniox' ? 'keepalive' : 'KeepAlive' })); }
      catch (error) { failed(error); }
    }
  }, 500);
  // Opening the provider may consume most of the first 20-second lease.
  if (deadline - now() <= 10000) progress().catch(failed);
  return { finish, settled };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return Response.json({ service: 'lecue-stt-relay', status: 'ok' });
    if (url.pathname !== '/v1/listen' || url.search || request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Not found', { status: 404 });
    if (!ALLOWED_ORIGINS.has(request.headers.get('Origin'))) return new Response('Forbidden', { status: 403 });
    const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(x => x.trim());
    if (protocols.length !== 2 || protocols[0] !== 'lecue' || !/^[\w-]{43}$/.test(protocols[1])) return new Response('Unauthorized', { status: 401 });
    const connectionId = crypto.randomUUID();
    const began = Date.now();
    let grant;
    let upstream;
    try {
      grant = await control(env, { action: 'open', connectionId, ticket: protocols[1] });
      if (!validGrant(grant)) throw new Error('Invalid relay grant');
      const abort = new AbortController();
      const handshakeTimeout = setTimeout(() => abort.abort(), 8000);
      let response;
      try {
        response = await fetch(upstreamRequest(grant.configuration, grant.providerKey), { signal: abort.signal, redirect: 'manual' });
      } finally {
        // Workerd keeps a fetch signal attached to its upgraded WebSocket.
        // Limit the handshake without aborting a healthy stream eight seconds later.
        clearTimeout(handshakeTimeout);
      }
      upstream = response.webSocket;
      if (!upstream || response.status !== 101 || Date.now() - began >= 15000) throw new Error('Upstream unavailable');
      upstream.accept({ allowHalfOpen: true });
      if (grant.configuration.provider === 'soniox') upstream.send(JSON.stringify({ ...grant.configuration.sonioxConfig, api_key: grant.providerKey }));
      const pair = new WebSocketPair();
      pair[1].accept({ allowHalfOpen: true });
      bridge({ client: pair[1], upstream, configuration: grant.configuration, grant: { ...grant, leaseMs: grant.leaseMs - (Date.now() - began) }, connectionId,
        invoke: body => control(env, body), defer: promise => ctx.waitUntil(promise) });
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'lecue' } });
    } catch {
      try { upstream?.close(1011, 'Connection failed'); } catch {}
      if (grant) ctx.waitUntil(control(env, { action: 'close', connectionId, processedBytes: grant.baseBytes }).catch(() => {}));
      return new Response('Recording connection unavailable', { status: 503 });
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil((async () => {
      if (env.LECUE_ORIGIN !== 'https://www.lecue.app' || !env.CRON_SECRET) throw new Error('Unconfigured cleanup');
      const response = await fetch(`${env.LECUE_ORIGIN}/api/cron/storage-cleanup`, { headers: { Authorization: `Bearer ${env.CRON_SECRET}` }, signal: AbortSignal.timeout(300000), redirect: 'manual' });
      if (!response.ok) throw new Error(`Cleanup failed: ${response.status}`);
    })());
  },
};
