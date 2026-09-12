export type LiveAssistInput = {
  enabled: boolean;
  sessionId: string | null;
  status: string;
  segments: readonly { text: string }[];
  interim: string;
  locale: "ko" | "en";
  elapsedMs: number;
  conversation?: readonly LiveAssistConversationMessage[];
  materialRevision?: string;
  manualQuestionPending?: boolean;
};
export type LiveAssistConversationMessage = { role: "user" | "assistant"; content: string };
export type LiveAssistAnswer = { id: string; sessionId: string; text: string; pending: boolean; prompt: string };
export type LiveAssistState = {
  answers: LiveAssistAnswer[];
  phase: "off" | "listening" | "thinking" | "answering" | "error";
  error: string | null;
};
type LiveEvent = { decision: "wait" | "answer" } | { delta: string } | { done: true } | { error: string };
type Snapshot = { transcript: string; key: string; conversation: LiveAssistConversationMessage[]; contextKey: string };
const SETTLE_MS = 600;
const CADENCE_MS = 1_500;
// Short completed turns (or their final few words after WAIT) still need a
// decision. An arbitrary eight-character gate silently drops those requests.
const MIN_NEW_CHARACTERS = 2;
export const LIVE_TRANSCRIPT_CHARACTERS = 6_000;

/** Only submitted, completed chat is context; live answers already have their own history. */
export function buildLiveConversation(messages: readonly { role: "user" | "assistant"; text: string; pending?: boolean; kind?: string }[]): LiveAssistConversationMessage[] {
  const conversation: LiveAssistConversationMessage[] = [];
  let remaining = 6_000;
  for (let index = messages.length - 1; index >= 0 && conversation.length < 12 && remaining > 0; index--) {
    const message = messages[index];
    if (message.pending || message.kind === "live-assist") continue;
    const content = message.text.trim().slice(-remaining).trim();
    if (!content) continue;
    conversation.unshift({ role: message.role, content });
    remaining -= content.length;
  }
  return conversation;
}

/** A local invalidation hint, never a substitute for server-owned material lookup. */
export function buildLiveMaterialRevision(materials: readonly { id: string; session_id: string; created_at?: string }[], sessionId: string | null): string {
  return JSON.stringify(materials.filter((material) => material.session_id === sessionId)
    .map((material) => [material.id, material.created_at ?? ""]).sort(([left], [right]) => left.localeCompare(right)));
}

/** Formatting and sentence-final punctuation changes are not new speech. */
export function speechKey(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/[\s.,!?;:，。！？、]+/gu, "");
}

function suffixOverlap(previous: string, next: string): number {
  const prefix = new Array<number>(next.length).fill(0);
  for (let index = 1, matched = 0; index < next.length; index++) {
    while (matched && next[index] !== next[matched]) matched = prefix[matched - 1];
    if (next[index] === next[matched]) matched++;
    prefix[index] = matched;
  }
  let matched = 0;
  for (let index = 0; index < previous.length; index++) {
    const character = previous[index];
    while (matched && (matched === next.length || character !== next[matched])) matched = prefix[matched - 1];
    if (character === next[matched]) matched++;
  }
  return matched;
}

export function novelSpeech(previous: string, next: string): string {
  const before = speechKey(previous);
  const after = speechKey(next);
  if (!after || before === after || before.endsWith(after)) return "";
  if (after.startsWith(before)) return after.slice(before.length);
  let common = 0;
  while (common < before.length && before[common] === after[common]) common++;
  return after.slice(Math.max(common, suffixOverlap(before, after)));
}

function meaningfulSpeech(previous: string, next: Snapshot): boolean {
  const novel = novelSpeech(previous, next.key);
  if (novel.length >= MIN_NEW_CHARACTERS) return true;
  if (!novel) return false;
  return /[?？]\s*$/u.test(next.transcript);
}

