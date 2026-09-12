import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { listeningState } from "./listening-state";
import LectureFlow from "./lecture-flow";
import type { useLiveScript } from "./use-live-script";
import "./listening-indicator.css";

export default function ListeningIndicator({ status, waitingForAudio, finalizing, english, sessionId, script }: {
  status: string; waitingForAudio: boolean; finalizing: boolean; english: boolean; sessionId: string; script: ReturnType<typeof useLiveScript>;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!panel.current || !trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const width = Math.min(420, window.innerWidth - 32);
      const top = Math.min(rect.bottom + 8, Math.max(16, window.innerHeight - 180));
      panel.current.style.setProperty("--flow-left", `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`);
      panel.current.style.setProperty("--flow-top", `${top}px`);
      panel.current.style.setProperty("--flow-height", `${window.innerHeight - top - 16}px`);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const { live, text } = listeningState(status, waitingForAudio, finalizing, english);
  return <>
  <button ref={trigger} type="button" className="listening-indicator" data-live={live} data-visible={visible}
    popoverTarget={id} aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
    aria-label={`${text} · ${english ? "View lecture flow" : "강의 흐름 보기"}`}>
    <svg className="listening-orbit" viewBox="0 0 28 28" aria-hidden="true">
      <circle className="listening-track" cx="14" cy="14" r="11" />
      <g className="listening-arcs"><circle cx="14" cy="14" r="11" strokeDasharray="14 20.56" /></g>
      <g className="listening-inner"><circle cx="14" cy="14" r="7" strokeDasharray="11 11" /></g>
      <circle className="listening-core" cx="14" cy="14" r="3" />
    </svg>
    <small>{text}</small>
    <ChevronDown className="listening-chevron" size={13} aria-hidden="true" />
  </button>
  <div ref={panel} id={id} popover="auto" className="lecture-flow-popover" role="dialog" aria-labelledby={`${id}-title`}
    onToggle={event => setOpen(event.newState === "open")}>
    <header className="lecture-flow-heading">
      <div><h2 id={`${id}-title`}>{english ? "Lecture flow" : "강의 흐름"}</h2></div>
      <button type="button" popoverTarget={id} popoverTargetAction="hide" aria-label={english ? "Close lecture flow" : "강의 흐름 닫기"}><X size={18} aria-hidden="true" /></button>
    </header>
    {open && <LectureFlow key={`${sessionId}:${english}`} sessionId={sessionId} english={english} status={status} script={script} />}
  </div>
  </>;
}
