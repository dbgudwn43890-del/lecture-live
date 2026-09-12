// Actual SQLite Durable Object + workerd WebSockets, using synthetic PCM only.
// MINIFLARE_MODULE=/private/tmp/lecue-relay-runtime-check/node_modules/miniflare/dist/src/index.js
// PHONE_MIC_LONG_SMOKE=1 also sends 65 seconds of real-time PCM.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runtimeModule = process.env.MINIFLARE_MODULE;
const longSmoke = process.env.PHONE_MIC_LONG_SMOKE === '1';
const origin = 'https://www.lecue.app', secret = 's'.repeat(32);
const ownerToken = 'o'.repeat(43), inviteToken = 'i'.repeat(43), phoneToken = 'p'.repeat(43);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Synthetic socket event timeout'); await sleep(10); }
}
function pcm(captureId, sequence) {
  const data = new ArrayBuffer(3208), view = new DataView(data);
  view.setUint32(0, captureId, true); view.setUint32(4, sequence, true);
  return data;
}
async function setup(shortExpiry = false) {
  const { Miniflare } = await import(pathToFileURL(runtimeModule).href);
  let source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  // Only shorten expiry constants; exercise the actual same alarm/auth path.
  if (shortExpiry) source = source.replace('const INVITE_MS = 180_000;', 'const INVITE_MS = 400;').replace('const ROOM_MS = 10_800_000;', 'const ROOM_MS = 3000;');
  const runtime = new Miniflare({ modules: true, script: source, compatibilityDate: '2026-08-06',
    durableObjects: { PHONE_MIC_ROOMS: { className: 'PhoneMicRoom', useSQLite: true } },
    bindings: { PHONE_MIC_SECRET: secret, ALLOWED_ORIGINS: origin },
    outboundService: () => { throw new Error('External requests are forbidden in this synthetic test'); },
  });
  const roomId = randomUUID(), ownerId = randomUUID();
  async function internal(path, body, method = 'POST') {
    return runtime.dispatchFetch(`https://bridge.test/v1/rooms${path}`, { method, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
  assert.equal((await internal('', { roomId, ownerId, ownerToken, inviteToken })).status, 200);
  async function open(role, token = role === 'owner' ? ownerToken : phoneToken) {
    return runtime.dispatchFetch(`https://bridge.test/v1/rooms/${roomId}/socket`, { headers: { Upgrade: 'websocket', Origin: origin, 'Sec-WebSocket-Protocol': `lecue-phone,${role},${token}` } });
  }
  async function connect(role, heartbeat = true) {
    // A real TCP client exercises both directions of the close handshake.
    const { WebSocket } = createRequire(pathToFileURL(runtimeModule))('ws');
    const url = new URL(`/v1/rooms/${roomId}/socket`, await runtime.ready);
    url.protocol = 'ws:';
    const socket = new WebSocket(url, ['lecue-phone', role, role === 'owner' ? ownerToken : phoneToken], { headers: { Origin: origin } });
    socket.binaryType = 'arraybuffer';
    const messages = [], closed = [];
    socket.addEventListener('message', event => messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data));
    socket.addEventListener('close', event => closed.push(event.code));
    socket.addEventListener('error', () => {});
    await until(() => messages.some(message => message.type === 'hello'));
    assert.equal(socket.protocol, 'lecue-phone');
    if (heartbeat) {
      socket.send('{"type":"ping"}');
      await until(() => messages.some(message => message.type === 'pong'));
    }
    return { socket, messages, closed, send: value => socket.send(JSON.stringify(value)), binary: () => messages.filter(message => message instanceof ArrayBuffer) };
  }
  return { runtime, roomId, ownerId, internal, open, connect,
    claim: token => internal(`/${roomId}/claim`, { inviteToken, phoneToken: token ?? phoneToken }),
  };
}
test('actual workerd pairs scoped roles, forwards/ACKs PCM, reconnects, and rejects malformed or duplicate peers', { skip: !runtimeModule, timeout: 20000 }, async () => {
  const f = await setup();
  try {
    assert.equal((await f.open('phone')).status, 401, 'unclaimed phone cannot connect');
    assert.equal((await f.claim()).status, 200);
    assert.equal((await f.claim()).status, 200);
    assert.equal((await f.claim('x'.repeat(43))).status, 409);
    assert.equal((await f.open('owner', phoneToken)).status, 401);
    const owner = await f.connect('owner'), phone = await f.connect('phone');
    assert.equal(phone.messages[0].peerConnected, true);
    await until(() => owner.messages.some(message => message.type === 'peer' && message.connected));
    assert.equal((await f.open('owner')).status, 409);
    assert.equal((await f.open('phone')).status, 409);
    phone.send({ type: 'ready' });
    await until(() => owner.messages.some(message => message.type === 'ready'));
    owner.send({ type: 'start', captureId: 7 });
    await until(() => phone.messages.some(message => message.type === 'start'));
    phone.socket.send(pcm(7, 0)); phone.socket.send(pcm(7, 0));
    await until(() => owner.binary().length === 2);
    owner.send({ type: 'ack', captureId: 7, sequence: 0 });
    await until(() => phone.messages.some(message => message.type === 'ack'));
    owner.send({ type: 'stop', captureId: 7 });
    await until(() => phone.messages.some(message => message.type === 'stop'));
    phone.socket.send(pcm(7, 1)); phone.send({ type: 'stopped', captureId: 7 });
    await until(() => owner.messages.some(message => message.type === 'stopped'));
    assert.equal(owner.binary().length, 3, 'flush precedes stopped');
    phone.socket.send(pcm(7, 2));
    phone.send({ type: 'ping' });
    await until(() => phone.messages.some(message => message.type === 'pong'));
    assert.equal(owner.binary().length, 3, 'late old capture is ignored');
    phone.socket.close(1000, 'Reconnect fixture');
    await until(() => owner.messages.some(message => message.type === 'peer' && !message.connected));
    const nextPhone = await f.connect('phone');
    nextPhone.send({ type: 'start', captureId: 8 });
    await until(() => nextPhone.closed.length > 0);
    assert.equal(nextPhone.closed[0], 4005, 'phone cannot issue owner controls');
    const malformed = await f.connect('phone');
    malformed.socket.send(new ArrayBuffer(9));
    await until(() => malformed.closed.length > 0);
    assert.equal(malformed.closed[0], 4005);
    const finalPhone = await f.connect('phone');
    owner.socket.send(pcm(7, 3));
    await until(() => owner.closed.length > 0);
    assert.equal(owner.closed[0], 4005, 'owner cannot inject PCM');
    const nextOwner = await f.connect('owner');
    nextOwner.send({ type: 'finish' });
    await until(() => nextOwner.closed.length && finalPhone.closed.length);
    assert.equal((await f.open('phone')).status, 404);
  } finally { await f.runtime.dispose(); }
});
test('actual SQLite alarm expires sockets and unclaimed invitation expires separately', { skip: !runtimeModule, timeout: 10000 }, async () => {
  const f = await setup(true);
  try {
    const owner = await f.connect('owner');
    await sleep(500);
    const response = await f.claim();
    assert.ok([404, 410].includes(response.status));
    assert.ok(['ROOM_NOT_FOUND', 'ROOM_EXPIRED'].includes((await response.json()).code));
    await until(() => owner.closed.length > 0, 4000);
    assert.equal(owner.closed[0], 4001);
    assert.equal((await f.open('owner')).status, 404);
  } finally { await f.runtime.dispose(); }
});
test('actual alarm revokes even a socket that never sends its first heartbeat', { skip: !runtimeModule, timeout: 10000 }, async () => {
  const f = await setup(true);
  let owner;
  try {
    owner = await f.connect('owner', false);
    // Workerd's never-sent socket may remain CLOSING until the TCP handshake
    // times out, but it receives the close and cannot retain the room grant.
    await until(() => owner.socket.readyState >= 2, 4000);
    assert.equal((await f.open('owner')).status, 404);
  } finally { owner?.socket.terminate(); await f.runtime.dispose(); }
});
test('actual TCP bridge accepts five seconds of 50 ms replay and its ACK burst', { skip: !runtimeModule, timeout: 15000 }, async () => {
  const f = await setup();
  try {
    assert.equal((await f.claim()).status, 200);
    const owner = await f.connect('owner'), phone = await f.connect('phone');
    owner.socket.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) owner.send({ type: 'ack', captureId: 1, sequence: new DataView(event.data).getUint32(4, true) });
    });
    owner.send({ type: 'start', captureId: 1 });
    await until(() => phone.messages.some(message => message.type === 'start'));
    for (let sequence = 0; sequence < 100; sequence++) phone.socket.send(pcm(1, sequence).slice(0, 1608));
    await until(() => owner.binary().length === 100 && phone.messages.filter(message => message.type === 'ack').length === 100);
    assert.equal(owner.closed.length, 0); assert.equal(phone.closed.length, 0);
    assert.equal(owner.binary().reduce((total, data) => total + data.byteLength - 8, 0), 160000);
    assert.equal((await f.internal(`/${f.roomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 200);
    await until(() => owner.closed.length && phone.closed.length);
  } finally { await f.runtime.dispose(); }
});
test('actual workerd forwards 65 seconds of acknowledged PCM without storing audio or losing a frame', { skip: !runtimeModule || !longSmoke, timeout: 85000 }, async () => {
  const f = await setup();
  try {
    assert.equal((await f.claim()).status, 200);
    const owner = await f.connect('owner'), phone = await f.connect('phone');
    owner.socket.addEventListener('message', event => {
      if (event.data instanceof ArrayBuffer) owner.send({ type: 'ack', captureId: 1, sequence: new DataView(event.data).getUint32(4, true) });
    });
    owner.send({ type: 'start', captureId: 1 });
    await until(() => phone.messages.some(message => message.type === 'start'));
    const began = Date.now();
    for (let sequence = 0; sequence < 650; sequence++) {
      phone.socket.send(pcm(1, sequence));
      await sleep(Math.max(0, began + (sequence + 1) * 100 - Date.now()));
    }
    await until(() => owner.binary().length === 650);
    assert.equal(owner.closed.length, 0); assert.equal(phone.closed.length, 0);
    assert.equal(owner.binary().reduce((total, data) => total + data.byteLength - 8, 0), 65 * 32000);
    owner.send({ type: 'finish' });
    await until(() => phone.closed.length > 0);
  } finally { await f.runtime.dispose(); }
});

test('actual workerd serializes simultaneous creation of both owner slots and preserves the other active connection', { skip: !runtimeModule, timeout: 15000 }, async () => {
  const f = await setup(), otherRoomId = randomUUID();
  try {
    assert.equal((await f.internal(`/${f.roomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 200);
    const endpoint = new URL('/v1/rooms', await f.runtime.ready);
    const attempts = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: index % 2 ? f.roomId : otherRoomId, ownerId: f.ownerId, ownerToken, inviteToken }) });
      return { status: response.status, body: await response.json() };
    }));
    assert.equal(attempts.filter(response => response.status === 200).length, 2);
    for (const response of attempts.filter(response => response.status !== 200)) {
      assert.equal(response.status, 409); assert.equal(response.body.code, 'ROOM_BUSY');
    }
    assert.equal((await f.claim()).status, 200);
    const owner = await f.connect('owner'), phone = await f.connect('phone');
    assert.equal((await f.internal('', { roomId: f.roomId, ownerId: f.ownerId, ownerToken: 'x'.repeat(43), inviteToken: 'y'.repeat(43) })).status, 409);
    assert.equal((await f.internal(`/${otherRoomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 200);
    assert.equal((await f.internal('', { roomId: otherRoomId, ownerId: f.ownerId, ownerToken: 'x'.repeat(43), inviteToken: 'y'.repeat(43) })).status, 200);
    assert.equal((await f.internal(`/${otherRoomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 401);
    owner.send({ type: 'status', state: 'recording', elapsedMs: 1000 });
    await until(() => phone.messages.some(message => message.type === 'status'));
    assert.equal(owner.closed.length, 0); assert.equal(phone.closed.length, 0);
  } finally { await f.runtime.dispose(); }
});
test('actual claim extends the invite alarm to the room lifetime and an unclaimed slot expires for reuse', { skip: !runtimeModule, timeout: 15000 }, async () => {
  const f = await setup(true);
  try {
    const owner = await f.connect('owner');
    assert.equal((await f.claim()).status, 200);
    await sleep(600);
    owner.send({ type: 'ping' });
    await until(() => owner.messages.filter(message => message.type === 'pong').length >= 2);
    assert.equal(owner.closed.length, 0, 'claimed room survived its original invite alarm');
    await until(() => owner.closed.length > 0, 4000);
    assert.equal(owner.closed[0], 4001);
    assert.equal((await f.internal('', { roomId: f.roomId, ownerId: f.ownerId, ownerToken: 'x'.repeat(43), inviteToken: 'y'.repeat(43) })).status, 200);
    assert.equal((await f.claim()).status, 401, 'old invite is revoked on slot reuse');
    await sleep(600);
    assert.equal((await f.internal('', { roomId: f.roomId, ownerId: f.ownerId, ownerToken, inviteToken })).status, 200, 'unclaimed slot expires independently of the longer room lifetime');
  } finally { await f.runtime.dispose(); }
});
