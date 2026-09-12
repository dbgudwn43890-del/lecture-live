import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const PCM_BYTES_PER_SECOND = 32_000;
export const PCM_BYTES_PER_MINUTE = PCM_BYTES_PER_SECOND * 60;
export function newRelayTicket() { return randomBytes(32).toString('base64url'); }
export function relayTicketHash(ticket: string) { return createHash('sha256').update(ticket).digest('hex'); }
export function validRelaySecret(header: string | null, secret: string | undefined) {
  if (!secret || secret.length < 32 || !header?.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7)); const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function relayListenUrl() {
  const raw = process.env.STT_RELAY_URL;
  if (!raw) return null;
  try { const u = new URL(raw); return u.protocol === 'wss:' && !u.username && !u.password && !u.search ? u.href : null; }
  catch { return null; }
}
