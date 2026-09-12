"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Mic, Pause, RotateCcw, ScreenShareOff } from "lucide-react";
import { createPhoneMicrophone, type PhoneState } from "../lib/phone-mic-client";

type Controller = ReturnType<typeof createPhoneMicrophone>;
const initialState: PhoneState = { phase: "idle", error: null, level: 0, elapsedMs: 0 };
const noopSubscribe = () => () => {};
const initialSnapshot = () => initialState;

export default function PhoneMicrophonePage({ roomId, locale }: { roomId: string | null; locale: "ko" | "en" }) {
  const en = locale === "en";
  const [controller, setController] = useState<Controller | null>(null);
  const [secure, setSecure] = useState(true);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? initialSnapshot, initialSnapshot);

  useEffect(() => {
    setSecure(window.isSecureContext);
    if (!roomId) return;
    const invite = new URLSearchParams(window.location.hash.slice(1)).get("key");
    const mic = createPhoneMicrophone(roomId, invite, locale);
    setController(mic);
    const leaving = () => mic.disconnect();
    window.addEventListener("pagehide", leaving);
    return () => { window.removeEventListener("pagehide", leaving); mic.dispose(); };
  }, [roomId, locale]);

  const invalid = !roomId || !secure;
  const active = ["ready", "recording", "paused", "reconnecting"].includes(state.phase);
  const busy = state.phase === "connecting" || state.phase === "reconnecting";
  const descriptions = en ? {
    idle: ["Your phone, your microphone", "Capture audio here. Keep asking questions on your laptop."],
    connecting: ["Connecting your microphone", "Allow microphone access when your browser asks."],
    waiting: ["Connecting your microphone", "Keep this screen open while the connection is prepared."],
    ready: ["Your microphone is ready", "Choose “Start with this microphone” on your laptop."],
    recording: ["Sending audio to your laptop", "Continue your questions and answers on your laptop."],
    paused: ["Microphone paused", "Press Resume on your laptop when you’re ready."],
    reconnecting: ["Reconnecting", "Keep this screen open while we restore the connection."],
    ended: ["Microphone disconnected", "Open a new QR code on your laptop to connect again."],
    error: ["Let’s reconnect", "Check the message below, then try again."],
  } : {
    idle: ["휴대폰을 마이크로 사용해요", "소리는 휴대폰에서, 질문은 노트북에서."],
    connecting: ["마이크를 연결하고 있어요", "브라우저가 물어보면 마이크 접근을 허용해 주세요."],
    waiting: ["마이크를 연결하고 있어요", "연결을 준비하는 동안 이 화면을 열어 두세요."],
    ready: ["마이크가 준비됐어요", "노트북에서 ‘이 마이크로 시작’을 눌러 주세요."],
    recording: ["노트북으로 소리를 전달해요", "질문과 답변은 노트북에서 이어가세요."],
    paused: ["마이크를 잠시 멈췄어요", "계속하려면 노트북에서 이어하기를 눌러 주세요."],
    reconnecting: ["다시 연결하고 있어요", "연결을 복구하는 동안 이 화면을 열어 두세요."],
    ended: ["마이크 연결이 끝났어요", "다시 연결하려면 노트북에서 새 QR을 열어 주세요."],
    error: ["마이크를 다시 연결해 주세요", "아래 안내를 확인한 뒤 다시 시도해 주세요."],
  };
  const [title, description] = invalid
    ? [en ? "Open a new QR code" : "새 QR을 열어 주세요", !secure
      ? (en ? "A secure connection is required. Scan the QR code from Lecue on your laptop." : "보안 연결이 필요해요. 노트북의 Lecue에서 QR을 다시 스캔해 주세요.")
      : (en ? "Scan the phone microphone QR code on your laptop." : "노트북에서 휴대폰 마이크 QR을 스캔해 주세요.")]
    : descriptions[state.phase];
  const seconds = Math.max(0, Math.floor(state.elapsedMs / 1000));
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  const litBars = state.phase === "recording" ? Math.ceil(Math.min(1, Math.max(0, state.level)) * 24) : 0;

  return (
    <main className="phone-mic-page" lang={locale}>
      <header className="phone-mic-header">
        <span className="phone-mic-wordmark brand-lockup" aria-label="Lecue"><span className="lecue-symbol" aria-hidden="true" />Lecue</span>
        <span>{en ? "Phone microphone" : "휴대폰 마이크"}</span>
      </header>
      <section className="phone-mic-main" aria-labelledby="phone-mic-title">
        <div className={`phone-mic-symbol${state.phase === "recording" ? " is-recording" : ""}`} aria-hidden="true">
          {invalid || state.phase === "ended" ? <ScreenShareOff size={40} strokeWidth={1.5} /> : state.phase === "paused" ? <Pause size={40} strokeWidth={1.5} /> : <Mic size={40} strokeWidth={1.5} />}
        </div>
        <div className="phone-mic-copy" role="status" aria-live="polite" aria-atomic="true">
          <h1 id="phone-mic-title">{title}</h1>
          <p>{description}</p>
        </div>
        <div className="phone-mic-signal" aria-hidden="true">
          <div className="phone-mic-level">{Array.from({ length: 24 }, (_, i) => <span key={i} className={i < litBars ? "is-lit" : undefined} />)}</div>
          <span className="phone-mic-timer">{active && (state.phase === "recording" || seconds > 0) ? elapsed : ""}</span>
        </div>
        {state.error && !invalid && <p className="phone-mic-error" role="alert">{state.error}</p>}
      </section>
      <footer className="phone-mic-actions">
        {!invalid && (state.phase === "idle" || state.phase === "error" || state.phase === "connecting") && (
          <button className="phone-mic-primary" type="button" disabled={!controller || busy} aria-busy={busy} onClick={() => { void controller?.connect(); }}>
            {state.phase === "error" ? <RotateCcw size={19} aria-hidden="true" /> : <Mic size={19} aria-hidden="true" />}
            {busy ? (en ? "Connecting…" : "연결 중…") : state.phase === "error" ? (en ? "Reconnect microphone" : "마이크 다시 연결") : (en ? "Connect microphone" : "마이크 연결")}
          </button>
        )}
        {!invalid && state.phase === "recording" && <button className="phone-mic-primary" type="button" onClick={() => controller?.pause()}><Pause size={18} aria-hidden="true" />{en ? "Pause microphone" : "마이크 일시정지"}</button>}
        {active && <button className="phone-mic-disconnect" type="button" onClick={() => controller?.disconnect()}>{en ? "Disconnect microphone" : "마이크 연결 종료"}</button>}
        {!invalid && state.phase !== "ended" && <p className="phone-mic-screen-hint">{active ? (en ? "Keep this screen open and your phone unlocked." : "휴대폰을 잠그지 말고 이 화면을 열어 두세요.") : (en ? "Recording starts only when you start it on your laptop." : "노트북에서 시작하면 소리를 전달해요.")}</p>}
      </footer>
    </main>
  );
}
