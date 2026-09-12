"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { Mic } from "lucide-react";
import { startMicrophoneCheck } from "./microphone-check";
import "./recording-preparation.css";

export default function RecordingPreparation({ english, language, deviceId, deviceLabel, enabled, stopRef }: {
  english: boolean; language: string; deviceId: string; deviceLabel?: string; enabled: boolean;
  stopRef: MutableRefObject<() => void>;
}) {
  const [state, setState] = useState<"idle" | "checking" | "ready" | "error">("idle");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState("");
  const [detected, setDetected] = useState(false);
  const meterRef = useRef<HTMLMeterElement>(null);
  const checkRef = useRef<{ stop(): void } | null>(null);
  const revision = useRef(0);
  const stop = () => { revision.current++; checkRef.current?.stop(); checkRef.current = null; setState("idle"); setDetected(false); };
  useEffect(() => {
    setState("idle"); setLabel(""); setMessage(""); setDetected(false);
    stopRef.current = stop;
    return () => { revision.current++; checkRef.current?.stop(); checkRef.current = null; stopRef.current = () => {}; };
    // Changes invalidate pending permission requests and release only our check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, deviceId, stopRef]);

  async function check() {
    if (!enabled || state === "checking") return;
    stop();
    const current = revision.current;
    setState("checking"); setMessage("");
    try {
      const capture = await startMicrophoneCheck(deviceId, level => {
        if (current !== revision.current) return;
        if (meterRef.current) meterRef.current.value = level;
        if (level > 0.025) setDetected(true);
      });
      if (current !== revision.current) { capture.stop(); return; }
      checkRef.current = capture; setLabel(capture.label); setState("ready");
    } catch (error) {
      if (current !== revision.current) return;
      const name = error instanceof Error ? error.name : "";
      setMessage(name === "NotAllowedError" ? (english ? "Allow microphone access in your browser, then check again." : "브라우저에서 마이크를 허용한 뒤 다시 확인해 주세요.")
        : name === "NotFoundError" || name === "OverconstrainedError" ? (english ? "Connect a microphone or choose another device." : "마이크를 연결하거나 다른 장치를 선택해 주세요.")
        : (english ? "Could not check the microphone. Check your device and try again." : "마이크를 확인하지 못했습니다. 장치를 확인한 뒤 다시 시도해 주세요."));
      setState("error");
    }
  }

  return <div className="recording-preparation" aria-label={english ? "Before recording" : "녹음 준비 확인"}>
    <div className="recording-preparation-device"><Mic size={15} aria-hidden="true" /><span>{label || deviceLabel || (english ? "Default microphone" : "기본 마이크")}</span>
      <button type="button" disabled={!enabled || state === "checking"} onClick={() => state === "ready" ? stop() : void check()}>
        {state === "ready" ? (english ? "Stop check" : "확인 종료") : state === "checking" ? (english ? "Checking…" : "확인 중…") : (english ? "Check sound" : "소리 확인")}
      </button>
    </div>
    <div className="recording-preparation-level" hidden={state !== "ready"}><meter ref={meterRef} min={0} max={1} value={0} aria-label={english ? "Microphone input level" : "마이크 입력 음량"} /><span role="status">{detected ? (english ? "Sound detected" : "소리 감지됨") : (english ? "Speak to check the level" : "말해 보며 음량을 확인하세요")}</span></div>
    {message && <p role="alert">{message}</p>}
    <p>{english ? "Lecture language: " : "강의 언어: "}{language}</p>
    <p>{english ? "Recording and credit use begin when you start the lecture. Check that recording is allowed." : "강의를 시작하면 기록과 크레딧 사용이 시작돼요. 녹음이 허용된 수업인지 확인해 주세요."}</p>
  </div>;
}
