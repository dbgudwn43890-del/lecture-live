import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import worker, { PhoneMicRoom, authorized, cleanControl, hashToken, pcmHeader, readBody, takeBudget } from './index.mjs';

const ownerToken = 'o'.repeat(43), inviteToken = 'i'.repeat(43), phoneToken = 'p'.repeat(43);
function frame(captureId = 1, sequence = 0, bytes = 3200) {
  const data = new ArrayBuffer(bytes + 8), view = new DataView(data);
  view.setUint32(0, captureId, true); view.setUint32(4, sequence, true);
  return data;
}
class Socket {
  readyState = 1; sent = []; meta; code;
  constructor(role) { this.meta = { role, control: { tokens: 80, at: Date.now() }, ack: { tokens: 160, at: Date.now() }, audio: { tokens: 160000, at: Date.now() }, flight: [], captureId: 0 }; }
  serializeAttachment(meta) { assert.ok(JSON.stringify(meta).length <= 2048, 'Cloudflare attachment size bound'); this.meta = structuredClone(meta); }
  deserializeAttachment() { return structuredClone(this.meta); }
  send(data) { this.sent.push(data); }
  close(code) { this.readyState = 3; this.code = code; }
}
async function fixture() {
  const stored = new Map(), sockets = [];
  let gate = Promise.resolve(), alarm;
  const ctx = {
    blockConcurrencyWhile(callback) { const work = gate.then(callback); gate = work.catch(() => {}); return work; },
    getWebSockets(role) { return sockets.filter(socket => !role || socket.meta.role === role); },
    storage: {
      async get(key) { return stored.get(key); }, async put(key, value) { stored.set(key, structuredClone(value)); },
      async deleteAll() { stored.clear(); }, async setAlarm(value) { alarm = value; }, async deleteAlarm() { alarm = undefined; },
    },
  };
  const room = new PhoneMicRoom(ctx, {}), roomId = randomUUID(), ownerId = randomUUID();
  const request = (path, body, method = 'POST') => room.fetch(new Request(`https://relay.test/v1/rooms${path}`, { method, body: JSON.stringify(body) }));
  const created = await request('', { roomId, ownerId, ownerToken, inviteToken });
  assert.equal(created.status, 200);
  return { room, roomId, ownerId, stored, sockets, request, alarm: () => alarm,
    add(role) { const socket = new Socket(role); sockets.push(socket); return socket; },
    claim(token = phoneToken) { return request(`/${roomId}/claim`, { inviteToken, phoneToken: token }); },
  };
}
test('room stores only hashed scoped capabilities; invite is one-use and same-phone retry is idempotent', async () => {
  const f = await fixture();
  const record = f.stored.get('room');
  for (const secret of [ownerToken, inviteToken, phoneToken]) assert.equal(JSON.stringify(record).includes(secret), false);
  assert.equal(record.ownerHash, await hashToken(ownerToken));
  assert.equal(f.alarm(), record.inviteExpiresAt);
  assert.equal((await f.claim()).status, 200);
  assert.equal(f.alarm(), record.expiresAt);
  assert.equal((await f.claim()).status, 200);
  assert.equal((await f.claim('x'.repeat(43))).status, 409);
  assert.equal((await f.request(`/${f.roomId}/claim`, { inviteToken: 'x'.repeat(43), phoneToken })).status, 401);
});
test('concurrent claims serialize and exactly one phone wins', async () => {
  const f = await fixture();
  assert.deepEqual((await Promise.all([f.claim(), f.claim('z'.repeat(43))])).map(response => response.status), [200, 409]);
});
test('expired invites reject first claim but not same-phone response-loss retry', async () => {
  const f = await fixture();
  f.room.room.inviteExpiresAt = Date.now() - 1;
  assert.equal((await f.claim()).status, 410);
  f.room.room.inviteExpiresAt = Date.now() + 1000;
  assert.equal((await f.claim()).status, 200);
  f.room.room.inviteExpiresAt = Date.now() - 1;
  assert.equal((await f.claim()).status, 200);
});
test('delete requires both the account and owner capability, then revokes all sockets and persisted metadata', async () => {
  const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
  assert.equal((await f.request(`/${f.roomId}`, { ownerId: randomUUID(), ownerToken }, 'DELETE')).status, 401);
  assert.equal((await f.request(`/${f.roomId}`, { ownerId: f.ownerId, ownerToken: phoneToken }, 'DELETE')).status, 401);
  assert.equal((await f.request(`/${f.roomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 200);
  assert.equal(owner.readyState, 3); assert.equal(phone.readyState, 3);
  assert.equal(f.stored.size, 0); assert.equal(f.alarm(), undefined);
  await f.room.message(phone, frame());
  assert.equal(owner.sent.some(value => value instanceof ArrayBuffer), false);
});
test('expiry and alarm close sockets before further audio can pass', async () => {
  for (const useAlarm of [false, true]) {
    const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
    f.room.room.captureId = 1;
    if (useAlarm) { f.room.room.unclaimedExpiresAt = Date.now() - 1; await f.room.alarm(); }
    else { f.room.room.expiresAt = Date.now() - 1; await f.room.message(phone, frame()); }
    assert.equal(owner.code, 4001); assert.equal(phone.code, 4001); assert.equal(f.stored.size, 0);
    assert.equal(owner.sent.some(value => value instanceof ArrayBuffer), false);
  }
});
test('control role allowlist strips extras and rejects malformed, oversized or foreign messages', () => {
  assert.deepEqual(cleanControl('phone', JSON.stringify({ type: 'error', code: 'MIC_DENIED', raw: 'secret' })), { type: 'error', code: 'MIC_DENIED' });
  for (const [role, value] of [['phone', { type: 'start', captureId: 1 }], ['phone', { type: 'finish' }], ['owner', { type: 'ready' }], ['phone', { type: 'error', code: 'raw upstream' }], ['owner', { type: 'start', captureId: 0 }], ['owner', { type: 'ack', captureId: 1, sequence: -1 }], ['owner', { type: 'status', state: 'recording', elapsedMs: Infinity }]]) assert.equal(cleanControl(role, JSON.stringify(value)), null);
  assert.equal(cleanControl('phone', '{'), null);
  assert.equal(cleanControl('phone', 'x'.repeat(513)), null);
});
test('PCM parsing enforces canonical headers and bounded even samples', () => {
  assert.deepEqual(pcmHeader(frame(12, 0xffffffff, 8192)), { captureId: 12, sequence: 0xffffffff, bytes: 8192 });
  for (const invalid of [frame(0), frame(1, 0, 8194), frame(1, 0, 1), new ArrayBuffer(8), 'data']) assert.equal(pcmHeader(invalid), null);
});
test('PCM duplicates reach desktop for dedup, ACK releases bounded flight metadata, and stop allows final flush', async () => {
  const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
  await f.room.message(owner, '{"type":"start","captureId":1}');
  await f.room.message(phone, frame()); await f.room.message(phone, frame());
  assert.equal(owner.sent.filter(value => value instanceof ArrayBuffer).length, 2);
  assert.equal(phone.meta.flight.length, 1);
  await f.room.message(owner, '{"type":"ack","captureId":1,"sequence":0}');
  assert.equal(phone.meta.flight.length, 0);
  await f.room.message(owner, '{"type":"stop","captureId":1}');
  await f.room.message(phone, frame(1, 1));
  await f.room.message(phone, '{"type":"stopped","captureId":1}');
  assert.equal(f.room.room.captureId, 0);
  await f.room.message(phone, frame(1, 2));
  assert.equal(owner.sent.filter(value => value instanceof ArrayBuffer).length, 3);
  assert.equal(JSON.parse(owner.sent.at(-1)).type, 'stopped');
  assert.equal(phone.readyState, 1, 'old frames are dropped without turning a normal stop into a failure');
});
test('wrong-role audio and controls close only offender; peer drops are visible', async () => {
  for (const invalid of [frame(), '{"type":"ready"}']) {
    const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
    await f.room.message(owner, invalid);
    assert.equal(owner.code, 4005); assert.equal(phone.readyState, 1);
    assert.deepEqual(JSON.parse(phone.sent.at(-1)), { type: 'peer', connected: false });
  }
});
test('unacknowledged PCM stays bounded and never writes audio to storage', async () => {
  const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
  await f.room.message(owner, '{"type":"start","captureId":1}');
  for (let index = 0; index < 101; index++) await f.room.message(phone, frame(1, index, 2));
  assert.equal(phone.code, 4004);
  assert.ok(owner.sent.includes('{"type":"error","code":"BUFFER_FULL"}'));
  assert.equal(f.stored.size, 1);
  assert.deepEqual(Object.keys(f.stored.get('room')).sort(), ['captureId', 'expiresAt', 'inviteExpiresAt', 'inviteHash', 'ownerHash', 'ownerId', 'phoneHash', 'roomId', 'unclaimedExpiresAt']);
});
test('five seconds of 50 ms replay and its ACK burst fit both transport and attachment budgets', async () => {
  const f = await fixture(), owner = f.add('owner'), phone = f.add('phone');
  await f.room.message(owner, '{"type":"start","captureId":1}');
  for (let index = 0; index < 100; index++) await f.room.message(phone, frame(1, 0xffff0000 + index, 1600));
  assert.equal(phone.readyState, 1);
  assert.equal(phone.meta.flight.length, 100);
  for (let index = 0; index < 100; index++) await f.room.message(owner, JSON.stringify({ type: 'ack', captureId: 1, sequence: 0xffff0000 + index }));
  assert.equal(owner.readyState, 1);
  assert.equal(phone.meta.flight.length, 0);
});
test('token buckets permit realtime audio and bounded catch-up but reject a flood', () => {
  const state = { tokens: 160000, at: 0 };
  assert.equal(takeBudget(state, 160000, 0, 64000, 160000), true);
  assert.equal(takeBudget(state, 2, 0, 64000, 160000), false);
  assert.equal(takeBudget(state, 32000, 1000, 64000, 160000), true);
});
test('HTTP requires internal authentication and exact browser origin before touching a room', async () => {
  let calls = 0;
  const env = { PHONE_MIC_SECRET: 's'.repeat(32), ALLOWED_ORIGINS: 'https://www.lecue.app,http://localhost:3000', PHONE_MIC_ROOMS: { idFromName() { calls++; } } };
  assert.equal((await worker.fetch(new Request('https://relay.test/v1/rooms', { method: 'POST', body: '{}' }), env)).status, 401);
  assert.equal((await worker.fetch(new Request(`https://relay.test/v1/rooms/${randomUUID()}/socket`, { headers: { Upgrade: 'websocket', Origin: 'https://www.lecue.app.attacker.test' } }), env)).status, 403);
  assert.equal(calls, 0);
  assert.equal(authorized(new Request('https://relay.test', { headers: { Authorization: `Bearer ${env.PHONE_MIC_SECRET}` } }), env.PHONE_MIC_SECRET), true);
  assert.equal(authorized(new Request('https://relay.test'), ''), false);
});
test('bounded HTTP JSON reader rejects oversized bodies even without Content-Length', async () => {
  assert.equal(await readBody(new Request('https://relay.test', { method: 'POST', body: JSON.stringify({ text: 'a'.repeat(2048) }) })), null);
  assert.deepEqual(await readBody(new Request('https://relay.test', { method: 'POST', body: '{"ok":true}' })), { ok: true });
});

test('busy slot creation never replaces current capabilities or closes active sockets', async () => {
  const f = await fixture(); await f.claim();
  const owner = f.add('owner'), phone = f.add('phone');
  const original = structuredClone(f.stored.get('room'));
  const attempts = await Promise.all(Array.from({ length: 10 }, () => f.request('', {
    roomId: f.roomId, ownerId: f.ownerId, ownerToken: 'x'.repeat(43), inviteToken: 'y'.repeat(43),
  })));
  for (const response of attempts) {
    assert.equal(response.status, 409); assert.equal((await response.json()).code, 'ROOM_BUSY');
  }
  assert.deepEqual(f.stored.get('room'), original);
  assert.equal(owner.readyState, 1); assert.equal(phone.readyState, 1);
});
test('unclaimed expiry frees a slot; fresh tokens revoke previous capabilities', async () => {
  const f = await fixture(), owner = f.add('owner');
  f.room.room.unclaimedExpiresAt = Date.now() - 1;
  assert.equal((await f.request('', { roomId: f.roomId, ownerId: f.ownerId, ownerToken: 'x'.repeat(43), inviteToken: 'y'.repeat(43) })).status, 200);
  assert.equal(owner.code, 4001);
  assert.equal((await f.claim()).status, 401);
  assert.equal((await f.request(`/${f.roomId}`, { ownerId: f.ownerId, ownerToken }, 'DELETE')).status, 401);
});
test('a queued invitation alarm cannot close a claimed room or a later slot reuse', async () => {
  const f = await fixture(); await f.claim();
  const owner = f.add('owner'), phone = f.add('phone');
  f.room.room.unclaimedExpiresAt = Date.now() - 1;
  await f.room.alarm();
  assert.equal(owner.readyState, 1); assert.equal(phone.readyState, 1);
  assert.equal(f.alarm(), f.room.room.expiresAt);
});
test('legacy random rooms retain their original lifetime during rollout', async () => {
  const f = await fixture();
  delete f.room.room.unclaimedExpiresAt;
  f.room.room.inviteExpiresAt = Date.now() - 1;
  await f.room.alarm();
  assert.ok(f.room.room);
  assert.equal(f.alarm(), f.room.room.expiresAt);
  assert.equal((await f.claim()).status, 410);
});