export function buildLiveTranscript(segments: LiveAssistInput["segments"], interim: string, maxCharacters = LIVE_TRANSCRIPT_CHARACTERS): string {
  const tail: string[] = [];
  let length = interim.length;
  for (let index = segments.length - 1; index >= 0 && length < maxCharacters * 2; index--) {
    const text = segments[index].text.trim();
    if (text) { tail.unshift(text); length += text.length + 1; }
  }
  const finalText = tail.join("\n");
  let pending = interim.trim();
  const finalKey = speechKey(finalText);
  const pendingKey = speechKey(pending);
  if (pendingKey && finalKey.endsWith(pendingKey)) pending = "";
  else if (pendingKey) {
    const overlap = suffixOverlap(finalKey, pendingKey);
    const lastFinal = speechKey(tail.at(-1) ?? "");
    if (overlap >= 12 || (lastFinal && overlap === lastFinal.length)) {
      let removed = 0;
      let index = 0;
      for (const character of pending) {
        removed += speechKey(character).length;
        index += character.length;
        if (removed >= overlap) break;
      }
      pending = pending.slice(index).replace(/^[\s.,!?;:，。！？、]+/u, "");
    }
  }
  return [finalText, pending].filter(Boolean).join("\n").slice(-Math.max(1, maxCharacters));
}

export function parseRetryAfter(value: string | null, now = Date.now()): number {
  const seconds = value?.trim() ? Number(value) : NaN;
  const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(milliseconds) ? Math.max(1_000, Math.min(3_600_000, milliseconds)) : 3_000;
}

