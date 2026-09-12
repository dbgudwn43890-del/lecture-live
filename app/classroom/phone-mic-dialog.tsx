"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ArrowRight, Check, RotateCcw, X } from "lucide-react";
import QRCode from "qrcode";
import WorkspaceDialog from "./workspace-dialog";
import { createDesktopPhoneMic, type DesktopPhoneMic, type PhoneState } from "../lib/phone-mic-client";
import "./phone-mic-dialog.css";

type Props = {
  open: boolean;
  locale: "ko" | "en";
  onClose(): void;
  onReady(controller: DesktopPhoneMic): void;
  onPause(): void;
};
const initialState: PhoneState = { phase: "connecting", error: null, level: 0, elapsedMs: 0 };
const noopSubscribe = () => () => {};
const initialSnapshot = () => initialState;

export default function PhoneMicDialog(props: Props) {
  // Mounting only while open gives each invitation one bounded lifecycle.
  return props.open ? <PairingDialog {...props} /> : null;
}

function PairingDialog({ locale, onClose, onReady, onPause }: Props) {
  const en = locale === "en";
  const canvas = useRef<HTMLCanvasElement>(null);
  const handlers = useRef({ onClose, onReady, onPause });
  handlers.current = { onClose, onReady, onPause };
  const transferred = useRef<DesktopPhoneMic | null>(null);
  const [controller, setController] = useState<DesktopPhoneMic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [qrReady, setQrReady] = useState(false);
  const [claimed, setClaimed] = useState(false);
  const [local, setLocal] = useState(false);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? initialSnapshot, initialSnapshot);
  const ready = state.phase === "ready";
  const seconds = controller ? Math.max(0, Math.ceil((Date.parse(controller.pair.inviteExpiresAt) - now) / 1000)) : 180;
  const expired = Boolean(controller && seconds === 0 && !ready && !claimed);
  const failure = error ?? state.error;

  useEffect(() => {
    let cancelled = false;
    let own: DesktopPhoneMic | null = null;
    setController(null); setError(null); setQrReady(false); setClaimed(false);
    setLocal(["localhost", "127.0.0.1", "[::1]"].includes(location.hostname));
    void createDesktopPhoneMic(locale, () => handlers.current.onPause()).then(async mic => {
      own = mic;
      if (cancelled) { mic.dispose(); return; }
      setController(mic);
      const url = new URL("/phone-mic", location.origin);
      url.searchParams.set("room", mic.pair.roomId);
      url.searchParams.set("locale", locale);
      url.hash = `key=${mic.pair.inviteToken}`;
      try {
        if (!canvas.current) return;
        await QRCode.toCanvas(canvas.current, url.toString(), {
          width: 224, margin: 4, errorCorrectionLevel: "M", color: { dark: "#29372b", light: "#ffffff" },
        });
        if (!cancelled) setQrReady(true);
      } catch {
        mic.dispose();
        if (!cancelled) setError(en ? "The QR code could not be prepared. Try again." : "QR을 준비하지 못했어요. 다시 시도해 주세요.");
      }
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : (en ? "Could not connect. Try again." : "연결을 준비하지 못했어요. 다시 시도해 주세요."));
    });
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => { cancelled = true; clearInterval(clock); if (own && transferred.current !== own) own.dispose(); };
  }, [attempt, en, locale]);

  useEffect(() => { if (ready) setClaimed(true); }, [ready]);

  useEffect(() => {
    // Expired, unclaimed invites no longer need an open owner connection.
    if (expired && controller) controller.dispose();
  }, [controller, expired]);

  function begin() {
    if (!controller || !ready) return;
    transferred.current = controller;
    handlers.current.onReady(controller);
    handlers.current.onClose();
  }

  return (
    <WorkspaceDialog label={en ? "Use your phone as a microphone" : "휴대폰 마이크 연결"} onClose={() => handlers.current.onClose()}>
      <section className="phone-pair-panel" aria-labelledby="phone-pair-title">
        <header className="phone-pair-header">
          <h2 id="phone-pair-title">{en ? "Connect your phone" : "휴대폰 마이크 연결"}</h2>
          <button className="phone-pair-close" type="button" aria-label={en ? "Close" : "닫기"} onClick={() => handlers.current.onClose()}><X size={20} aria-hidden="true" /></button>
        </header>
        <p className="phone-pair-intro">{en ? "Scan with your phone’s camera, then allow microphone access." : "휴대폰 카메라로 QR을 스캔하고 마이크를 허용해 주세요."}</p>
        <div className={`phone-pair-code${ready ? " is-ready" : ""}`}>
          <canvas ref={canvas} width={224} height={224} role="img" aria-label={en ? "QR code to connect your phone microphone" : "휴대폰 마이크 연결 QR 코드"} hidden={!qrReady || ready || expired || Boolean(failure)} />
          {ready ? <div className="phone-pair-ready"><Check size={42} strokeWidth={1.7} aria-hidden="true" /><strong>{en ? "Microphone ready" : "마이크가 준비됐어요"}</strong></div>
            : expired || failure ? <p>{expired ? (en ? "This QR code has expired." : "QR 유효 시간이 지났어요.") : (en ? "Connection needs attention." : "연결을 확인해 주세요.")}</p>
            : !qrReady ? <p>{en ? "Preparing your QR code…" : "QR을 준비하고 있어요…"}</p> : null}
        </div>
        <div className="phone-pair-status" role="status" aria-live="polite">
          {ready ? <p>{en ? "Start when you’re ready. Your phone will capture the audio." : "아래 버튼을 누르면 휴대폰으로 녹음이 시작됩니다."}</p>
            : failure && !expired ? <p className="phone-pair-error">{failure}</p>
            : expired ? <p>{en ? "Create a new QR code to connect." : "새 QR을 만들어 연결해 주세요."}</p>
            : <p>{en ? "Waiting for your phone" : "휴대폰 연결을 기다리고 있어요"}</p>}
        </div>
        {!ready && qrReady && !expired && !failure && <p className="phone-pair-expiry" aria-live="off">{en ? "QR expires in " : "QR 유효 시간 "}<span>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</span></p>}
        {local && <p className="phone-pair-local">{en ? "A phone cannot open this localhost address. Use this feature on the deployed Lecue site." : "휴대폰은 이 로컬 주소를 열 수 없어요. 배포된 Lecue에서 연결해 주세요."}</p>}
        <footer className="phone-pair-actions">
          {expired || failure ? <button className="phone-pair-primary" type="button" onClick={() => setAttempt(value => value + 1)}><RotateCcw size={17} aria-hidden="true" />{en ? "Create new QR code" : "새 QR 만들기"}</button>
            : <button className="phone-pair-primary" type="button" disabled={!ready} onClick={begin}>{en ? "Start with this microphone" : "이 마이크로 시작"}<ArrowRight size={18} aria-hidden="true" /></button>}
          <p>{en ? "Keep your phone’s screen open while recording." : "녹음 중에는 휴대폰 화면을 열어 두세요."}</p>
        </footer>
      </section>
    </WorkspaceDialog>
  );
}
