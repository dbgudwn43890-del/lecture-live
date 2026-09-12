import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRecordingHeaders, readRelayUrl, runRecordingCheck } from './check-recording.mjs';

const appUrl = 'https://app.example/classroom';
const relayUrl = 'wss://relay.example/stream';
const healthUrl = 'https://relay.example/health';
const goodCsp = "default-src 'self'; script-src 'self'; worker-src 'self' blob:; connect-src 'self' wss://relay.example";
const staleCsp = goodCsp.replace(' wss://relay.example', '');
const headers = (csp = goodCsp, permissions) => new Headers({
  ...(csp === null ? {} : { 'content-security-policy': csp }),
  ...(permissions ? { 'permissions-policy': permissions } : {}),
});
const inspect = (csp, permissions) => inspectRecordingHeaders(headers(csp, permissions), appUrl, relayUrl).checks;
const healthy = () => Response.json({ service: 'lecue-stt-relay', status: 'ok' });

function fetchFixture(appResponses, healthResponse = healthy) {
  const pending = [...appResponses];
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, ...init });
    assert.equal(init.credentials, 'omit', 'preflight must never send session credentials');
    assert.equal(init.redirect, 'manual', 'redirect targets must be checked before fetching');
    const requestHeaders = new Headers(init.headers);
    assert.equal(requestHeaders.has('authorization'), false);
    assert.equal(requestHeaders.has('cookie'), false);
    if (target === healthUrl) {
      assert.equal(init.method, 'GET');
      return healthResponse();
    }
    const expected = pending.shift();
    assert.ok(expected, `Unexpected request: ${target}`);
    assert.equal(target, expected.url ?? appUrl);
    assert.equal(init.method, expected.method ?? 'HEAD');
    return expected.response;
  };
  return { fetcher, calls, pending };
}
const appResponse = (csp = goodCsp) => new Response(null, { headers: headers(csp) });

test('valid recording headers pass with or without explicit permissions', () => {
  for (const permissions of [undefined, 'microphone=(self), display-capture=(self)']) {
    const checks = inspect(goodCsp, permissions);
    assert.ok(checks.length > 0);
    assert.ok(checks.every((check) => check.ok), JSON.stringify(checks));
  }
});

for (const [name, csp, permissions] of [
  ['stale CSP missing relay origin', staleCsp],
  ['missing enforced CSP', null],
  ['second enforced policy blocks relay', `${goodCsp}, ${staleCsp}`],
  ['workers cannot load blobs', goodCsp.replace("worker-src 'self' blob:", "worker-src 'self'")],
  ['worklet script is blocked', goodCsp.replace("script-src 'self'", "script-src 'none'")],
  ['microphone is disabled', goodCsp, 'microphone=()'],
  ['display capture is disabled', goodCsp, 'display-capture=()'],
]) {
  test(name, () => assert.ok(inspect(csp, permissions).some((check) => !check.ok)));
}

test('report-only CSP cannot supply a missing enforced policy', () => {
  const checks = inspectRecordingHeaders(new Headers({ 'content-security-policy-report-only': goodCsp }), appUrl, relayUrl).checks;
  assert.ok(checks.some((check) => !check.ok));
});

for (const source of ['wss:', 'wss://*.example', 'wss://relay.example/stream']) {
  test(`existing CSP source ${source} permits the relay`, () => {
    assert.ok(inspect(goodCsp.replace('wss://relay.example', source)).every((check) => check.ok));
  });
}

test('worker-src uses child-src, script-src, then default-src fallback', () => {
  for (const csp of [
    goodCsp.replace('worker-src', 'child-src'),
    goodCsp.replace("worker-src 'self' blob:; ", '').replace("script-src 'self'", "script-src 'self' blob:"),
    "default-src 'self' blob:; connect-src 'self' wss://relay.example",
  ]) assert.ok(inspect(csp).every((check) => check.ok), csp);
});

test('preflight checks the app and relay without authentication', async () => {
  const fixture = fetchFixture([{ response: appResponse() }]);
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(result.appUrl, appUrl);
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.pending.length, 0);
});

