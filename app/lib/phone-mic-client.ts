import type { ExternalPcmSource } from "./external-pcm";
import { createPcmRecorder, type PcmRecorder } from "../classroom/pcm-recorder";
import { decodePhoneFrame, PhonePcmReplay, phoneSecret, validPhoneRoom, validPhoneSecret, PHONE_RECONNECT_GRACE_MS } from "./phone-mic-wire";

type Locale = "ko" | "en";
type Control = Record<string, unknown> & { type: string };
export type PhonePhase = "idle" | "connecting" | "waiting" | "ready" | "recording" | "paused" | "reconnecting" | "ended" | "error";
export type PhoneState = { phase: PhonePhase; error: string | null; level: number; elapsedMs: number };
export type PhonePair = { roomId: string; ownerToken: string; inviteToken: string; relayUrl: string; inviteExpiresAt: string; expiresAt: string };
const message = (locale: Locale, ko: string, en: string) => locale === "ko" ? ko : en;
const connectionMessage = (locale: Locale) => message(locale, "휴대폰 연결이 끊겼어요. 휴대폰 화면에서 다시 연결한 뒤 이어하기를 눌러 주세요.", "The phone disconnected. Reconnect on your phone, then press Resume on your laptop.");
const closedMessage = (locale: Locale) => message(locale, "연결이 끝났어요. 노트북에서 새 QR을 열어 주세요.", "This connection has ended. Open a new QR code on your laptop.");
const validCapture = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;

function store<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  return { getSnapshot: () => state, subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    set(patch: Partial<T>) { state = { ...state, ...patch }; listeners.forEach(fn => fn()); } };
}

function validRelay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "wss:" || (url.protocol === "ws:" && ["localhost", "127.0.0.1"].includes(url.hostname)); } catch { return false; }
}
async function api(body: Record<string, unknown>, locale: Locale, signal?: AbortSignal) {
  const response = await fetch("/api/phone-mic", { method: "POST", headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000), cache: "no-store" });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error.slice(0, 300) : connectionMessage(locale));
  return result;
}

/** Tokens travel in subprotocols, never request URLs. Every reconnect has one socket. */
class PhoneSocket {
  private url: string;
  private role: "owner" | "phone";
  private token: string;
  private handlers: { control(value: Control): void; binary(value: ArrayBuffer): void; connected(value: boolean): void; unavailable(terminal: boolean): void };
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval>;
  private stopped = false;
  private receivedAt = Date.now();
  private lostAt: number | null = Date.now();
  private reportedLost = false;
  constructor(url: string, role: "owner" | "phone", token: string,
    handlers: { control(value: Control): void; binary(value: ArrayBuffer): void; connected(value: boolean): void; unavailable(terminal: boolean): void }) {
    this.url = url; this.role = role; this.token = token; this.handlers = handlers;
    this.heartbeat = setInterval(() => {
      if (this.connected && Date.now() - this.receivedAt > 6_000) this.socket?.close();
      this.send({ type: "ping" });
      if (this.lostAt !== null && Date.now() - this.lostAt >= PHONE_RECONNECT_GRACE_MS && !this.reportedLost) {
        this.reportedLost = true; this.handlers.unavailable(false);
      }
    }, 1_000);
    this.open();
  }
  get connected() { return this.socket?.readyState === WebSocket.OPEN; }
  get bufferedAmount() { return this.socket?.bufferedAmount ?? Infinity; }
  send(value: Control | ArrayBuffer): boolean {
    if (!this.connected || this.bufferedAmount > 64_000) return false;
    try { this.socket!.send(value instanceof ArrayBuffer ? value : JSON.stringify(value)); return true; } catch { this.socket?.close(); return false; }
  }
  private open() {
    if (this.stopped) return;
    const socket = new WebSocket(this.url, ["lecue-phone", this.role, this.token]);
    socket.binaryType = "arraybuffer"; this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket || this.stopped) { socket.close(); return; }
      this.receivedAt = Date.now(); this.lostAt = null; this.reportedLost = false;
      this.send({ type: "ping" });
      this.handlers.connected(true);
    };
    socket.onmessage = event => {
      if (this.socket !== socket || this.stopped) return;
      this.receivedAt = Date.now();
      if (event.data instanceof ArrayBuffer) { this.handlers.binary(event.data); return; }
      if (typeof event.data !== "string" || event.data.length > 2048) { socket.close(4000, "Invalid message"); return; }
      try {
        const value = JSON.parse(event.data);
        if (!value || typeof value.type !== "string") throw new Error();
        if (value.type !== "pong") this.handlers.control(value);
      } catch { socket.close(4000, "Invalid message"); }
    };
    socket.onerror = () => { /* close drives one reconnection path */ };
    socket.onclose = event => {
      if (this.socket !== socket || this.stopped) return;
      this.socket = null; this.lostAt ??= Date.now(); this.handlers.connected(false);
      if (event.code >= 4000 || event.code === 1000) { this.handlers.unavailable(true); this.close(); return; }
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open(); }, 750);
    };
  }
  close() {
    this.stopped = true; clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const socket = this.socket; this.socket = null;
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); }
  }
}

