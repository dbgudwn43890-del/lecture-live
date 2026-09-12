export type LiveScriptSegment = { id: string; startMs: number; endMs: number; text: string };
export type LiveScriptInput = {
  sessionId: string | null;
  segments: readonly LiveScriptSegment[];
  status: string;
  locale: "ko" | "en";
};
export type LiveScriptEntry = { id: string; startMs: number; endMs: number; text: string; keywords: string[] };
export type LiveScriptState = {
  entries: LiveScriptEntry[];
  phase: "idle" | "waiting" | "processing" | "error";
  pending: boolean;
  error: string | null;
};
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Dependencies = {
  fetcher?: typeof fetch;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  storage?: () => StorageAccess | null;
};
type CachedSession = { key: string; at: number; entries: LiveScriptEntry[]; sources: string[][] };
export const LIVE_SCRIPT_CACHE_KEY = "lecue:live-script:v1";
const CACHE_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const CACHE_CHARACTERS = 2_000_000;
const FIRST_SETTLE_MS = 1_500;
const CADENCE_MS = 5_000;
const MAX_AUTOMATIC_RETRIES = 3;

// A deduplication checksum, not an authentication/security primitive. Segment
// IDs contain transcript snippets, so neither IDs nor raw text go into storage.
function fingerprint(value: string): string {
  let a = 0x243f6a88, b = 0x85a308d3, c = 0x13198a2e, d = 0x03707344;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x9e3779b1);
    b = Math.imul(b ^ code, 0x85ebca77);
    c = Math.imul(c ^ code, 0xc2b2ae3d);
    d = Math.imul(d ^ code, 0x27d4eb2f);
  }
  return [a, b, c, d].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}
const sourceKey = (segment: LiveScriptSegment) => fingerprint(segment.id) + fingerprint(JSON.stringify([segment.startMs, segment.endMs, segment.text]));
const validTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
function validEntry(value: unknown): value is LiveScriptEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as LiveScriptEntry;
  return typeof item.id === "string" && /^[a-f0-9]{32}$/.test(item.id)
    && validTime(item.startMs) && validTime(item.endMs) && item.endMs >= item.startMs
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 6_000
    && Array.isArray(item.keywords) && item.keywords.length <= 12
    && item.keywords.every((word) => typeof word === "string" && word.length <= 100);
}

