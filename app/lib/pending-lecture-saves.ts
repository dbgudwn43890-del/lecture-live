export type PendingLectureSave = {
  sessionId: string;
  durationMs: number;
  segments: { id: string; startMs: number; endMs: number; text: string }[];
};

/** Each retry owns an immutable lecture snapshot, never the current screen's state. */
export class PendingLectureSaves {
  private pending = new Map<string, PendingLectureSave>();
  private inFlight = new Set<string>();

  add(value: PendingLectureSave) {
    this.pending.set(value.sessionId, structuredClone(value));
  }

  ids() { return [...this.pending.keys()]; }

  async save(sessionId: string, send: (value: PendingLectureSave) => Promise<boolean>) {
    const value = this.pending.get(sessionId);
    if (!value || this.inFlight.has(sessionId)) return false;
    this.inFlight.add(sessionId);
    try {
      const saved = await send(value);
      if (saved && this.pending.get(sessionId) === value) this.pending.delete(sessionId);
      return saved;
    } finally {
      this.inFlight.delete(sessionId);
    }
  }
}