for (const [name, healthResponse] of [
  ['invalid JSON', () => new Response('not json')],
  ['unhealthy status', () => Response.json({ service: 'lecue-stt-relay', status: 'down' })],
  ['wrong service', () => Response.json({ service: 'other-service', status: 'ok' })],
  ['unexpected 201 response', () => Response.json({ service: 'lecue-stt-relay', status: 'ok' }, { status: 201 })],
  ['non-200 response', () => Response.json({ service: 'lecue-stt-relay', status: 'ok' }, { status: 503 })],
]) {
  test(`relay health rejects ${name}`, async () => {
    const fixture = fetchFixture([{ response: appResponse() }], healthResponse);
    const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
    assert.equal(result.ok, false);
    assert.ok(result.checks.some((check) => !check.ok));
  });
}

test('oversized relay health JSON is rejected and its stream is cancelled', async () => {
  let cancelled = false;
  const oversized = new TextEncoder().encode(JSON.stringify({ service: 'lecue-stt-relay', status: 'ok', padding: 'x'.repeat(4096) }));
  const fixture = fetchFixture([{ response: appResponse() }], () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(oversized); },
    cancel() { cancelled = true; },
  })));
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => !check.ok && /4096/.test(check.message)));
  assert.equal(cancelled, true);
});

test('relay health redirects fail without following their target', async () => {
  const fixture = fetchFixture([{ response: appResponse() }], () => new Response(null, {
    status: 307, headers: { location: 'https://outside.example/health' },
  }));
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => !check.ok && /307/.test(check.message)));
  assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.calls.every((call) => call.url === appUrl || call.url === healthUrl));
});

for (const finalCsp of [goodCsp, staleCsp]) {
  test(`same-origin redirects inspect final ${finalCsp === goodCsp ? 'valid' : 'stale'} CSP`, async () => {
    const fixture = fetchFixture([
      { response: new Response(null, { status: 307, headers: { location: '/login', 'content-security-policy': finalCsp === goodCsp ? staleCsp : goodCsp } }) },
      { url: 'https://app.example/login', response: appResponse(finalCsp) },
    ]);
    const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
    assert.equal(result.ok, finalCsp === goodCsp, JSON.stringify(result.checks));
    assert.equal(result.appUrl, 'https://app.example/login');
    assert.equal(fixture.pending.length, 0);
  });
}

test('external redirect is rejected without fetching its target', async () => {
  const fixture = fetchFixture([{ response: new Response(null, { status: 302, headers: { location: 'https://outside.example/login' } }) }]);
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, false);
  assert.ok(fixture.calls.every((call) => call.url === appUrl || call.url === healthUrl));
});

test('same-origin redirect loops stop after at most five redirects', async () => {
  const fixture = fetchFixture(Array.from({ length: 6 }, () => ({
    response: new Response(null, { status: 307, headers: { location: '/classroom' } }),
  })));
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, false);
  assert.ok(fixture.calls.filter((call) => call.url === appUrl).length <= 6);
});

test('HEAD 405 falls back to GET and inspects its headers', async () => {
  const fixture = fetchFixture([
    { response: new Response(null, { status: 405 }) },
    { method: 'GET', response: appResponse() },
  ]);
  const result = await runRecordingCheck({ baseUrl: appUrl, relayUrl, fetcher: fixture.fetcher });
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  assert.equal(fixture.pending.length, 0);
});

test('readRelayUrl extracts only STT_RELAY_URL from env text', () => {
  for (const value of [relayUrl, `"${relayUrl}"`, `'${relayUrl}'`]) {
    assert.equal(readRelayUrl(`OTHER_SECRET=private-value\n# STT_RELAY_URL=wss://ignored.example\nSTT_RELAY_URL=${value}\nSTT_RELAY_SECRET=another-secret\n`), relayUrl);
  }
  assert.equal(readRelayUrl('STT_RELAY_SECRET=private-value\nOTHER_STT_RELAY_URL=wss://wrong.example'), undefined);
});

test('readRelayUrl uses the last active assignment', () => {
  assert.equal(readRelayUrl(`STT_RELAY_URL=wss://old.example/stream\nexport STT_RELAY_URL="${relayUrl}" # current\n# STT_RELAY_URL=wss://ignored.example\n`), relayUrl);
});
