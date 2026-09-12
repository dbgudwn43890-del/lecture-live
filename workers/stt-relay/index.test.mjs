import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { bridge, control, upstreamRequest, validGrant, validFrame } from './index.mjs';
const BYTES_PER_SECOND = 32000;
const MAX_FRAME = 64000;

class Socket {
  listeners = new Map(); sent = []; closes = [];
  addEventListener(type, callback) { const listeners = this.listeners.get(type) ?? []; listeners.push(callback); this.listeners.set(type, listeners); }
  emit(type, data) { for (const callback of this.listeners.get(type) ?? []) callback(type === 'message' ? { data } : {}); }
  send(data) { if (this.closes.length) throw new Error('closed'); this.sent.push(data); }
  close(code = 1000, reason = '') { this.closes.push({ code, reason }); }
}
function fixture(options = {}) {
  let time = 0, sequence = 0;
  const intervals = new Map(), timeouts = new Map();
  const client = new Socket(), upstream = new Socket(), calls = [], waits = [];
  const timers = {
    setInterval(callback, delay) { const id = ++sequence; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) { const id = ++sequence; timeouts.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  const invoke = async (body) => {
    calls.push(body);
    if (body.action === 'close') return { closed: true };
    return options.invoke ? options.invoke(body) : { authorizedBytes: options.authorizedBytes ?? 1920000, leaseMs: 20000 };
  };
  const state = bridge({ client, upstream, configuration: { provider: options.provider ?? 'deepgram' },
    grant: options.grant ?? { baseBytes: 0, authorizedBytes: options.authorizedBytes ?? 1920000, leaseMs: 20000 },
    connectionId: 'connection', invoke, now: () => time, defer: (promise) => waits.push(promise), timers });
  return { client, upstream, calls, state, intervals, timeouts,
    setTime: value => { time = value; },
    tick: delay => { for (const entry of [...intervals.values()]) if (entry.delay === delay) entry.callback(); },
    send: size => client.emit('message', new ArrayBuffer(size)),
    settle: async () => { await state.settled(); await Promise.all(waits); },
  };
}
const configuration = { provider: 'deepgram', listenUrl: 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1' };
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
test('upstream permits only fixed provider hosts, TLS, and PCM configuration', () => {
  const request = upstreamRequest(configuration, 'test-secret');
  assert.equal(request.headers.get('authorization'), 'Token test-secret');
  for (const listenUrl of ['wss://attacker.example/v1/listen', 'ws://api.deepgram.com/v1/listen', 'wss://user:pass@api.deepgram.com/v1/listen', 'wss://api.deepgram.com:444/v1/listen', configuration.listenUrl.replace('16000','48000')]) {
    assert.throws(() => upstreamRequest({ ...configuration, listenUrl }, 'test-secret'));
  }
});
test('normal PCM and provider transcript pass without browser-configurable credentials', async () => {
  const f = fixture(); f.send(3200); await f.settle();
  assert.equal(f.upstream.sent[0].byteLength, 3200);
  f.upstream.emit('message', '{"type":"Results","text":"hello"}');
  assert.equal(f.client.sent.length, 1);
  f.client.emit('message', JSON.stringify({ type: 'KeepAlive', api_key: 'attacker', model: 'other' })); await f.settle();
  assert.equal(f.upstream.sent[1], '{"type":"KeepAlive"}');
});
test('text reconfiguration and binary flood are rejected before provider forwarding', async () => {
  for (const bad of ['{"api_key":"attacker"}', '{"type":"Configure"}', '{', 'x'.repeat(65)]) {
    const f = fixture(); f.client.emit('message', bad); await f.settle();
    assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4005);
  }
  for (const bytes of [0, 1, MAX_FRAME + 2]) {
    const f = fixture(); f.send(bytes); await f.settle();
    assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4005);
  }
  const f = fixture(); f.send(MAX_FRAME); f.send(2); await f.settle();
  assert.equal(f.upstream.sent.length, 0, 'queued flood closes before either queued frame is processed');
});
test('lease expiry blocks both audio and provider messages before watchdog runs', async () => {
  for (const direction of ['audio', 'result']) {
    const f = fixture(); f.setTime(20000);
    if (direction === 'audio') f.send(3200); else f.upstream.emit('message', '{"text":"late"}');
    await f.settle(); assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.sent.length, 0);
    assert.equal(f.client.closes[0].code, 4004);
  }
});
test('invalid initial grants fail closed, including NaN allowance comparisons', async () => {
  for (const grant of [
    { baseBytes: 0, leaseMs: 20000 }, { baseBytes: 0, authorizedBytes: NaN, leaseMs: 20000 },
    { baseBytes: 2, authorizedBytes: 0, leaseMs: 20000 }, { baseBytes: 0, authorizedBytes: 1920000, leaseMs: -1 },
    { baseBytes: 0, authorizedBytes: 1920000, leaseMs: Infinity }, { baseBytes: 0, authorizedBytes: 999999999, leaseMs: 20000 },
  ]) {
    assert.equal(validGrant(grant), false);
    const f = fixture({ grant }); f.send(3200); await f.settle();
    assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4004);
  }
});
test('low credits close fatally before any unpaid bytes reach provider', async () => {
  const f = fixture({ authorizedBytes: 3200, invoke: async () => { throw Object.assign(new Error('denied'), { code: 'NO_CREDITS' }); } });
  f.send(3200); await f.settle(); f.send(3200); await f.settle();
  assert.equal(f.upstream.sent.length, 1); assert.equal(f.upstream.sent[0].byteLength, 3200);
  assert.equal(f.client.closes[0].code, 4002); assert.equal(JSON.parse(f.client.sent[0]).type, 'LecueCreditExhausted');
  assert.equal(f.calls.at(-1).processedBytes, 3200);
});
test('ended sessions and lifetime limits are fatal instead of reconnect loops', async () => {
  for (const code of ['SESSION_ENDED', 'SESSION_NOT_RECORDING', 'SESSION_LIMIT']) {
    const f = fixture({ authorizedBytes: 0, invoke: async () => { throw Object.assign(new Error('denied'), { code }); } });
    f.send(3200); await f.settle(); assert.equal(f.client.closes[0].code, 4003); assert.equal(f.upstream.sent.length, 0);
  }
});
test('slow extension cannot renew past old lease or forward queued unpaid audio', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ authorizedBytes: 0, invoke: () => pending });
  f.send(3200); await Promise.resolve();
  f.setTime(20000); f.tick(500);
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4004);
});
test('five- and seven-second allowance requests retain normal PCM until authorization arrives', async () => {
  for (const delay of [5000, 7000]) {
    let resolve;
    const pending = new Promise(r => { resolve = r; });
    const f = fixture({ authorizedBytes: 3200, invoke: () => pending });
    f.send(3200); await f.settle();
    for (let frame = 1; frame <= delay / 100; frame++) {
      f.setTime(frame * 100); f.send(3200); await flush();
    }
    assert.equal(f.client.closes.length, 0, `${delay}ms is inside the control timeout`);
    assert.equal(f.upstream.sent.length, 1, 'queued PCM stays behind its unpaid allowance');
    resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
    assert.equal(f.client.closes.length, 0);
    assert.equal(f.upstream.sent.reduce((bytes, frame) => bytes + frame.byteLength, 0), (delay / 100 + 1) * 3200);
  }
});
test('the real eight-second control timeout closes without forwarding unpaid queued PCM', { timeout: 12000 }, async (t) => {
  let signal;
  const f = fixture({ authorizedBytes: 3200, invoke: body => control(
    { LECUE_ORIGIN: 'https://www.lecue.app', STT_RELAY_SECRET: 'x'.repeat(32) }, body,
    async (_url, init) => new Promise((_, reject) => {
      signal = init.signal;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ) });
  f.send(3200); await f.settle();
  const began = Date.now();
  f.send(3200); await flush();
  const timer = setInterval(() => {
    f.setTime(Date.now() - began); f.send(3200); f.tick(500);
  }, 100);
  t.after(() => clearInterval(timer));
  await f.settle();
  clearInterval(timer);
  await f.settle();
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'TimeoutError');
  assert.equal(f.client.closes[0].code, 4004, 'the control timeout, not the PCM queue, ends this connection');
  assert.equal(f.upstream.sent.filter(frame => frame instanceof ArrayBuffer).length, 1);
  assert.deepEqual(f.calls.at(-1), { action: 'close', connectionId: 'connection', processedBytes: 3200 });
});
test('a slow heartbeat and extension retain sixteen seconds of PCM without idling either provider', async () => {
  for (const provider of ['deepgram', 'soniox']) {
    let resolveHeartbeat, resolveExtension;
    const heartbeat = new Promise(r => { resolveHeartbeat = r; });
    const extension = new Promise(r => { resolveExtension = r; });
    const f = fixture({ provider, authorizedBytes: 3200, invoke: body => body.extend ? extension : heartbeat });
    f.setTime(9900); f.send(3200); await f.settle();
    let lastProviderMessage = 9900, sentCount = f.upstream.sent.length;
    f.setTime(10000); f.tick(10000); await flush();
    for (let frame = 1; frame <= 160; frame++) {
      const time = 10000 + frame * 100;
      f.setTime(time); f.send(3200); await flush(); f.tick(500);
      if (f.upstream.sent.length > sentCount) { lastProviderMessage = time; sentCount = f.upstream.sent.length; }
      assert.ok(time - lastProviderMessage < 10000, 'provider never reaches its idle timeout while PCM waits');
      if (frame === 80) {
        resolveHeartbeat({ authorizedBytes: 3200, leaseMs: 20000 }); await flush();
      }
    }
    assert.equal(f.client.closes.length, 0);
    assert.equal(f.upstream.sent.filter(frame => frame instanceof ArrayBuffer).length, 1, 'pending PCM remains unpaid until the extension succeeds');
    const keepalives = f.upstream.sent.filter(frame => typeof frame === 'string');
    assert.equal(keepalives.length, 4);
    assert.ok(keepalives.every(frame => frame === JSON.stringify({ type: provider === 'soniox' ? 'keepalive' : 'KeepAlive' })));
    assert.deepEqual(f.calls.filter(call => call.action === 'progress').map(call => call.extend), [false, true]);
    resolveExtension({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
    assert.equal(f.client.closes.length, 0);
    assert.equal(f.upstream.sent.filter(frame => frame instanceof ArrayBuffer).length, 161);
  }
});
test('allowance-wait keepalives stop at lease expiry without forwarding unpaid PCM', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ authorizedBytes: 0, invoke: () => pending });
  f.send(3200); await flush();
  f.setTime(4000); f.tick(500);
  f.setTime(8000); f.tick(500);
  assert.deepEqual(f.upstream.sent, ['{"type":"KeepAlive"}', '{"type":"KeepAlive"}']);
  f.setTime(20000); f.tick(500);
  assert.equal(f.client.closes[0].code, 4004);
  f.setTime(24000); f.tick(500);
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.upstream.sent.length, 2);
  assert.equal(f.calls.at(-1).processedBytes, 0);
});
test('graceful close keeps a pending allowance alive until queued PCM can be finalized', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ authorizedBytes: 0, invoke: () => pending });
  f.send(3200); await flush();
  f.client.emit('message', '{"type":"CloseStream"}');
  f.setTime(4000); f.tick(500);
  assert.deepEqual(f.upstream.sent, ['{"type":"KeepAlive"}']);
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.upstream.sent[1].byteLength, 3200);
  assert.equal(f.upstream.sent[2], '{"type":"CloseStream"}');
  f.setTime(8000); f.tick(500);
  assert.equal(f.upstream.sent.length, 3, 'no keepalive follows the actual CloseStream');
});
test('the PCM queue stays bounded at eighteen seconds even if a control response never settles', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ authorizedBytes: 0, invoke: () => pending });
  f.send(3200); await flush();
  for (let frame = 1; frame <= 180; frame++) {
    f.setTime(frame * 100); f.send(3200); await flush();
  }
  assert.equal(f.client.closes.length, 0);
  f.setTime(18100); f.send(3200); await flush();
  assert.equal(f.client.closes[0].code, 4005);
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.upstream.sent.length, 0);
});
test('control round-trip time is subtracted from renewed lease', async () => {
  const f = fixture({ invoke: async () => { f.setTime(18000); return { authorizedBytes: 1920000, leaseMs: 20000 }; } });
  f.setTime(10000); f.tick(10000); await f.settle();
  f.setTime(30000); f.send(3200); await f.settle();
  assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4004);
});
test('a slow heartbeat keeps forwarding prepaid real-time PCM without overflowing its queue', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ invoke: () => pending });
  f.setTime(10000); f.tick(10000); await flush();
  assert.equal(f.calls.filter(call => call.action === 'progress').length, 1);
  // 4.1 seconds of normal PCM exceeds MAX_QUEUE if a heartbeat blocks forwarding.
  for (let frame = 1; frame <= 41; frame++) {
    f.setTime(10000 + frame * 100); f.send(3200); await flush();
  }
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.client.closes.length, 0);
  assert.equal(f.upstream.sent.length, 41);
});
test('allowance extension waits for an in-flight heartbeat and never forwards unpaid PCM', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ authorizedBytes: 3200, invoke: body => body.extend ?
    { authorizedBytes: 6400, leaseMs: 20000 } : pending });
  f.send(3200); await f.settle();
  f.setTime(10000); f.tick(10000); await flush();
  f.setTime(10100); f.send(3200); await flush();
  assert.equal(f.calls.filter(call => call.action === 'progress').length, 1);
  assert.equal(f.upstream.sent.length, 1);
  resolve({ authorizedBytes: 3200, leaseMs: 20000 }); await f.settle();
  assert.deepEqual(f.calls.filter(call => call.action === 'progress').map(({ processedBytes, extend }) => ({ processedBytes, extend })),
    [{ processedBytes: 3200, extend: false }, { processedBytes: 3200, extend: true }]);
  assert.equal(f.upstream.sent.length, 2);
  assert.equal(f.client.closes.length, 0);
});
test('a slow initial handshake renews its shortened lease before the first periodic heartbeat', async () => {
  const f = fixture({ grant: { baseBytes: 0, authorizedBytes: 1920000, leaseMs: 6000 } });
  await f.settle();
  assert.equal(f.calls.filter(call => call.action === 'progress').length, 1);
  f.setTime(6000); f.tick(500); f.send(3200); await f.settle();
  assert.equal(f.client.closes.length, 0);
  assert.equal(f.upstream.sent.length, 1);
});
test('a pending heartbeat cannot revive the old lease when its watchdog is delayed', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ invoke: () => pending });
  f.setTime(10000); f.tick(10000); await flush();
  f.setTime(10100); f.send(3200); await flush();
  f.setTime(20000);
  resolve({ authorizedBytes: 1920000, leaseMs: 20000 }); await f.settle();
  assert.equal(f.client.closes[0].code, 4004);
  assert.equal(f.upstream.sent.length, 1);
  assert.deepEqual(f.calls.at(-1), { action: 'close', connectionId: 'connection', processedBytes: 3200 });
});
test('an expired local lease cannot make a progress renewal before delayed watchdog', async () => {
  const f = fixture(); f.setTime(21000); f.tick(10000); await f.settle();
  assert.equal(f.calls.filter(c => c.action === 'progress').length, 0);
  assert.equal(f.client.closes[0].code, 4004);
});
test('control failures and invalid renewed allowances stop rather than fail open', async () => {
  for (const invoke of [async () => { throw new Error('network'); }, async () => ({ authorizedBytes: '1920000', leaseMs: 20000 }), async () => ({ authorizedBytes: 1920000, leaseMs: 0 })]) {
    const f = fixture({ authorizedBytes: 0, invoke }); f.send(3200); await f.settle();
    assert.equal(f.upstream.sent.length, 0); assert.equal(f.client.closes[0].code, 4004);
  }
});
test('finish closes provider before releasing DB lease and sends exact processed bytes', async () => {
  const f = fixture(); f.send(3200); await f.settle(); f.state.finish(); f.send(3200); await f.settle();
  assert.equal(f.upstream.sent.length, 1); assert.equal(f.upstream.closes.length, 1);
  assert.deepEqual(f.calls.at(-1), { action: 'close', connectionId: 'connection', processedBytes: 3200 });
  assert.equal(f.intervals.size, 0);
});
test('server constructs Soniox keepalive and graceful close; rejects more audio after close', async () => {
  const f = fixture({ provider: 'soniox' });
  f.client.emit('message', '{"type":"KeepAlive"}'); await f.settle();
  f.client.emit('message', '{"type":"CloseStream"}'); f.send(3200); await f.settle();
  assert.deepEqual(f.upstream.sent, ['{"type":"keepalive"}', '']);
  assert.equal(f.timeouts.size, 1);
});
test('control requires fixed destination and long shared secret, propagating explicit rejection', async () => {
  let count = 0;
  const fetcher = async () => { count++; return Response.json({ error: 'NO_CREDITS' }, { status: 402 }); };
  await assert.rejects(control({ LECUE_ORIGIN: 'https://attacker.test', STT_RELAY_SECRET: 'x'.repeat(32) }, {}, fetcher));
  assert.equal(count, 0);
  await assert.rejects(control({ LECUE_ORIGIN: 'https://www.lecue.app', STT_RELAY_SECRET: 'x'.repeat(32) }, {}, fetcher), error => error.code === 'NO_CREDITS');
});
test('worker rejects unwanted origins, URL queries, and malformed tickets before control calls', async () => {
  for (const [url, headers, expected] of [
    ['https://relay.test/v1/listen', { Upgrade: 'websocket', Origin: 'https://attacker.test' }, 403],
    ['https://relay.test/v1/listen?api_key=bad', { Upgrade: 'websocket', Origin: 'https://www.lecue.app' }, 404],
    ['https://relay.test/v1/listen', { Upgrade: 'websocket', Origin: 'https://www.lecue.app', 'Sec-WebSocket-Protocol': 'lecue,bad' }, 401],
  ]) assert.equal((await worker.fetch(new Request(url, { headers }), {}, {})).status, expected);
});
test('PCM rate budget permits normal real-time audio but never arbitrary acceleration', () => {
  assert.equal(validFrame(BYTES_PER_SECOND, 0, 0), true);
  assert.equal(validFrame(BYTES_PER_SECOND, MAX_FRAME, 0), false);
  assert.equal(validFrame(BYTES_PER_SECOND, BYTES_PER_SECOND * 10, 10000), true);
});
