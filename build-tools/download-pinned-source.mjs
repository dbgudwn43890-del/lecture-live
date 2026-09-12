import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const TRANSIENT_CODES = new Set([
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
]);

function verifyArchive(archive, sha256) {
  if (createHash('sha256').update(archive).digest('hex') !== sha256) throw new Error('FFmpeg source checksum mismatch');
  return archive;
}

export async function downloadPinnedSource(url, sha256, { archivePath, fetcher = fetch, wait = sleep } = {}) {
  if (archivePath !== undefined) {
    let archive;
    try {
      archive = new Uint8Array(await readFile(archivePath));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    // Only an absent archive falls back to the network; a corrupt one fails closed.
    if (archive) return verifyArchive(archive, sha256);
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    let archive;
    const signal = AbortSignal.timeout(120_000);
    try {
      const response = await fetcher(url, { signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw Object.assign(new Error(`FFmpeg source download failed (${response.status})`), { status: response.status });
      }
      // A successful header does not guarantee that the archive body arrived.
      archive = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      const transient = error?.status === 429 || (error?.status >= 500 && error?.status <= 599)
        || error?.name === 'TimeoutError' || (signal.aborted && signal.reason?.name === 'TimeoutError')
        || TRANSIENT_CODES.has(error?.code) || TRANSIENT_CODES.has(error?.cause?.code);
      if (!transient || attempt === 3) throw error;
      console.warn(`FFmpeg source download interrupted; retrying (${attempt + 1}/3).`);
      await wait(attempt * 500);
      continue;
    }
    // Integrity failures are outside the retry boundary and always fail closed.
    return verifyArchive(archive, sha256);
  }
}