/** Independent of recording transport and popover visibility: only final speech is processed. */
export function createLiveScriptController(dependencies: Dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const storage = dependencies.storage ?? (() => typeof window === "undefined" ? null : window.sessionStorage);
  const listeners = new Set<() => void>();
  let state: LiveScriptState = { entries: [], phase: "idle", pending: false, error: null };
  let input: LiveScriptInput | null = null;
  let consumed = new Set<string>();
  const rowSources = new Map<string, string[]>();
  const sourceRows = new Map<string, { key: string; rowId: string }>();
  const sourceChecksums = new WeakMap<LiveScriptSegment, { id: string; startMs: number; endMs: number; text: string; key: string }>();
  let queue: Array<{ segment: LiveScriptSegment; key: string }> = [];
  let timer: unknown = null;
  let request: AbortController | null = null;
  let epoch = 0;
  let stopped = false;
  let firstQueuedAt: number | null = null;
  let lastStartedAt = -Infinity;
  let backoffUntil = 0;
  let failures = 0;
  let blocked = false;
  let force = false;
  let flushRequested = false;
  const emit = (patch: Partial<LiveScriptState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const eligible = () => !stopped && Boolean(input?.sessionId) && ["recording", "paused", "ended", "error"].includes(input?.status ?? "");
  const flushing = () => ["paused", "ended", "error"].includes(input?.status ?? "");
  const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const cancel = () => { epoch++; request?.abort(); request = null; clearScheduled(); };
  const cacheKey = () => `${input?.sessionId}:${input?.locale}`;

  function readCache(): CachedSession[] {
    try {
      const raw = storage()?.getItem(LIVE_SCRIPT_CACHE_KEY);
      if (!raw || raw.length > CACHE_CHARACTERS) return [];
      const cached: unknown = JSON.parse(raw);
      if (!Array.isArray(cached) || cached.length > 3) return [];
      return cached.filter((entry): entry is CachedSession => entry && typeof entry === "object"
        && typeof entry.key === "string" && entry.key.length < 200 && validTime(entry.at)
        && entry.at <= now() && now() - entry.at < CACHE_LIFETIME_MS
        && Array.isArray(entry.entries) && entry.entries.length <= 3_600 && entry.entries.every(validEntry)
        && Array.isArray(entry.sources) && entry.sources.length === entry.entries.length
        && entry.sources.every((group: unknown) => Array.isArray(group) && group.length > 0 && group.length <= 16
          && group.every((key: unknown) => typeof key === "string" && /^[a-f0-9]{64}$/.test(key)))
        && entry.sources.flat().length <= 50_000);
    } catch { return []; }
  }

  function saveCache() {
    try {
      const store = storage();
      if (!store || !input?.sessionId) return;
      const others = readCache().filter((item) => item.key !== cacheKey());
      const current: CachedSession = { key: cacheKey(), at: now(), entries: state.entries,
        sources: state.entries.map((entry) => rowSources.get(entry.id) ?? []) };
      // Never trim the lecture in memory. If a very long lecture exceeds the
      // cache budget, discard its stale checkpoint instead of replaying it later.
      if (current.entries.length > 3_600 || consumed.size > 50_000 || JSON.stringify([current]).length > CACHE_CHARACTERS) {
        store.setItem(LIVE_SCRIPT_CACHE_KEY, JSON.stringify(others));
        return;
      }
      const sessions = [...others, current].slice(-3);
      while (sessions.length > 1 && JSON.stringify(sessions).length > CACHE_CHARACTERS) sessions.shift();
      store.setItem(LIVE_SCRIPT_CACHE_KEY, JSON.stringify(sessions));
    } catch { /* Private browsing, full storage and blocked storage must not affect recording. */ }
  }

  function refreshQueue() {
    const seen = new Set<string>();
    const candidates = (input?.segments ?? []).flatMap((segment) => {
      if (!segment.id || !segment.text.trim() || !validTime(segment.startMs) || !validTime(segment.endMs) || segment.endMs < segment.startMs) return [];
      const cached = sourceChecksums.get(segment);
      const key = cached && cached.id === segment.id && cached.startMs === segment.startMs && cached.endMs === segment.endMs && cached.text === segment.text
        ? cached.key : sourceKey(segment);
      if (!cached || cached.key !== key) sourceChecksums.set(segment, { ...segment, key });
      if (seen.has(segment.id)) return [];
      seen.add(segment.id);
      return [{ segment, key }];
    });
    // A restored transcript may have been corrected since the cache was made.
    // Invalidate only its affected passage, never replay unaffected passages.
    const invalidRows = new Set<string>();
    for (const { key } of candidates) {
      const previous = sourceRows.get(key.slice(0, 32));
      if (previous && previous.key !== key) invalidRows.add(previous.rowId);
    }
    if (invalidRows.size) {
      for (const rowId of invalidRows) {
        for (const key of rowSources.get(rowId) ?? []) { consumed.delete(key); sourceRows.delete(key.slice(0, 32)); }
        rowSources.delete(rowId);
      }
      emit({ entries: state.entries.filter((entry) => !invalidRows.has(entry.id)) });
      saveCache();
    }
    queue = candidates.filter(({ key }) => !consumed.has(key))
      .sort((left, right) => left.segment.startMs - right.segment.startMs || left.segment.endMs - right.segment.endMs);
    if (queue.length) firstQueuedAt ??= now();
    else firstQueuedAt = null;
  }

  function schedule() {
    clearScheduled();
    if (!eligible() || request || blocked || !queue.length) return;
    // Use the first queued time, not the latest update: continuous speech must
    // never postpone the initial request forever.
    const due = Math.max(backoffUntil, force || flushRequested ? now()
      : Math.max((firstQueuedAt ?? now()) + FIRST_SETTLE_MS, lastStartedAt + CADENCE_MS));
    timer = setTimer(() => { timer = null; void generate(); }, Math.max(0, due - now()));
  }

  async function generate() {
    if (!eligible() || request || blocked || !queue.length || !input?.sessionId) return;
    const batch: typeof queue = [];
    let characters = 0;
    for (const item of queue) {
      if (batch.length >= 16 || (batch.length > 0 && characters + item.segment.text.length > 2_400)) break;
      batch.push(item); characters += item.segment.text.length;
    }
    const segmentIds = batch.map(({ segment }) => segment.id);
    const sessionId = input.sessionId;
    const locale = input.locale;
    const requestEpoch = epoch;
    const aborter = new AbortController();
    request = aborter;
    lastStartedAt = now();
    force = false;
    flushRequested = false;
    const current = () => !stopped && requestEpoch === epoch && request === aborter
      && input?.sessionId === sessionId && input.locale === locale;
    const deadline = setTimer(() => aborter.abort(), 20_000);
    emit({ phase: "processing", pending: true, error: null });
    let onAbort: (() => void) | null = null;
    try {
      const operation = async () => {
        const response = await fetcher("/api/live-script", {
          method: "POST", signal: aborter.signal,
          headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
          body: JSON.stringify({ sessionId, segmentIds }),
        });
        if (aborter.signal.aborted || !current()) { await response.body?.cancel().catch(() => {}); throw new DOMException("Aborted", "AbortError"); }
        if (!response.ok) {
          const retryHeader = response.headers.get("Retry-After");
          const seconds = retryHeader?.trim() ? Number(retryHeader) : NaN;
          const retryMs = Number.isFinite(seconds) ? seconds * 1_000 : retryHeader ? Date.parse(retryHeader) - now() : 0;
          await response.body?.cancel().catch(() => {});
          throw Object.assign(new Error("Live script unavailable"), { status: response.status,
            retryMs: Number.isFinite(retryMs) ? Math.max(0, Math.min(3_600_000, retryMs)) : 0 });
        }
        return response.json() as Promise<unknown>;
      };
      const payload = await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DOMException("Aborted", "AbortError"));
        aborter.signal.addEventListener("abort", onAbort, { once: true });
      })]);
      if (!current()) return;
      if (!payload || typeof payload !== "object") throw new Error("Invalid live script response");
      const result = payload as { segmentIds?: unknown; startMs?: unknown; endMs?: unknown; text?: unknown; keywords?: unknown };
      if (!Array.isArray(result.segmentIds) || result.segmentIds.length !== segmentIds.length
        || new Set(result.segmentIds).size !== segmentIds.length || result.segmentIds.some((id) => !segmentIds.includes(id))) throw new Error("Mismatched source segments");
      const entry = { id: fingerprint(JSON.stringify(batch.map(({ key }) => key))), startMs: result.startMs,
        endMs: result.endMs, text: typeof result.text === "string" ? result.text.trim() : result.text, keywords: result.keywords };
      if (!validEntry(entry) || entry.startMs !== batch[0].segment.startMs
        || entry.endMs !== Math.max(...batch.map(({ segment }) => segment.endMs))) throw new Error("Invalid live script response");
      rowSources.set(entry.id, batch.map(({ key }) => key));
      for (const { key } of batch) { consumed.add(key); sourceRows.set(key.slice(0, 32), { key, rowId: entry.id }); }
      failures = 0; backoffUntil = 0;
      emit({ entries: [...state.entries, entry].sort((left, right) => left.startMs - right.startMs) });
      refreshQueue();
      emit({ pending: queue.length > 0, phase: queue.length ? "waiting" : "idle", error: null });
      saveCache();
    } catch (caught) {
      if (!current()) return;
      const error = caught as { status?: number; retryMs?: number; name?: string };
      failures++;
      const retryable = !error.status || error.status === 409 || error.status === 429 || error.status >= 500;
      blocked = !retryable || failures > MAX_AUTOMATIC_RETRIES;
      backoffUntil = now() + Math.max(error.retryMs ?? 0, Math.min(15_000, 1_000 * 2 ** (failures - 1)));
      const message = error.status === 401
        ? locale === "en" ? "Sign in again to continue the live script." : "실시간 스크립트를 이어 보려면 다시 로그인해 주세요."
        : error.status === 413
          ? locale === "en" ? "This speech segment is too long to process as a live script." : "이 발화는 너무 길어 실시간 스크립트로 처리할 수 없어요."
        : error.status === 409
          ? locale === "en" ? "Waiting for the latest speech to save. Please retry shortly." : "방금 들은 말이 저장되기를 기다리고 있어요. 잠시 후 다시 시도해 주세요."
          : error.status === 429
            ? locale === "en" ? "Live script requests are temporarily limited. Please retry shortly." : "실시간 스크립트 요청이 잠시 제한됐어요. 잠시 후 다시 시도해 주세요."
            : locale === "en" ? "The live script could not be updated. Please retry." : "실시간 스크립트를 갱신하지 못했어요. 다시 시도해 주세요.";
      emit({ phase: blocked ? "error" : "waiting", pending: true, error: blocked ? message : null });
    } finally {
      clearTimer(deadline);
      if (onAbort) aborter.signal.removeEventListener("abort", onAbort);
      if (current()) { request = null; schedule(); }
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { stopped = false; },
    update(next: LiveScriptInput) {
      if (stopped) return;
      const changedSession = next.sessionId !== input?.sessionId || next.locale !== input?.locale;
      const previousStatus = input?.status;
      const previousQueue = new Set(queue.map(({ key }) => key));
      input = next;
      if (changedSession) {
        cancel(); consumed = new Set(); rowSources.clear(); sourceRows.clear(); queue = []; failures = 0; blocked = false; force = false; flushRequested = false;
        backoffUntil = 0; firstQueuedAt = null; lastStartedAt = -Infinity;
        const cached = next.sessionId ? readCache().find((entry) => entry.key === cacheKey()) : null;
        consumed = new Set(cached?.sources.flat() ?? []);
        cached?.entries.forEach((entry, index) => {
          const keys = cached.sources[index];
          rowSources.set(entry.id, keys);
          for (const key of keys) sourceRows.set(key.slice(0, 32), { key, rowId: entry.id });
        });
        emit({ entries: cached?.entries ?? [], phase: "idle", pending: false, error: null });
      }
      refreshQueue();
      if (flushing() && (previousStatus !== next.status || queue.some(({ key }) => !previousQueue.has(key)))) flushRequested = true;
      if (!request) emit({ pending: eligible() && queue.length > 0,
        phase: blocked ? "error" : eligible() && queue.length ? "waiting" : "idle" });
      schedule();
    },
    retry() {
      if (!eligible() || request || !queue.length) return;
      blocked = false; failures = 0; force = true;
      emit({ error: null, phase: "waiting", pending: true });
      schedule();
    },
    dispose() {
      cancel(); stopped = true;
      emit({ phase: "idle", pending: false });
    },
  };
}
