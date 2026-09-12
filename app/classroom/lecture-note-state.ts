import type { LectureNote } from "../lib/lecture-note";
import type { NoteLanguage } from "../lib/note-language";

export type LectureNotePhase = "loading" | "none" | "generating" | "ready" | "failed" | "error";
export type LectureNoteState = {
  phase: LectureNotePhase;
  note: LectureNote | null;
  message: string;
  remaining: number | null;
  startedAt: string | null;
};

type NoteResponse = {
  note?: { status: string; content?: LectureNote | null; updated_at?: string | null } | null;
  remainingGenerations?: number | null;
  error?: string;
};

const POLL_INTERVAL = 3_000;
const REQUEST_CONFIRMATION_WINDOW = 30_000;

/** One session's controller outlives its dialog; the server is the source of job state. */
export function createLectureNoteController(
  sessionId: string | null,
  isEnglish: boolean,
  fetcher: typeof fetch = fetch,
) {
  const initial: LectureNoteState = { phase: sessionId ? "loading" : "none", note: null, message: "", remaining: null, startedAt: null };
  let state = initial;
  const listeners = new Set<() => void>();
  let active = false;
  let lifetime = 0;
  let readVersion = 0;
  let mutationVersion = 0;
  let reading: AbortController | null = null;
  let posting = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastUpdatedAt: string | null = null;
  let confirmation: { until: number; previousUpdatedAt: string | null; message: string } | null = null;

  const loadError = isEnglish ? "Could not load the note. Please try again." : "노트를 불러오지 못했습니다. 다시 확인해 주세요.";
  const pendingMessage = isEnglish
    ? "The connection was interrupted. Checking whether your note started; you do not need to start it again."
    : "연결이 끊겨 요청이 시작됐는지 확인하고 있습니다. 다시 생성할 필요는 없어요.";

  function schedulePoll() {
    if (!active || (state.phase !== "generating" && !confirmation)) {
      if (timer) clearTimeout(timer);
      timer = null;
      return;
    }
    if (!timer) timer = setTimeout(() => {
      timer = null;
      void reload();
    }, POLL_INTERVAL);
  }

  function publish(next: LectureNoteState) {
    state = next;
    listeners.forEach(listener => listener());
    schedulePoll();
  }

  function accept(data: NoteResponse) {
    const row = data.note;
    const updatedAt = row?.updated_at && Number.isFinite(Date.parse(row.updated_at)) ? row.updated_at : null;
    const remaining = typeof data.remainingGenerations === "number" ? data.remainingGenerations : state.remaining;
    // A lost POST can still be preparing its job. An unchanged GET must not announce
    // completion or let the user accidentally submit the same request again.
    if (confirmation && (!row || (row.status !== "generating" && updatedAt === confirmation.previousUpdatedAt))) {
      if (Date.now() < confirmation.until) {
        publish({ ...state, remaining, message: confirmation.message });
        return;
      }
      confirmation = null;
      publish({ ...state, remaining, phase: "error", startedAt: null, message: isEnglish
        ? "Could not confirm the request. Reload the note to check its status before trying again."
        : "요청 결과를 확인하지 못했습니다. 노트를 다시 불러와 상태를 확인해 주세요." });
      return;
    }
    if (confirmation && row?.status === "generating" && !updatedAt) {
      publish({ ...state, phase: "generating", note: row.content ?? state.note, remaining, message: confirmation.message });
      return;
    }
    confirmation = null;
    lastUpdatedAt = updatedAt;
    if (!row) {
      publish({ ...state, phase: "none", note: null, remaining, startedAt: null, message: "" });
    } else if (row.status === "generating") {
      publish({ ...state, phase: "generating", note: row.content ?? state.note, remaining,
        startedAt: updatedAt ?? state.startedAt, message: data.error ?? "" });
    } else if (row.status === "ready" && row.content) {
      publish({ phase: "ready", note: row.content, remaining, startedAt: null, message: "" });
    } else {
      publish({ ...state, phase: "failed", note: row.content ?? state.note, remaining, startedAt: null,
        message: data.error || (isEnglish ? "Could not create the note. Please try again." : "노트를 만들지 못했습니다. 다시 시도해 주세요.") });
    }
  }

  async function reload() {
    if (!active || !sessionId || posting) { schedulePoll(); return; }
    const owner = lifetime;
    const read = ++readVersion;
    const mutation = mutationVersion;
    reading?.abort();
    const request = new AbortController();
    reading = request;
    const isCurrent = () => active && owner === lifetime && read === readVersion && mutation === mutationVersion;
    try {
      const response = await fetcher(`/api/lecture-notes?sessionId=${encodeURIComponent(sessionId)}`, {
        headers: { "X-Site-Locale": isEnglish ? "en" : "ko" },
        cache: "no-store", signal: request.signal,
      });
      const data = await response.json() as NoteResponse;
      if (!isCurrent()) return;
      if (!response.ok) throw new Error(data.error || loadError);
      accept(data);
    } catch (error) {
      if (!isCurrent() || request.signal.aborted) return;
      const message = error instanceof Error && !(error instanceof TypeError) && error.message ? error.message : loadError;
      // A temporary read failure says nothing about the background job's outcome.
      publish({ ...state, phase: state.phase === "generating" ? "generating" : "error", message });
    } finally {
      if (reading === request) reading = null;
      if (isCurrent()) schedulePoll();
    }
  }

  async function generate(force: boolean, language?: NoteLanguage) {
    if (!active || !sessionId || posting || state.phase === "generating") return;
    const owner = lifetime;
    const mutation = ++mutationVersion;
    const previousUpdatedAt = lastUpdatedAt;
    const isCurrent = () => active && owner === lifetime && mutation === mutationVersion;
    ++readVersion;
    reading?.abort();
    posting = true;
    confirmation = null;
    publish({ ...state, phase: "generating", startedAt: null, message: "" });
    let checkServer = false;
    try {
      // The tiny submission can finish during navigation; accepted work runs on the server.
      const response = await fetcher("/api/lecture-notes", {
        method: "POST", headers: { "Content-Type": "application/json", "X-Site-Locale": isEnglish ? "en" : "ko" },
        body: JSON.stringify({ sessionId, force, ...(language ? { language } : {}) }), keepalive: true,
      });
      let data: NoteResponse;
      try { data = await response.json() as NoteResponse; }
      catch {
        // The server may already have accepted the job even if its response is incomplete.
        throw new Error("Unconfirmed response");
      }
      if (!isCurrent()) return;
      if (!response.ok) {
        publish({ ...state, phase: "failed", note: data.note?.content ?? state.note, startedAt: null,
          remaining: typeof data.remainingGenerations === "number" ? data.remainingGenerations : state.remaining,
          message: data.error || (isEnglish ? "Could not create the note." : "노트를 만들지 못했습니다.") });
        return;
      }
      accept(data.note ? data : { ...data, note: { status: "generating", updated_at: null } });
      checkServer = !data.note || data.note.status === "generating";
      if (response.status === 202 && !data.note?.updated_at) {
        // A duplicate claim may be acknowledged just before the job row is written.
        confirmation = { until: Date.now() + REQUEST_CONFIRMATION_WINDOW, previousUpdatedAt,
          message: isEnglish ? "Preparing your note…" : "노트 작성을 준비하고 있습니다." };
        publish({ ...state, message: confirmation.message });
      }
    } catch {
      if (!isCurrent()) return;
      confirmation = { until: Date.now() + REQUEST_CONFIRMATION_WINDOW, previousUpdatedAt,
        message: pendingMessage };
      publish({ ...state, phase: "generating", message: pendingMessage });
      checkServer = true;
    } finally {
      if (isCurrent()) {
        posting = false;
        if (checkServer) void reload();
        schedulePoll();
      }
    }
  }

  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    reload,
    generate,
    start() { active = true; ++lifetime; void reload(); },
    dispose() {
      active = false;
      ++lifetime;
      ++readVersion;
      ++mutationVersion;
      reading?.abort();
      reading = null;
      posting = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
