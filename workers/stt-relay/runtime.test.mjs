// Optional actual workerd smoke. Install miniflare outside the repo and supply
// MINIFLARE_MODULE=/absolute/path/node_modules/miniflare/dist/src/index.js.
// STT_RELAY_LONG_SMOKE=1 additionally exercises 65 seconds of real-time PCM.
// STT_RELAY_QUEUE_SMOKE=1 exercises retained startup/reconnect PCM through real sockets.
// STT_RELAY_CONTROL_SMOKE=1 delays allowance authorization for seven seconds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const runtimeModule = process.env.MINIFLARE_MODULE;
const longSmoke = process.env.STT_RELAY_LONG_SMOKE === '1';
const queueSmoke = process.env.STT_RELAY_QUEUE_SMOKE === '1';
const controlSmoke = process.env.STT_RELAY_CONTROL_SMOKE === '1';
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Socket event timeout')), 4000); })]); }
  finally { clearTimeout(timer); }
}
test(controlSmoke ? 'actual workerd keeps the provider alive and retains PCM during a seven-second allowance request' :
  queueSmoke ? 'actual workerd receives every retained PCM byte after 5-second setup and 10-second reconnect delay' :
  longSmoke ? 'actual workerd forwards 65 seconds of PCM through lease renewals and allowance extension' :
  'actual workerd WebSocket survives its handshake timeout and closes on credit exhaustion', { skip: !runtimeModule, timeout: longSmoke ? 85000 : 30000 }, async () => {
  const { Miniflare } = await import(pathToFileURL(runtimeModule).href);
  const { WebSocketServer } = createRequire(pathToFileURL(runtimeModule))('ws');
  const provider = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => provider.once('listening', resolve));
  provider.on('connection', socket => socket.on('message', (data, binary) => {
    if (binary) socket.send(JSON.stringify({ type: 'FixtureResults', bytes: data.byteLength }));
    else if (controlSmoke && data.toString() === '{"type":"KeepAlive"}') socket.send(JSON.stringify({ type: 'FixtureKeepalive' }));
    else if (queueSmoke && data.toString() === '{"type":"CloseStream"}') socket.close(1000, 'All PCM received');
  }));
  const port = provider.address().port;
  const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
  // No external fetch is possible: every upstream and control call is handled
  // by this local fixture, with no production credential or data. A real local
  // upgrade preserves workerd's AbortSignal behavior, unlike a mocked Response.
  const mockNetwork = `
  const networkFetch = globalThis.fetch.bind(globalThis);
  let authorizedBytes = ${longSmoke || queueSmoke ? 1920000 : 3200};
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://www.lecue.app' && url.pathname === '/api/stt/relay') {
      const body = await request.json();
      if (body.action === 'open') return Response.json({
        configuration: { provider: 'deepgram', listenUrl: 'wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1' },
        providerKey: 'synthetic-only', baseBytes: 0, authorizedBytes, leaseMs: 20000,
      });
      if (body.action === 'close') return Response.json({ closed: true });
      if (${longSmoke || queueSmoke || controlSmoke}) {
        if (${controlSmoke} && body.extend) await new Promise(resolve => setTimeout(resolve, 7000));
        if (body.extend) authorizedBytes += 1920000;
        return Response.json({ authorizedBytes, leaseMs: 20000 });
      }
      return Response.json({ error: 'NO_CREDITS' }, { status: 402 });
    }
    if (url.hostname === 'api.deepgram.com') {
      return networkFetch(new Request('http://127.0.0.1:${port}', request), init);
    }
    throw new Error('Unexpected network destination');
  };
  `;
  const runtime = new Miniflare({ modules: true, script: mockNetwork + source,
    compatibilityDate: '2026-08-06',
    bindings: { LECUE_ORIGIN: 'https://www.lecue.app', STT_RELAY_SECRET: 'x'.repeat(32) },
  });
  try {
    if (queueSmoke) {
      const { PcmSendQueue } = await import('../../app/lib/pcm-send-queue.ts');
      for (const pendingSeconds of [5, 10]) {
        const queue = new PcmSendQueue();
        // Synthesize already-captured startup/outage samples; socket pacing
        // below uses real elapsed time and the production Worker rate guard.
        for (let frame = 0; frame < pendingSeconds * 10; frame++) queue.push(new ArrayBuffer(3200));
        const response = await runtime.dispatchFetch('http://relay.test/v1/listen', { headers: {
          Upgrade: 'websocket', Origin: 'https://www.lecue.app', 'Sec-WebSocket-Protocol': 'lecue,' + 't'.repeat(43),
        } });
        assert.equal(response.status, 101);
        const socket = response.webSocket;
        socket.accept();
        let receivedBytes = 0;
        socket.addEventListener('message', event => {
          const message = JSON.parse(event.data);
          if (message.type === 'FixtureResults') receivedBytes += message.bytes;
        });
        const closed = new Promise(resolve => socket.addEventListener('close', event => resolve(event.code)));
        queue.startConnection(performance.now());
        while (queue.byteLength) {
          queue.drain({ bufferedAmount: 0, send: bytes => socket.send(bytes) }, performance.now());
          if (queue.byteLength) await new Promise(resolve => setTimeout(resolve, 50));
        }
        assert.equal(queue.takeDroppedBytes(), 0);
        socket.send('{"type":"CloseStream"}');
        assert.equal(await bounded(closed), 1000);
        assert.equal(receivedBytes, pendingSeconds * 32000);
      }
      return;
    }
    const response = await runtime.dispatchFetch('http://relay.test/v1/listen', { headers: {
      Upgrade: 'websocket', Origin: 'https://www.lecue.app', 'Sec-WebSocket-Protocol': 'lecue,' + 't'.repeat(43),
    } });
    assert.equal(response.status, 101);
    assert.equal(response.headers.get('Sec-WebSocket-Protocol'), 'lecue');
    const socket = response.webSocket;
    socket.accept();
    const messages = [];
    let nextResult;
    const first = new Promise(resolve => { nextResult = resolve; });
    socket.addEventListener('message', event => { const data = JSON.parse(event.data); messages.push(data); if (data.type === 'FixtureResults') nextResult(data); });
    const closed = new Promise(resolve => socket.addEventListener('close', event => resolve(event.code)));
    socket.send(new ArrayBuffer(3200));
    assert.deepEqual(await bounded(first), { type: 'FixtureResults', bytes: 3200 });
    if (controlSmoke) {
      for (let frame = 1; frame <= 80; frame++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        socket.send(new ArrayBuffer(3200));
      }
      for (let attempt = 0; attempt < 20 && messages.filter(message => message.type === 'FixtureResults').length < 81; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.equal(messages.filter(message => message.type === 'FixtureResults').length, 81);
      assert.ok(messages.some(message => message.type === 'FixtureKeepalive'));
      socket.close(1000, 'Fixture complete');
      assert.equal(await bounded(closed), 1000);
      return;
    }
    if (longSmoke) {
      for (let frame = 1; frame < 650; frame++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const result = new Promise(resolve => { nextResult = resolve; });
        socket.send(new ArrayBuffer(3200));
        assert.deepEqual(await bounded(result), { type: 'FixtureResults', bytes: 3200 });
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(messages.filter(message => message.type === 'FixtureResults').length, 650);
      socket.close(1000, 'Fixture complete');
      assert.equal(await bounded(closed), 1000);
      return;
    }
    // The original fetch timeout must stop governing the established socket.
    await new Promise(resolve => setTimeout(resolve, 8500));
    socket.send(new ArrayBuffer(3200));
    assert.equal(await bounded(closed), 4002);
    assert.equal(messages.filter(message => message.type === 'FixtureResults').length, 1);
    assert.equal(messages.filter(message => message.type === 'LecueCreditExhausted').length, 1);
  } finally {
    await runtime.dispose();
    for (const socket of provider.clients) socket.terminate();
    await new Promise(resolve => provider.close(resolve));
  }
});