/** Decode split UTF-8/JSON frames and reject a silently truncated answer. */
export async function readLiveAssistStream(body: ReadableStream<Uint8Array>, onEvent: (event: LiveEvent) => void, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let complete = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const line = (value: string) => {
    if (!value.trim() || complete) return;
    const event: unknown = JSON.parse(value);
    if (!event || typeof event !== "object") throw new Error("Invalid live response");
    if ("error" in event && typeof event.error === "string") throw Object.assign(new Error(event.error.slice(0, 500)), { publicMessage: true });
    if ("decision" in event && (event.decision === "wait" || event.decision === "answer")) {
      onEvent({ decision: event.decision });
      if (event.decision === "wait") complete = true;
    } else if ("delta" in event && typeof event.delta === "string") onEvent({ delta: event.delta });
    else if ("done" in event && event.done === true) { onEvent({ done: true }); complete = true; }
    else throw new Error("Invalid live response");
  };
  try {
    while (!complete) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 64_000) throw new Error("Live response exceeds the processing limit");
      let newline;
      while (!complete && (newline = buffer.indexOf("\n")) >= 0) {
        line(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (done) { if (buffer.trim()) line(buffer); break; }
    }
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (!complete) throw new Error("Live response ended before completion");
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type ClientDependencies = {
  fetcher?: typeof fetch;
  now?: () => number;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  id?: () => string;
};

/** An in-memory controller: React updates it; no transcript polling is used. */
export function createLiveAssistController(dependencies: ClientDependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const now = dependencies.now ?? Date.now;
  const setTimer = dependencies.setTimer ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
  const clearTimer = dependencies.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const id = dependencies.id ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let state: LiveAssistState = { answers: [], phase: "off", error: null };
  let input: LiveAssistInput | null = null;
  let latest: Snapshot = { transcript: "", key: "", conversation: [], contextKey: "" };
  let consumed = "";
  let evaluatedContext = "";
  let lastDecision: "wait" | "answer" | null = null;
  let changedAt = 0;
  let firstChangedAt: number | null = null;
  let lastStartedAt = -Infinity;
  let timer: unknown = null;
  let request: AbortController | null = null;
  let epoch = 0;
  let stopped = false;
  let blocked = false;
  let permanentBlock = false;
  let failures = 0;
  let backoffUntil = 0;
  let forced = false;
  let retryAnswerId: string | null = null;
  let blockedError: string | null = null;
  const failedAnswers = new Set<string>();
  const emit = (patch: Partial<LiveAssistState>) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
  const recordingEligible = () => Boolean(!stopped && input?.enabled && input.sessionId && input.status === "recording");
  const eligible = () => recordingEligible() && !input?.manualQuestionPending;
  const needsDecision = () => meaningfulSpeech(consumed, latest)
    || (lastDecision === "wait" && Boolean(latest.key) && latest.contextKey !== evaluatedContext);
  const clearScheduled = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const finishPending = () => state.answers.flatMap((answer) => answer.pending
    ? answer.text.trim() ? [{ ...answer, pending: false }] : [] : [answer]);
  const cancel = () => {
    epoch++;
    request?.abort();
    request = null;
    clearScheduled();
    forced = false;
  };
  const idlePhase = (): LiveAssistState["phase"] => blocked && input?.enabled ? "error" : recordingEligible() ? "listening" : "off";

  function schedule() {
    clearScheduled();
    if (!forced && !needsDecision()) { firstChangedAt = null; return; }
    if (!eligible() || request || blocked) return;
    const settledAt = forced ? now() : Math.min(changedAt + SETTLE_MS, (firstChangedAt ?? changedAt) + 2_500);
    const due = Math.max(settledAt, lastStartedAt + CADENCE_MS, backoffUntil);
    timer = setTimer(() => { timer = null; void generate(); }, Math.max(0, due - now()));
  }

  async function generate() {
    if (!eligible() || request || blocked || !input?.sessionId || (!forced && !needsDecision())) return;
    const snapshot = latest;
    const sessionId = input.sessionId;
    const locale = input.locale;
    const requestEpoch = epoch;
    const aborter = new AbortController();
    request = aborter;
    forced = false;
    consumed = snapshot.key;
    evaluatedContext = snapshot.contextKey;
    lastDecision = null;
    firstChangedAt = null;
    lastStartedAt = now();
    let answerId = retryAnswerId;
    let decision: "wait" | "answer" | null = null;
    let text = "";
    const prompt = snapshot.transcript.slice(-500);
    const current = () => !stopped && epoch === requestEpoch && request === aborter && input?.sessionId === sessionId && input.enabled;
    const timeout = setTimer(() => aborter.abort(), 45_000);
    emit({ phase: "thinking", error: null });
    try {
      const response = await fetcher("/api/live-assist", {
        method: "POST", signal: aborter.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lectureSessionId: sessionId, transcript: snapshot.transcript,
          conversation: snapshot.conversation,
          previousAnswers: state.answers.filter((answer) => !answer.pending && answer.text.trim() && answer.id !== retryAnswerId && !failedAnswers.has(answer.id))
            .slice(-6).map((answer) => ({ prompt: answer.prompt.slice(-500), answer: answer.text.slice(0, 1_500) })),
          locale, minuteIndex: Math.min(179, Math.max(0, Math.floor(input.elapsedMs / 60_000))),
        }),
      });
      if (!current()) { await response.body?.cancel().catch(() => {}); return; }
      if (!response.ok) {
        let message = locale === "en" ? "Live assist is temporarily unavailable." : "실시간 답변을 잠시 가져오지 못했어요.";
        try { const result = await response.json(); if (typeof result?.error === "string") message = result.error.slice(0, 500); } catch { /* retain localized fallback */ }
        throw Object.assign(new Error(message), { status: response.status, retryAfter: parseRetryAfter(response.headers.get("Retry-After"), now()) });
      }
      if (!response.body) throw new Error(locale === "en" ? "No live answer was received." : "실시간 답변을 받지 못했어요.");
      await readLiveAssistStream(response.body, (event) => {
        if (!current()) return;
        if ("decision" in event) {
          decision = event.decision;
          if (decision === "answer") {
            answerId ??= `live-assist:${id()}`;
            const answer: LiveAssistAnswer = { id: answerId, sessionId, text: "", pending: true, prompt };
            emit({ answers: [...state.answers.filter((item) => item.id !== answerId), answer].slice(-20), phase: "answering" });
            for (const failedId of failedAnswers) if (!state.answers.some((item) => item.id === failedId)) failedAnswers.delete(failedId);
          }
        } else if ("delta" in event) {
          if (decision !== "answer" || !answerId) throw new Error("Invalid live response sequence");
          text += event.delta;
          if (text.length > 12_000) throw new Error("Live answer exceeds the processing limit");
          emit({ answers: state.answers.map((answer) => answer.id === answerId ? { ...answer, text } : answer), phase: "answering" });
        }
      }, aborter.signal);
      if (!current()) return;
      if (decision !== "wait" && !text.trim()) throw new Error(locale === "en" ? "No live answer was received." : "실시간 답변을 받지 못했어요.");
      lastDecision = decision;
      failures = 0;
      backoffUntil = 0;
      retryAnswerId = null;
      if (answerId) failedAnswers.delete(answerId);
      emit({ answers: finishPending(), phase: idlePhase(), error: null });
    } catch (caught) {
      if (!current()) return;
      const error = caught as Error & { status?: number; retryAfter?: number; publicMessage?: boolean };
      const permanent = [400, 401, 402, 403, 404, 409].includes(error.status ?? 0);
      if (error.status !== 429) failures++;
      retryAnswerId = answerId;
      if (answerId && text) failedAnswers.add(answerId);
      // Once text has been shown, retry only on explicit intent and reuse its
      // id, so an interrupted explanation cannot produce duplicate cards.
      blocked = permanent || Boolean(text) || (error.status !== 429 && failures > 3);
      permanentBlock = permanent;
      backoffUntil = now() + (error.status === 429 ? error.retryAfter ?? 3_000 : Math.min(4_000, 1_000 * 2 ** (failures - 1)));
      forced = !blocked;
      const message = error.name === "AbortError"
        ? locale === "en" ? "Live assist timed out. Please retry." : "실시간 답변이 지연됐어요. 다시 시도해 주세요."
        : (error.status || error.publicMessage) && error.message ? error.message
        : locale === "en" ? "Live assist is temporarily unavailable. Please retry." : "실시간 답변을 잠시 가져오지 못했어요. 다시 시도해 주세요.";
      blockedError = blocked ? message : null;
      emit({ answers: finishPending(), phase: "error", error: message });
    } finally {
      clearTimer(timeout);
      if (current()) { request = null; schedule(); }
    }
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() { stopped = false; },
    update(next: LiveAssistInput) {
      if (stopped) return;
      const previous = input;
      const wasRecordingEligible = recordingEligible();
      const previousKey = latest.key;
      const previousContextKey = latest.contextKey;
      input = next;
      // While off, keep only the latest input. Enabling rebuilds its baseline;
      // clock ticks and incoming speech need no parsing or React publication.
      if (!next.enabled && previous?.enabled === false && previous.sessionId === next.sessionId) return;
      const transcript = buildLiveTranscript(next.segments, next.interim);
      const conversation = buildLiveConversation((next.conversation ?? []).map((message) => ({ role: message.role, text: message.content })));
      latest = { transcript, key: speechKey(transcript), conversation, contextKey: JSON.stringify([conversation, next.materialRevision ?? ""]) };
      if (previous?.sessionId !== next.sessionId) {
        cancel(); blocked = false; permanentBlock = false; blockedError = null; failures = 0; retryAnswerId = null; backoffUntil = 0; lastStartedAt = -Infinity; failedAnswers.clear();
        consumed = latest.key; evaluatedContext = latest.contextKey; lastDecision = null; firstChangedAt = null;
        emit({ answers: [], error: null, phase: idlePhase() });
        return;
      }
      if (!next.enabled || !next.sessionId) {
        cancel(); consumed = latest.key; evaluatedContext = latest.contextKey; lastDecision = null; firstChangedAt = null;
        emit({ answers: finishPending(), phase: "off", error: null });
        return;
      }
      if (!previous?.enabled || (!wasRecordingEligible && recordingEligible())) {
        if (!permanentBlock) { blocked = false; blockedError = null; failures = 0; retryAnswerId = null; }
        consumed = latest.key; evaluatedContext = latest.contextKey; lastDecision = null; firstChangedAt = null; clearScheduled();
        if (!request) emit({ phase: idlePhase(), error: blocked ? blockedError : null });
        return;
      }
      if (!recordingEligible()) {
        clearScheduled(); consumed = latest.key; evaluatedContext = latest.contextKey; lastDecision = null; firstChangedAt = null;
        if (!request) emit({ phase: idlePhase() });
        return;
      }
      if ((latest.key !== previousKey && novelSpeech(previousKey, latest.key)) || latest.contextKey !== previousContextKey) {
        changedAt = now(); firstChangedAt ??= changedAt;
      }
      if (blocked && !permanentBlock && meaningfulSpeech(consumed, latest)) {
        blocked = false; blockedError = null; failures = 0; retryAnswerId = null;
        emit({ phase: "listening", error: null });
      }
      schedule();
    },
    retry() {
      if (!eligible() || request) return;
      blocked = false; permanentBlock = false; blockedError = null; failures = 0; forced = true;
      emit({ error: null, phase: "listening" });
      schedule();
    },
    dispose() {
      cancel(); stopped = true; input = null; consumed = ""; evaluatedContext = ""; lastDecision = null; firstChangedAt = null;
      emit({ answers: finishPending(), phase: "off" });
    },
  };
}
