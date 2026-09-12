// Synthetic deployed-bridge verification only: never contacts STT, auth, or DB.
// Reads .env.phone-mic.local in memory. --minute adds 65 seconds of paced PCM.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const WebSocket = require('next/dist/compiled/ws');
const local = Object.fromEntries(readFileSync(resolve(import.meta.dirname, '../../.env.phone-mic.local'), 'utf8')
  .split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
const origin = 'https://www.lecue.app';
const relay = new URL(local.PHONE_MIC_RELAY_URL);
if (relay.protocol !== 'https:' || relay.username || relay.password || relay.port || relay.pathname !== '/' || relay.search || relay.hash
  || !/^lecue-phone-mic\.[a-z0-9-]+\.workers\.dev$/.test(relay.hostname) || !/^[a-f0-9]{64}$/.test(local.PHONE_MIC_SECRET ?? '')) throw new Error('Synthetic bridge test configuration is invalid');
const roomId = randomUUID(), ownerId = randomUUID();
const token = () => randomBytes(32).toString('base64url');
const ownerToken = token(), inviteToken = token(), phoneToken = token();
const sockets = [];
let stage = 'setup', socketFailure = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  stage = label;
  const deadline = Date.now() + 10_000;
  while (!check()) { if (socketFailure || Date.now() >= deadline) throw new Error(`Synthetic ${label} failed`); await wait(20); }
}
async function internal(path, body, method = 'POST') {
  return fetch(new URL(`/v1/rooms${path}`, relay), { method,
    headers: { Authorization: `Bearer ${local.PHONE_MIC_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error',
  });
}
function open(role, capability = role === 'owner' ? ownerToken : phoneToken) {
  const url = new URL(`/v1/rooms/${roomId}/socket`, relay); url.protocol = 'wss:';
  const socket = new WebSocket(url, ['lecue-phone', role, capability], { headers: { Origin: origin }, handshakeTimeout: 10_000 });
  socket.binaryType = 'arraybuffer'; socket.on('error', () => {}); sockets.push(socket);
  return socket;
}
async function rejected(role, capability, status) {
  stage = `rejected ${role} handshake ${status}`;
  const socket = open(role, capability);
  await new Promise((resolve, reject) => {
    const onError = () => reject(new Error('Synthetic handshake failed before status validation'));
    socket.once('error', onError);
    socket.once('unexpected-response', (_request, response) => {
      // Terminating a CONNECTING ws synchronously emits an error. Settle the
      // observed HTTP result first so cleanup cannot turn a valid 401/409 into
      // a false transport failure. open() retains its no-op error listener.
      socket.removeListener('error', onError);
      response.statusCode === status ? resolve() : reject(new Error(`Synthetic rejected handshake returned ${response.statusCode}`));
      response.destroy(); socket.terminate();
    });
    socket.once('open', () => {
      socket.removeListener('error', onError);
      reject(new Error('Synthetic unauthorized socket opened'));
      socket.terminate();
    });
  });
}
let received = 0, pcmBytes = 0;
async function connect(role) {
  const socket = open(role), controls = [], closed = [];
  socket.on('message', (data, binary) => {
    try {
    if (binary) {
      assert.equal(role, 'owner');
      const view = new DataView(data);
      assert.equal(view.getUint32(0, true), 1);
      assert.equal(view.getUint32(4, true), received);
      received++; pcmBytes += data.byteLength - 8;
      socket.send(JSON.stringify({ type: 'ack', captureId: 1, sequence: received - 1 }));
    } else {
      controls.push(JSON.parse(String(data)));
      if (controls.length > 100) controls.shift();
    }
    } catch { socketFailure = true; }
  });
  socket.on('close', code => closed.push(code));
  await until(() => controls.some(message => message.type === 'hello'), `${role} hello`);
  socket.send('{"type":"ping"}');
  await until(() => controls.some(message => message.type === 'pong'), `${role} heartbeat`);
  return { socket, controls, closed, send: message => socket.send(JSON.stringify(message)) };
}
function frame(sequence) {
  const data = new ArrayBuffer(1608), view = new DataView(data);
  view.setUint32(0, 1, true); view.setUint32(4, sequence, true);
  return data;
}
let attempted = false;
try {
  attempted = true;
  assert.equal((await internal('', { roomId, ownerId, ownerToken, inviteToken })).status, 200);
  assert.equal((await internal(`/${roomId}/claim`, { inviteToken, phoneToken })).status, 200);
  assert.equal((await internal(`/${roomId}/claim`, { inviteToken, phoneToken })).status, 200);
  await rejected('owner', phoneToken, 401);
  const owner = await connect('owner');
  let phone = await connect('phone');
  await rejected('owner', ownerToken, 409);
  owner.send({ type: 'start', captureId: 1 });
  await until(() => phone.controls.some(message => message.type === 'start'), 'start');
  phone.socket.send(frame(0));
  await until(() => received === 1, 'first frame');
  phone.socket.close(1000, 'Synthetic reconnect');
  await until(() => owner.controls.some(message => message.type === 'peer' && !message.connected), 'peer disconnect');
  phone = await connect('phone');
  const count = process.argv.includes('--minute') ? 1300 : 2;
  const began = Date.now();
  for (let sequence = 1; sequence < count; sequence++) {
    phone.socket.send(frame(sequence));
    await wait(50);
  }
  await until(() => received === count, 'ordered PCM');
  owner.send({ type: 'stop', captureId: 1 });
  await until(() => phone.controls.some(message => message.type === 'stop'), 'stop');
  phone.socket.send(frame(count));
  phone.send({ type: 'stopped', captureId: 1 });
  await until(() => owner.controls.some(message => message.type === 'stopped'), 'final flush');
  assert.equal(received, count + 1);
  assert.equal((await internal(`/${roomId}`, { ownerId, ownerToken }, 'DELETE')).status, 200);
  await until(() => owner.closed.length && phone.closed.length, 'room deletion');
  console.log(JSON.stringify({ status: 'ok', syntheticOnly: true, frames: received, pcmBytes, elapsedMs: Date.now() - began,
    duplicateOwnerRejected: true, wrongCapabilityRejected: true, phoneReconnected: true, roomDeleted: true }));
} catch {
  // Never print request URLs, headers, capability values, or upstream bodies.
  console.error(`Synthetic phone bridge smoke failed at ${stage}.`);
  process.exitCode = 1;
} finally {
  if (attempted) {
    try { const response = await internal(`/${roomId}`, { ownerId, ownerToken }, 'DELETE'); if (![200, 404, 410].includes(response.status)) throw new Error(); }
    catch { console.error('Synthetic test room cleanup could not be confirmed; it will expire automatically.'); process.exitCode = 1; }
  }
  for (const socket of sockets) socket.terminate();
}
