"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import { NOTE_LANGUAGES, type NoteLanguage, type NoteLanguagePreference } from "../lib/note-language";
import "./note-language-picker.css";

export default function NoteLanguagePicker({ value, systemLanguage, isEnglish, onChange, disabled = false }: {
  value: NoteLanguagePreference;
  systemLanguage: NoteLanguage;
  isEnglish: boolean;
  onChange(value: NoteLanguagePreference): void;
  disabled?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const choices = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const options = [
    { code: "system" as const, nativeLabel: isEnglish ? "System default" : "시스템 설정" },
    ...NOTE_LANGUAGES,
  ];
  const current = Math.max(0, options.findIndex(option => option.code === value));
  const systemLabel = NOTE_LANGUAGES.find(option => option.code === systemLanguage)!.nativeLabel;
  const label = isEnglish ? "Note language" : "노트 작성 언어";
  const selectedLabel = options[current].nativeLabel;

  useEffect(() => { if (disabled) panel.current?.hidePopover(); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    function place() {
      if (!panel.current || !trigger.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const width = panel.current.offsetWidth, height = panel.current.offsetHeight;
      panel.current.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
      panel.current.style.top = `${Math.max(12, Math.min(anchor.bottom + 6, window.innerHeight - height - 12))}px`;
    }
    place(); choices.current[current]?.focus({ preventScroll: true });
    choices.current[current]?.scrollIntoView({ block: "nearest" });
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, current]);

  return <>
    <button type="button" ref={trigger} className="note-language-trigger" disabled={disabled}
      popoverTarget={id} aria-haspopup="menu" aria-controls={id} aria-expanded={open}
      aria-label={`${label}: ${selectedLabel}${value === "system" ? ` · ${systemLabel}` : ""}`}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); panel.current?.showPopover(); }
      }}>
      <Languages size={16} aria-hidden="true" />
      <span>{selectedLabel}{value === "system" && <small> · {systemLabel}</small>}</span>
      <ChevronDown size={13} aria-hidden="true" />
    </button>
    <div ref={panel} id={id} popover="auto" className="note-language-menu" role="menu" aria-label={label}
      onToggle={event => setOpen(event.newState === "open")}
      onKeyDown={event => {
        const focused = choices.current.findIndex(choice => choice === document.activeElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
          : ["ArrowDown", "ArrowRight"].includes(event.key) ? (focused + 1) % options.length
          : ["ArrowUp", "ArrowLeft"].includes(event.key) ? (focused - 1 + options.length) % options.length : null;
        if (next !== null) { event.preventDefault(); choices.current[next]?.focus(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); panel.current?.hidePopover(); trigger.current?.focus(); }
        if (event.key === "Tab") panel.current?.hidePopover();
      }}>
      {options.map((option, index) => <button key={option.code} ref={node => { choices.current[index] = node; }}
        type="button" role="menuitemradio" tabIndex={-1} aria-checked={value === option.code} disabled={disabled}
        className={option.code === "system" ? "note-language-system" : undefined}
        onClick={() => { panel.current?.hidePopover(); trigger.current?.focus(); onChange(option.code); }}>
        <span lang={option.code === "system" ? undefined : option.code}>{option.nativeLabel}</span>
        {option.code === "system" && <small>{systemLabel}</small>}
        {value === option.code && <Check size={15} aria-hidden="true" />}
      </button>)}
    </div>
  </>;
}
