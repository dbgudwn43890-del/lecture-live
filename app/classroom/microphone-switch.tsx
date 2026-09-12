"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Mic, Smartphone } from "lucide-react";
import "./microphone-switch.css";

export default function MicrophoneSwitch({ phone, english, disabled, onChange }: {
  phone: boolean; english: boolean; disabled: boolean;
  onChange(target: "computer" | "phone"): void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const choices = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const current = phone ? 1 : 0;
  const computerLabel = english ? "Computer mic" : "컴퓨터 마이크";
  const phoneLabel = english ? "Phone mic" : "휴대폰 마이크";
  const label = phone ? phoneLabel : computerLabel;

  useEffect(() => { if (disabled) panel.current?.hidePopover(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!panel.current || !trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = panel.current.offsetWidth;
      const height = panel.current.offsetHeight;
      panel.current.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
      panel.current.style.top = `${Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - height - 12))}px`;
    };
    place();
    choices.current[current]?.focus();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, current]);

  function choose(target: "computer" | "phone") {
    if (disabled) return;
    panel.current?.hidePopover();
    trigger.current?.focus();
    onChange(target);
  }

  return <>
    <button ref={trigger} type="button" className="microphone-switch-trigger" disabled={disabled}
      popoverTarget={id} aria-haspopup="menu" aria-expanded={open} aria-controls={id}
      aria-label={`${english ? "Change microphone" : "마이크 변경"} · ${label}`}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); panel.current?.showPopover();
        }
      }}>
      {phone ? <Smartphone size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
      <span className="microphone-switch-label">{label}</span><span className="microphone-switch-compact" aria-hidden="true">{phone ? (english ? "Phone" : "휴대폰") : (english ? "Computer" : "컴퓨터")}</span><ChevronDown className="microphone-switch-chevron" size={13} aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" className="microphone-switch-panel" role="menu"
      aria-labelledby={`${id}-title`} onToggle={event => setOpen(event.newState === "open")}
      onKeyDown={event => {
        const focused = choices.current.findIndex(choice => choice === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? 1
          : event.key === "ArrowDown" ? (focused + 1) % 2 : event.key === "ArrowUp" ? (focused + 1) % 2 : null;
        if (next !== null) { event.preventDefault(); choices.current[next]?.focus(); }
        if (event.key === "Tab") panel.current?.hidePopover();
      }}>
      <h2 id={`${id}-title`}>{english ? "Choose microphone" : "마이크 선택"}</h2>
      <button ref={node => { choices.current[0] = node; }} type="button" role="menuitemradio"
        aria-checked={!phone} disabled={disabled} tabIndex={-1} className="microphone-switch-option"
        onClick={() => choose("computer")}>
        <Mic size={19} aria-hidden="true" />
        <span><strong>{computerLabel}</strong><small>{english ? "Record with this device" : "이 기기의 마이크로 녹음"}</small></span>
        {!phone && <Check size={17} className="microphone-switch-check" aria-hidden="true" />}
      </button>
      <button ref={node => { choices.current[1] = node; }} type="button" role="menuitemradio"
        aria-checked={phone} disabled={disabled} tabIndex={-1} className="microphone-switch-option"
        onClick={() => choose("phone")}>
        <Smartphone size={19} aria-hidden="true" />
        <span><strong>{phoneLabel}</strong><small>{phone
          ? (english ? "Reconnect with a new QR code" : "새 QR로 다시 연결")
          : (english ? "Connect by scanning a QR code" : "QR을 스캔해 연결")}</small></span>
        {phone && <Check size={17} className="microphone-switch-check" aria-hidden="true" />}
      </button>
    </div>
  </>;
}
