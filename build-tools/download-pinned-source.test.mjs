import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadPinnedSource } from './download-pinned-source.mjs';

const bytes = new TextEncoder().encode('pinned test source');
const checksum = createHash('sha256').update(bytes).digest('hex');
const url = 'https://ffmpeg.org/releases/ffmpeg-test.tar.xz';
const success = () => new Response(bytes);
const socketError = () => Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } });

test('verifies optional local archives before any network request', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'lecue-pinned-source-test-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archivePath = join(directory, 'source.tar.xz');
  const corruptPath = join(directory, 'corrupt.tar.xz');
  await writeFile(archivePath, bytes);
  await writeFile(corruptPath, 'tampered archive');

  await context.test('returns valid local bytes without fetching', async () => {
    assert.deepEqual(await downloadPinnedSource(url, checksum, {
      archivePath,
      fetcher: async () => assert.fail('valid local archives must not fetch'),
    }), bytes);
  });

  await context.test('falls back to the network only when the archive is absent', async () => {
    let calls = 0;
    assert.deepEqual(await downloadPinnedSource(url, checksum, {
      archivePath: join(directory, 'missing.tar.xz'),
      fetcher: async () => { calls++; return success(); },
    }), bytes);
    assert.equal(calls, 1);
  });

  await context.test('rejects tampered local archives without fetching', async () => {
    await assert.rejects(downloadPinnedSource(url, checksum, {
      archivePath: corruptPath,
      fetcher: async () => assert.fail('checksum failures must not fetch'),
    }), /checksum mismatch/);
  });

  await context.test('propagates other local read errors without fetching', async () => {
    await assert.rejects(downloadPinnedSource(url, checksum, {
      archivePath: join(archivePath, 'invalid-child.tar.xz'),
      fetcher: async () => assert.fail('local read errors must not fetch'),
    }), { code: 'ENOTDIR' });
  });
});

test('retries a mid-body socket failure and verifies the complete next response', async () => {
  let calls = 0;
  const waits = [];
  const archive = await downloadPinnedSource(url, checksum, {
    fetcher: async (requested, options) => {
      assert.equal(requested, url);
      assert.ok(options.signal instanceof AbortSignal);
      calls++;
      return calls === 1 ? { ok: true, arrayBuffer: async () => { throw socketError(); } } : success();
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(archive, bytes);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [500]);
});

test('retries 429 and 5xx with short bounded backoff', async () => {
  const responses = [new Response('busy', { status: 429 }), new Response('unavailable', { status: 503 }), success()];
  const waits = [];
  const archive = await downloadPinnedSource(url, checksum, {
    fetcher: async () => responses.shift(),
    wait: async (milliseconds) => { waits.push(milliseconds); },
  });
  assert.deepEqual(archive, bytes);
  assert.deepEqual(waits, [500, 1000]);
  assert.equal(responses.length, 0);
});

test('stops after three transient failures', async () => {
  let calls = 0;
  let waits = 0;
  await assert.rejects(downloadPinnedSource(url, checksum, {
    fetcher: async () => { calls++; throw socketError(); }, wait: async () => { waits++; },
  }), { cause: { code: 'UND_ERR_SOCKET' } });
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('does not retry checksum mismatches or return unverified bytes', async () => {
  let calls = 0;
  await assert.rejects(downloadPinnedSource(url, checksum, {
    fetcher: async () => { calls++; return new Response('tampered archive'); },
    wait: async () => assert.fail('checksum failures must not retry'),
  }), /checksum mismatch/);
  assert.equal(calls, 1);
});

test('fails immediately for permanent HTTP and certificate errors', async () => {
  for (const failure of [new Response('missing', { status: 404 }), Object.assign(new TypeError('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } })]) {
    let calls = 0;
    await assert.rejects(downloadPinnedSource(url, checksum, {
      fetcher: async () => { calls++; if (failure instanceof Error) throw failure; return failure; },
      wait: async () => assert.fail('permanent failures must not retry'),
    }));
    assert.equal(calls, 1);
  }
});

test('retries a timed-out fetch without extending the three-attempt limit', async () => {
  let calls = 0;
  assert.deepEqual(await downloadPinnedSource(url, checksum, {
    fetcher: async () => { if (++calls === 1) throw new DOMException('Timed out', 'TimeoutError'); return success(); },
    wait: async () => {},
  }), bytes);
  assert.equal(calls, 2);
});

test('retries a body AbortError caused by the attempt timeout', async (context) => {
  const controller = new AbortController();
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  let signals = 0;
  context.mock.method(AbortSignal, 'timeout', () => ++signals === 1 ? controller.signal : new AbortController().signal);
  let calls = 0;
  assert.deepEqual(await downloadPinnedSource(url, checksum, {
    fetcher: async () => ++calls === 1
      ? { ok: true, arrayBuffer: async () => { throw new DOMException('Aborted', 'AbortError'); } }
      : success(),
    wait: async () => {},
  }), bytes);
  assert.equal(calls, 2);
});
