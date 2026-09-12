// Isolated, capability-scoped PCM bridge. No owner login, STT key, or audio is stored.
const INVITE_MS = 180_000;
const ROOM_MS = 10_800_000;
const TOKEN = /^[\w-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 2048;
const MAX_IN_FLIGHT = 160_000;
const ERRORS = new Set(['MIC_DENIED', 'MIC_LOST', 'AUDIO_STALLED', 'BUFFER_FULL', 'CONNECTION_LOST']);
const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const failure = (code, status) => json({ code }, status);
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const capture = value => uint32(value) && value > 0;
// Legacy rooms have no unclaimedExpiresAt and keep their original lifetime.
const roomDeadline = room => room.phoneHash ? room.expiresAt : Math.min(room.unclaimedExpiresAt ?? room.expiresAt, room.expiresAt);
const expiry = room => ({ roomId: room.roomId, expiresAt: new Date(room.expiresAt).toISOString() });

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function authorized(request, secret) {
  if (typeof secret !== 'string' || secret.length < 32) return false;
  const expected = `Bearer ${secret}`, actual = request.headers.get('Authorization') ?? '';
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return difference === 0;
}
export function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  return !!origin && typeof env.ALLOWED_ORIGINS === 'string' && env.ALLOWED_ORIGINS.split(',').map(value => value.trim()).includes(origin);
}
export async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BODY || !request.body) return null;
  const reader = request.body.getReader();
  let bytes = 0, result = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); return null; }
      result += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(result + decoder.decode());
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch { return null; }
  finally { reader.releaseLock(); }
}
// A token bucket bounds both sustained forwarding and reconnect catch-up.
export function takeBudget(state, size, now, rate, burst) {
  const available = Math.min(burst, state.tokens + Math.max(0, now - state.at) * rate / 1000);
  state.at = now;
  state.tokens = available - size;
  return state.tokens >= 0;
}
export function pcmHeader(data) {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 10 || data.byteLength > 8200 || data.byteLength % 2 !== 0) return null;
  const view = new DataView(data);
  const captureId = view.getUint32(0, true), sequence = view.getUint32(4, true);
  return capture(captureId) ? { captureId, sequence, bytes: data.byteLength - 8 } : null;
}
export function cleanControl(role, data) {
  if (typeof data !== 'string' || data.length > 512) return null;
  let value;
  try { value = JSON.parse(data); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { type } = value;
  if (type === 'ping') return { type };
  if (role === 'owner') {
    if (type === 'finish') return { type };
    if (['start', 'stop'].includes(type) && capture(value.captureId)) return { type, captureId: value.captureId };
    if (type === 'ack' && capture(value.captureId) && uint32(value.sequence)) return { type, captureId: value.captureId, sequence: value.sequence };
    if (type === 'status' && ['connecting', 'recording', 'paused', 'error'].includes(value.state) && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= ROOM_MS) return { type, state: value.state, elapsedMs: value.elapsedMs };
  } else if (role === 'phone') {
    if (type === 'ready' || type === 'pause') return { type };
    if (['started', 'stopped'].includes(type) && capture(value.captureId)) return { type, captureId: value.captureId };
    if (type === 'error' && ERRORS.has(value.code)) return { type, code: value.code };
  }
  return null;
}

// Deploy with a SQLite Durable Object binding named PHONE_MIC_ROOMS. KV stores
// only hashed capabilities and lifecycle metadata; sockets use hibernation.
export class PhoneMicRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.room = null;
    ctx.blockConcurrencyWhile(async () => { this.room = await ctx.storage.get('room') ?? null; });
  }
  sockets(role) { return this.ctx.getWebSockets(role).filter(socket => socket.readyState === 1 && !socket.deserializeAttachment()?.closed); }
  send(socket, value) { try { socket.send(typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value)); return true; } catch { this.disconnect(socket, 4004); return false; } }
  peer(role) { return this.sockets(role === 'owner' ? 'phone' : 'owner')[0]; }
  disconnect(socket, code = 1000) {
    const meta = socket.deserializeAttachment();
    if (!meta || meta.closed) return;
    socket.serializeAttachment({ ...meta, closed: true });
    try { socket.close(code, code === 4005 ? 'Invalid microphone message' : 'Microphone connection closed'); } catch {}
    const peer = this.peer(meta.role);
    if (peer) this.send(peer, { type: 'peer', connected: false });
  }
  async finish(code = 1000) {
    // In-memory revocation precedes all awaits, including pending socket events.
    this.room = null;
    for (const socket of this.ctx.getWebSockets()) this.disconnect(socket, code);
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      if (!this.room) return;
      // An already queued invite alarm must not close a just-claimed/reused room.
      const deadline = roomDeadline(this.room);
      if (Date.now() >= deadline) await this.finish(4001);
      else await this.ctx.storage.setAlarm(deadline);
    });
  }
  fetch(request) { return this.ctx.blockConcurrencyWhile(() => this.handle(request)); }
  async handle(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/rooms' && request.method === 'POST') {
      const body = await readBody(request);
      if (!body || !UUID.test(body.roomId) || !UUID.test(body.ownerId) || !TOKEN.test(body.ownerToken) || !TOKEN.test(body.inviteToken)) return failure('INVALID_REQUEST', 400);
      if (this.room && Date.now() >= roomDeadline(this.room)) await this.finish(4001);
      if (this.room) return failure('ROOM_BUSY', 409);
      const now = Date.now();
      this.room = { roomId: body.roomId, ownerId: body.ownerId,
        ownerHash: await hashToken(body.ownerToken), inviteHash: await hashToken(body.inviteToken), phoneHash: null,
        inviteExpiresAt: now + INVITE_MS, unclaimedExpiresAt: now + INVITE_MS, expiresAt: now + ROOM_MS, captureId: 0 };
      await this.ctx.storage.put('room', this.room);
      await this.ctx.storage.setAlarm(roomDeadline(this.room));
      return json({ ...expiry(this.room), inviteExpiresAt: new Date(this.room.inviteExpiresAt).toISOString() });
    }
    if (!this.room) return failure('ROOM_NOT_FOUND', 404);
    if (Date.now() >= roomDeadline(this.room)) { await this.finish(4001); return failure('ROOM_EXPIRED', 410); }
    if (url.pathname.endsWith('/claim') && request.method === 'POST') {
      const body = await readBody(request);
      if (!body || !TOKEN.test(body.inviteToken) || !TOKEN.test(body.phoneToken)) return failure('INVALID_REQUEST', 400);
      const [inviteHash, phoneHash] = await Promise.all([hashToken(body.inviteToken), hashToken(body.phoneToken)]);
      if (inviteHash !== this.room.inviteHash) return failure('UNAUTHORIZED', 401);
      if (this.room.phoneHash) return this.room.phoneHash === phoneHash ? json(expiry(this.room)) : failure('INVITE_CLAIMED', 409);
      if (Date.now() >= this.room.inviteExpiresAt) return failure('INVITE_EXPIRED', 410);
      this.room.phoneHash = phoneHash;
      await this.ctx.storage.put('room', this.room);
      await this.ctx.storage.setAlarm(this.room.expiresAt);
      return json(expiry(this.room));
    }
    if (request.method === 'DELETE') {
      const body = await readBody(request);
      if (!body || body.ownerId !== this.room.ownerId || !TOKEN.test(body.ownerToken) || await hashToken(body.ownerToken) !== this.room.ownerHash) return failure('UNAUTHORIZED', 401);
      await this.finish();
      return json({ ok: true });
    }
    if (url.pathname.endsWith('/socket') && request.method === 'GET') {
      const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(value => value.trim());
      const [, role, token] = protocols;
      if (protocols.length !== 3 || protocols[0] !== 'lecue-phone' || !['owner', 'phone'].includes(role) || !TOKEN.test(token)) return failure('UNAUTHORIZED', 401);
      if (await hashToken(token) !== this.room[role === 'owner' ? 'ownerHash' : 'phoneHash']) return failure('UNAUTHORIZED', 401);
      if (this.sockets(role).length) return failure('PEER_ALREADY_CONNECTED', 409);
      const pair = new WebSocketPair(), socket = pair[1], now = Date.now();
      socket.binaryType = 'arraybuffer';
      this.ctx.acceptWebSocket(socket, [role]);
      socket.serializeAttachment({ role, control: { tokens: 80, at: now }, ack: { tokens: 160, at: now }, audio: { tokens: MAX_IN_FLIGHT, at: now }, flight: [], captureId: this.room.captureId });
      const peer = this.peer(role);
      this.send(socket, { type: 'hello', role, expiresAt: new Date(this.room.expiresAt).toISOString(), peerConnected: !!peer });
      if (peer) this.send(peer, { type: 'peer', connected: true });
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'lecue-phone' } });
    }
    return failure('INVALID_REQUEST', 400);
  }
  webSocketMessage(socket, data) { return this.ctx.blockConcurrencyWhile(() => this.message(socket, data)); }
  async message(socket, data) {
    const meta = socket.deserializeAttachment();
    if (!meta || meta.closed) return;
    if (!this.room || Date.now() >= roomDeadline(this.room)) return this.finish(4001);
    if (this.sockets(meta.role)[0] !== socket) return this.disconnect(socket, 4005);
    const peer = this.peer(meta.role);
    if (typeof data !== 'string') {
      const header = pcmHeader(data);
      if (meta.role !== 'phone' || !header || !takeBudget(meta.audio, header.bytes, Date.now(), 64_000, MAX_IN_FLIGHT)) return this.disconnect(socket, 4005);
      // Frames in flight during stop/start or a disconnected desktop are never
      // replayed by the bridge. The phone retains unacknowledged PCM itself.
      if (header.captureId !== this.room.captureId || !peer) { socket.serializeAttachment(meta); return; }
      if (meta.captureId !== header.captureId) { meta.captureId = header.captureId; meta.flight = []; }
      const duplicate = meta.flight.find(frame => frame[0] === header.sequence);
      if (duplicate) duplicate[1] += header.bytes;
      else meta.flight.push([header.sequence, header.bytes]);
      // Compact metadata stays below the hibernation attachment's 2 KB limit,
      // including 100 retained 50 ms frames. There is never any PCM in it.
      if (meta.flight.length > 100 || meta.flight.reduce((sum, frame) => sum + frame[1], 0) > MAX_IN_FLIGHT) {
        this.send(peer, { type: 'error', code: 'BUFFER_FULL' });
        return this.disconnect(socket, 4004);
      }
      socket.serializeAttachment(meta);
      this.send(peer, data);
      return;
    }
    const control = cleanControl(meta.role, data);
    if (!control || !takeBudget(control.type === 'ack' ? meta.ack : meta.control, 1, Date.now(), control.type === 'ack' ? 80 : 40, control.type === 'ack' ? 160 : 80)) return this.disconnect(socket, 4005);
    socket.serializeAttachment(meta);
    if (control.type === 'ping') { this.send(socket, { type: 'pong' }); return; }
    if (control.type === 'finish') return this.finish();
    if (control.type === 'start') {
      this.room.captureId = control.captureId;
      await this.ctx.storage.put('room', this.room);
    }
    if (['stop', 'ack', 'started', 'stopped'].includes(control.type) && control.captureId !== this.room.captureId) return;
    if (control.type === 'ack' && peer) {
      const phone = peer.deserializeAttachment();
      if (phone.captureId === control.captureId) {
        phone.flight = phone.flight.filter(frame => frame[0] > control.sequence);
        peer.serializeAttachment(phone);
      }
    }
    if (peer) this.send(peer, control);
    if (control.type === 'stopped') {
      this.room.captureId = 0;
      await this.ctx.storage.put('room', this.room);
    }
  }
  webSocketClose(socket) { this.disconnect(socket); }
  webSocketError(socket) { this.disconnect(socket, 4004); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ service: 'lecue-phone-mic', status: 'ok' });
    if (url.search || !env.PHONE_MIC_ROOMS) return failure('INVALID_REQUEST', 404);
    const path = url.pathname.match(/^\/v1\/rooms\/([^/]+)(?:\/(claim|socket))?$/);
    if (path?.[2] === 'socket' && request.method === 'GET') {
      if (!UUID.test(path[1]) || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return failure('INVALID_REQUEST', 400);
      if (!allowedOrigin(request, env)) return failure('UNAUTHORIZED', 403);
    } else if (!authorized(request, env.PHONE_MIC_SECRET)) return failure('UNAUTHORIZED', 401);
    try {
      if (url.pathname === '/v1/rooms' && request.method === 'POST') {
        const body = await readBody(request);
        if (!body || !UUID.test(body.roomId)) return failure('INVALID_REQUEST', 400);
        return env.PHONE_MIC_ROOMS.get(env.PHONE_MIC_ROOMS.idFromName(body.roomId)).fetch(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }));
      }
      if (!path || !UUID.test(path[1]) || !(path[2] === 'socket' && request.method === 'GET' || path[2] === 'claim' && request.method === 'POST' || !path[2] && request.method === 'DELETE')) return failure('INVALID_REQUEST', 404);
      return env.PHONE_MIC_ROOMS.get(env.PHONE_MIC_ROOMS.idFromName(path[1])).fetch(request);
    } catch { return failure('UNAVAILABLE', 503); }
  },
};
