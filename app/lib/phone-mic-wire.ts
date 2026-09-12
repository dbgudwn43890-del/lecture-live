/** Volatile, acknowledged PCM only; no audio goes to browser storage. */
export const PHONE_PCM_MAX_PENDING = 160_000;
export const PHONE_PCM_MAX_FRAME = 8_192;
export const PHONE_RECONNECT_GRACE_MS = 5_000;
export type PhoneFrame = { captureId: number; sequence: number; pcm: ArrayBuffer };
const uint = (value: number) => Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

export function encodePhoneFrame(captureId: number, sequence: number, pcm: ArrayBuffer): ArrayBuffer {
  if (!uint(captureId) || captureId === 0 || !uint(sequence) || !pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > PHONE_PCM_MAX_FRAME) throw new Error("Invalid phone audio frame");
  const frame = new ArrayBuffer(pcm.byteLength + 8), view = new DataView(frame);
  view.setUint32(0, captureId, true); view.setUint32(4, sequence, true);
  new Uint8Array(frame, 8).set(new Uint8Array(pcm));
  return frame;
}

export function decodePhoneFrame(frame: ArrayBuffer): PhoneFrame | null {
  if (frame.byteLength < 10 || frame.byteLength > PHONE_PCM_MAX_FRAME + 8 || frame.byteLength % 2) return null;
  const view = new DataView(frame), captureId = view.getUint32(0, true);
  return captureId ? { captureId, sequence: view.getUint32(4, true), pcm: frame.slice(8) } : null;
}

export class PhonePcmReplay {
  private frames: Array<{ sequence: number; frame: ArrayBuffer }> = [];
  private next = 0;
  private bytes = 0;
  readonly captureId: number;
  constructor(captureId: number) { this.captureId = captureId; }
  get pendingBytes() { return this.bytes; }
  push(pcm: ArrayBuffer) {
    if (this.bytes + pcm.byteLength > PHONE_PCM_MAX_PENDING) throw new Error("BUFFER_FULL");
    if (!pcm.byteLength || pcm.byteLength % 2) throw new Error("Invalid phone audio frame");
    for (let offset = 0; offset < pcm.byteLength; offset += PHONE_PCM_MAX_FRAME) {
      const piece = pcm.slice(offset, offset + PHONE_PCM_MAX_FRAME);
      const sequence = this.next++;
      this.frames.push({ sequence, frame: encodePhoneFrame(this.captureId, sequence, piece) });
      this.bytes += piece.byteLength;
    }
  }
  acknowledge(sequence: number) {
    if (!uint(sequence) || sequence >= this.next) return;
    while (this.frames.length && this.frames[0].sequence <= sequence) this.bytes -= this.frames.shift()!.frame.byteLength - 8;
  }
  after(sequence: number) { return this.frames.filter(frame => frame.sequence > sequence); }
  clear() { this.frames = []; this.bytes = 0; }
}

export function phoneSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export function validPhoneRoom(value: string | null): value is string { return typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value); }
export function validPhoneSecret(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