export async function createDesktopPhoneMic(locale: Locale, onPause: () => void) {
  const pair = await api({ action: "create" }, locale) as PhonePair;
  if (!validPhoneRoom(pair.roomId) || !validPhoneSecret(pair.ownerToken) || !validPhoneSecret(pair.inviteToken) || !validRelay(pair.relayUrl)) throw new Error(connectionMessage(locale));
  const state = store<PhoneState>({ phase: "waiting", error: null, level: 0, elapsedMs: 0 });
  let disposed = false, ready = false, reconnectAt: number | null = null;
  let captureId = 0, nextSequence = 0;
  let receive: ((bytes: ArrayBuffer) => void) | null = null, ended: (() => void) | null = null;
  type Ack = { captureId: number; resolve(): void; reject(error: Error): void };
  let startAck: Ack | null = null, stopAck: Ack | null = null;
  const notifyEnded = () => { const fn = ended; ended = null; fn?.(); };
  const fail = (terminal: boolean) => {
    if (disposed) return;
    ready = false;
    receive = null;
    startAck?.reject(new Error(connectionMessage(locale)));
    stopAck?.reject(new Error(connectionMessage(locale)));
    state.set({ phase: terminal ? "ended" : "error", error: terminal ? closedMessage(locale) : connectionMessage(locale), level: 0 });
    notifyEnded();
  };
  const link = new PhoneSocket(pair.relayUrl, "owner", pair.ownerToken, {
    connected(connected) { if (!connected) { reconnectAt ??= Date.now(); state.set({ phase: "reconnecting" }); } },
    unavailable: fail,
    control(value) {
      if (value.type === "ready") { ready = true; reconnectAt = null; state.set({ phase: captureId ? "recording" : "ready", error: null }); }
      if ((value.type === "peer" && value.connected === false) || (value.type === "hello" && value.peerConnected === false && ready)) {
        reconnectAt ??= Date.now(); state.set({ phase: "reconnecting" });
      }
      if (value.type === "started" && value.captureId === startAck?.captureId) startAck?.resolve();
      if (value.type === "stopped" && value.captureId === stopAck?.captureId) stopAck?.resolve();
      if (value.type === "pause") onPause();
      if (value.type === "error") fail(false);
    },
    binary(value) {
      const frame = decodePhoneFrame(value);
      if (!frame) { fail(false); return; }
      if (frame.captureId !== captureId || !receive) return;
      if (frame.sequence > nextSequence) { fail(false); return; }
      if (frame.sequence === nextSequence) { nextSequence++; receive(frame.pcm); }
      link.send({ type: "ack", captureId, sequence: nextSequence - 1 });
    },
  });
  const watch = setInterval(() => { if (reconnectAt !== null && Date.now() - reconnectAt >= PHONE_RECONNECT_GRACE_MS) { reconnectAt = null; fail(false); } }, 500);
  const source: ExternalPcmSource = {
    isLive: () => !disposed && ready && (link.connected || (reconnectAt !== null && Date.now() - reconnectAt < PHONE_RECONNECT_GRACE_MS)),
    async start(onData, onStop, onEnded) {
      if (disposed || !ready || !link.connected || captureId) throw new Error(connectionMessage(locale));
      captureId = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      nextSequence = 0; receive = onData; ended = onEnded;
      const ownId = captureId;
      const recorder: PcmRecorder = {
        state: "recording",
        stop() {
          if (recorder.state !== "recording") return stopping ?? Promise.resolve();
          recorder.state = "stopping";
          stopping = (async () => {
            let failure: unknown;
            try {
              await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => ack.reject(new Error(connectionMessage(locale))), 2_500);
                const ack: Ack = { captureId: ownId,
                  resolve() { clearTimeout(timeout); if (stopAck === ack) stopAck = null; resolve(); },
                  reject(error) { clearTimeout(timeout); if (stopAck === ack) stopAck = null; reject(error); } };
                stopAck = ack;
                if (disposed || captureId !== ownId || !link.send({ type: "stop", captureId: ownId })) ack.reject(new Error(connectionMessage(locale)));
              });
            } catch (error) { failure = error; }
            finally {
              if (captureId === ownId) { receive = null; ended = null; captureId = 0; stopAck = null; }
              recorder.state = "inactive";
              if (failure) ready = false;
              if (!disposed) state.set({ phase: ready ? "paused" : "error", error: failure ? connectionMessage(locale) : null, level: 0 });
              // Even a missing phone acknowledgement must drain/close desktop STT.
              await onStop();
            }
            if (failure) throw failure;
          })();
          return stopping;
        },
      };
      let stopping: Promise<void> | null = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => ack.reject(new Error(connectionMessage(locale))), 10_000);
          const ack: Ack = { captureId: ownId,
            resolve() { clearTimeout(timeout); if (startAck === ack) startAck = null; resolve(); },
            reject(error) { clearTimeout(timeout); if (startAck === ack) startAck = null; reject(error); } };
          startAck = ack;
          if (!link.send({ type: "start", captureId })) ack.reject(new Error(connectionMessage(locale)));
        });
        if (disposed || captureId !== ownId) throw new Error(connectionMessage(locale));
        state.set({ phase: "recording", error: null });
        return recorder;
      } catch (error) { await recorder.stop().catch(() => {}); throw error; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; ended = null; receive = null; clearInterval(watch);
      startAck?.reject(new Error(closedMessage(locale))); stopAck?.reject(new Error(closedMessage(locale))); link.send({ type: "finish" }); link.close();
      state.set({ phase: "ended", level: 0 });
      void fetch("/api/phone-mic", { method: "DELETE", headers: { "Content-Type": "application/json", "X-Site-Locale": locale },
        body: JSON.stringify({ roomId: pair.roomId, ownerToken: pair.ownerToken }), keepalive: true }).catch(() => {});
    },
  };
  return { pair, source, getSnapshot: state.getSnapshot, subscribe: state.subscribe,
    status(value: string, elapsedMs: number) {
      if (["connecting", "recording", "paused", "error"].includes(value)) link.send({ type: "status", state: value, elapsedMs });
    }, dispose: source.dispose };
}
export type DesktopPhoneMic = Awaited<ReturnType<typeof createDesktopPhoneMic>>;

