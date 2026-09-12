export const PCM_BYTES_PER_SECOND = 32_000;
export const PCM_PENDING_MAX_MS = 30_000;
const MAX_PENDING_BYTES = PCM_BYTES_PER_SECOND * PCM_PENDING_MAX_MS / 1_000;
// The relay permits a two-second burst. Leave half a second for network jitter.
const BURST_BYTES = PCM_BYTES_PER_SECOND * 1.5;
const MAX_SOCKET_BYTES = PCM_BYTES_PER_SECOND;

/** Retain captured PCM through setup/outages, then send within the relay's rate budget. */
export class PcmSendQueue {
  private chunks: ArrayBuffer[] = [];
  private bytes = 0;
  private dropped = 0;
  private allowance = 0;
  private updatedAt = 0;

  get byteLength() { return this.bytes; }
  get durationMs() { return this.bytes * 1_000 / PCM_BYTES_PER_SECOND; }

  clear() {
    this.chunks = [];
    this.bytes = 0;
    this.dropped = 0;
    this.allowance = 0;
  }

  push(chunk: ArrayBuffer) {
    if (chunk.byteLength % 2) throw new Error("PCM samples must contain two bytes");
    if (!chunk.byteLength) return;
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    const overflow = Math.max(0, this.bytes - MAX_PENDING_BYTES);
    if (overflow) { this.remove(overflow); this.dropped += overflow; }
  }

  takeDroppedBytes() { const bytes = this.dropped; this.dropped = 0; return bytes; }
  discard() { this.dropped += this.bytes; this.chunks = []; this.bytes = 0; }

  startConnection(nowMs: number) { this.allowance = BURST_BYTES; this.updatedAt = nowMs; }

  drain(socket: { bufferedAmount: number; send(bytes: ArrayBuffer): void }, nowMs: number) {
    this.allowance = Math.min(BURST_BYTES, this.allowance + Math.max(0, nowMs - this.updatedAt) * PCM_BYTES_PER_SECOND / 1_000);
    this.updatedAt = nowMs;
    let sent = 0;
    while (this.chunks.length) {
      const first = this.chunks[0];
      const size = Math.floor(Math.min(first.byteLength, this.allowance, MAX_SOCKET_BYTES - socket.bufferedAmount) / 2) * 2;
      if (size <= 0) break;
      // Keep the frame queued if send throws during a socket transition.
      socket.send(size === first.byteLength ? first : first.slice(0, size));
      this.remove(size);
      this.allowance -= size;
      sent += size;
    }
    return sent;
  }

  private remove(bytes: number) {
    this.bytes -= bytes;
    while (bytes > 0) {
      const first = this.chunks[0];
      if (first.byteLength > bytes) { this.chunks[0] = first.slice(bytes); return; }
      this.chunks.shift();
      bytes -= first.byteLength;
    }
  }
}