/** Phone has no lecture/account API access. It can only supply audio to its paired laptop. */
export function createPhoneMicrophone(roomId: string, inviteToken: string | null, locale: Locale) {
  const state = store<PhoneState>({ phase: "idle", error: null, level: 0, elapsedMs: 0 });
  let link: PhoneSocket | null = null, media: MediaStream | null = null, recorder: PcmRecorder | null = null;
  let replay: PhonePcmReplay | null = null, lastSent = -1, captureId = 0, live = false;
  let peerLostAt: number | null = null, lastAudioAt = 0, lastLevelAt = 0;
  let connecting = false, disposed = false, attempt = 0, captureAttempt = 0, stoppedCaptureId = 0;
  let claimAbort: AbortController | null = null;
  let enqueueControl: ((value: Control) => void) | null = null;
  let pumping: ReturnType<typeof setInterval> | null = null, wake: WakeLockSentinel | null = null;
  const storageKey = `lecue-phone-mic:${roomId}`;
  let stored: { token?: string; relayUrl?: string; expiresAt?: string } = {};
  try { stored = JSON.parse(sessionStorage.getItem(storageKey) ?? "{}"); } catch { /* storage optional */ }
  const persist = () => { try { sessionStorage.setItem(storageKey, JSON.stringify(stored)); } catch { /* retain the same token in memory */ } };
  const current = (ownAttempt: number) => !disposed && attempt === ownAttempt;
  const stopMedia = async () => {
    captureAttempt++;
    live = false; replay?.clear(); replay = null; captureId = 0;
    const oldRecorder = recorder, oldMedia = media, oldWake = wake;
    recorder = null; media = null; wake = null;
    await oldRecorder?.stop().catch(() => {});
    oldMedia?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    void oldWake?.release().catch(() => {});
  };
  const fail = (code: string, terminal = false) => {
    if (disposed) return;
    attempt++; connecting = false; claimAbort?.abort(); claimAbort = null;
    enqueueControl = null;
    link?.send({ type: "error", code });
    link?.close(); link = null;
    if (pumping) clearInterval(pumping); pumping = null;
    void stopMedia();
    const error = terminal ? closedMessage(locale) : code === "MIC_DENIED"
      ? message(locale, "마이크 접근이 꺼져 있어요. 브라우저 설정에서 허용한 뒤 다시 연결해 주세요.", "Microphone access is blocked. Allow it in your browser settings, then reconnect.")
      : code === "BUFFER_FULL" ? message(locale, "소리 전달이 지연되어 마이크를 멈췄어요. 연결을 확인하고 다시 연결해 주세요.", "Audio delivery stalled, so the microphone stopped. Check your connection and reconnect.")
      : message(locale, "마이크 연결이 멈췄어요. 이 화면을 열어 둔 채 다시 연결해 주세요.", "The microphone connection stopped. Keep this screen open and reconnect.");
    state.set({ phase: terminal ? "ended" : "error", error, level: 0 });
  };
  const pump = () => {
    if (!replay || !link?.connected) return;
    for (const item of replay.after(lastSent)) {
      if (!link.send(item.frame)) break;
      lastSent = item.sequence;
    }
  };
  const capture = async (ownAttempt: number) => {
    if (!media) throw new Error("MIC_LOST");
    const ownMedia = media, ownCapture = ++captureAttempt;
    const active = () => current(ownAttempt) && media === ownMedia && captureAttempt === ownCapture;
    lastAudioAt = Date.now();
    const created = await createPcmRecorder(ownMedia, pcm => {
      if (!active()) return;
      lastAudioAt = Date.now();
      if (Date.now() - lastLevelAt > 120) {
        lastLevelAt = Date.now();
        const samples = new Int16Array(pcm); let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        state.set({ level: live ? Math.min(1, peak / 16_384) : 0 });
      }
      if (!live || !replay) return;
      try { replay.push(pcm); pump(); } catch { fail("BUFFER_FULL"); }
    }, () => {});
    if (!active()) { await created.stop().catch(() => {}); return; }
    recorder = created;
  };
  async function control(value: Control, ownAttempt: number, ownLink: PhoneSocket) {
    const active = () => current(ownAttempt) && link === ownLink;
    if (!active()) return;
    if (value.type === "hello" || (value.type === "peer" && value.connected === true)) {
      const hasPeer = value.type === "peer" || value.peerConnected === true;
      peerLostAt = hasPeer ? null : Date.now(); lastSent = -1;
      if (media && hasPeer) { ownLink.send({ type: "ready" }); pump(); }
    }
    if (value.type === "peer" && value.connected === false) { peerLostAt ??= Date.now(); state.set({ phase: "reconnecting" }); }
    if (value.type === "ack" && value.captureId === captureId && typeof value.sequence === "number") replay?.acknowledge(value.sequence);
    if (value.type === "start" && validCapture(value.captureId)) {
      // Sequential control delivery is enforced by the caller below.
      if (captureId === value.captureId && live) { ownLink.send({ type: "started", captureId }); return; }
      if (captureId) throw new Error("Capture already active");
      captureId = value.captureId; replay = new PhonePcmReplay(captureId); lastSent = -1;
      live = true;
      if (!recorder || recorder.state !== "recording") await capture(ownAttempt);
      if (!active()) return;
      ownLink.send({ type: "started", captureId }); state.set({ phase: "connecting", error: null });
    }
    if (value.type === "stop" && value.captureId === stoppedCaptureId && !captureId) { ownLink.send({ type: "stopped", captureId: stoppedCaptureId }); return; }
    if (value.type === "stop" && value.captureId === captureId) {
      const stoppedCapture = captureId;
      const oldRecorder = recorder, oldReplay = replay;
      await oldRecorder?.stop(); // Final worklet frames enter replay before acknowledgement.
      if (!active()) return;
      if (recorder === oldRecorder) recorder = null;
      captureAttempt++;
      live = false; pump();
      const deadline = Date.now() + 1_800;
      while (active() && oldReplay?.pendingBytes && Date.now() < deadline) { pump(); await new Promise(resolve => setTimeout(resolve, 30)); }
      if (!active()) return;
      if (oldReplay?.pendingBytes) { fail("BUFFER_FULL"); return; }
      ownLink.send({ type: "stopped", captureId: stoppedCapture }); replay = null; captureId = 0; stoppedCaptureId = stoppedCapture;
      state.set({ phase: "paused", level: 0 });
    }
    if (value.type === "status" && typeof value.elapsedMs === "number") {
      const phase = value.state === "recording" ? "recording" : value.state === "paused" ? "paused" : value.state === "error" ? "error" : "connecting";
      state.set({ phase, elapsedMs: value.elapsedMs });
    }
  }
  return { getSnapshot: state.getSnapshot, subscribe: state.subscribe,
    async connect() {
      if (connecting || link || disposed || !validPhoneRoom(roomId)) return;
      connecting = true; const ownAttempt = ++attempt;
      const ownAbort = new AbortController(); claimAbort = ownAbort;
      peerLostAt = null; stoppedCaptureId = 0;
      state.set({ phase: "connecting", error: null });
      try {
        // Invoke permission inside the user's click, before the claim request.
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        if (!current(ownAttempt)) { stream.getTracks().forEach(track => track.stop()); return; }
        media = stream;
        media.getAudioTracks().forEach(track => { track.onended = () => { if (media === stream) fail("MIC_LOST"); }; });
        await capture(ownAttempt);
        if (!current(ownAttempt)) return;
        const phoneToken = validPhoneSecret(stored.token) ? stored.token : phoneSecret();
        // Claim is idempotent only with the same phone token, including after a
        // lost successful response or a page reload before that response arrives.
        stored = { ...stored, token: phoneToken }; persist();
        let relayUrl = stored.relayUrl;
        if (validPhoneSecret(inviteToken)) {
          const result = await api({ action: "claim", roomId, inviteToken, phoneToken }, locale, ownAbort.signal);
          if (!current(ownAttempt)) return;
          relayUrl = result.relayUrl;
          if (!validRelay(relayUrl)) throw new Error(closedMessage(locale));
          stored = { token: phoneToken, relayUrl, expiresAt: result.expiresAt }; persist();
          history.replaceState(null, "", location.pathname + location.search);
          inviteToken = null;
        } else if (!validRelay(relayUrl) || !Number.isFinite(Date.parse(stored.expiresAt ?? "")) || Date.parse(stored.expiresAt ?? "") <= Date.now()) throw new Error(closedMessage(locale));
        if (!current(ownAttempt)) return;
        let controls = Promise.resolve();
        const enqueue = (value: Control) => {
          controls = controls.then(() => control(value, ownAttempt, ownLink)).catch(() => { if (current(ownAttempt)) fail("MIC_LOST"); });
        };
        const ownLink = new PhoneSocket(relayUrl!, "phone", phoneToken, {
          connected(connected) { if (current(ownAttempt) && !connected) { state.set({ phase: "reconnecting" }); lastSent = -1; } },
          unavailable: terminal => { if (current(ownAttempt)) fail("CONNECTION_LOST", terminal); },
          binary: () => { if (current(ownAttempt)) fail("CONNECTION_LOST"); },
          control(value) {
            if (!current(ownAttempt)) return;
            // ACK must remain live while stop waits for its flush acknowledgements.
            if (value.type === "ack") { if (value.captureId === captureId && typeof value.sequence === "number") replay?.acknowledge(value.sequence); return; }
            enqueue(value);
          },
        });
        link = ownLink;
        enqueueControl = enqueue;
        state.set({ phase: "ready" });
        pumping = setInterval(() => {
          if (!current(ownAttempt)) return;
          pump();
          if (live && Date.now() - lastAudioAt > 3_000) fail("AUDIO_STALLED");
          if (peerLostAt !== null && Date.now() - peerLostAt >= PHONE_RECONNECT_GRACE_MS) fail("CONNECTION_LOST");
        }, 50);
        try {
          const acquiredWake = await navigator.wakeLock?.request("screen");
          if (!current(ownAttempt)) void acquiredWake?.release().catch(() => {});
          else wake = acquiredWake ?? null;
        } catch { /* screen hint remains visible */ }
      } catch (error) {
        if (!current(ownAttempt)) return;
        link?.close(); link = null;
        if (pumping) clearInterval(pumping); pumping = null;
        await stopMedia();
        if (!current(ownAttempt)) return;
        const denied = error instanceof DOMException && ["NotAllowedError", "PermissionDeniedError"].includes(error.name);
        if (denied) fail("MIC_DENIED");
        else state.set({ phase: "error", error: error instanceof Error && !(error instanceof DOMException) ? error.message : connectionMessage(locale), level: 0 });
      } finally { if (current(ownAttempt)) connecting = false; if (claimAbort === ownAbort) claimAbort = null; }
    },
    pause() { if (live) { link?.send({ type: "pause" }); enqueueControl?.({ type: "stop", captureId }); state.set({ phase: "paused", level: 0 }); } },
    disconnect() { attempt++; connecting = false; claimAbort?.abort(); claimAbort = null; enqueueControl = null; link?.send({ type: "pause" }); link?.close(); link = null; if (pumping) clearInterval(pumping); pumping = null; void stopMedia(); state.set({ phase: "ended", level: 0 }); },
    dispose() { disposed = true; this.disconnect(); },
  };
}
