"use client";

type Option = { id: string; label: string };

/** Common choices stay visible; the native menu keeps the rest compact. */
export default function LanguageChoices({ label, value, primary, other, otherLabel, onChange, disabled = false }: {
  label: string;
  value: string;
  primary: Option[];
  other: Option[];
  otherLabel: string;
  onChange(value: string): void;
  disabled?: boolean;
}) {
  const selectedOther = other.some(option => option.id === value);
  return <div className={`language-choices${primary.length === 1 ? " language-choices-global" : ""}`} role="group" aria-label={label}>
    <div className="language-primary">
      {primary.map(option => <button key={option.id} type="button" aria-pressed={value === option.id} disabled={disabled} onClick={() => onChange(option.id)}>{option.label}</button>)}
    </div>
    {other.length > 0 && <select aria-label={`${label} · ${otherLabel}`} value={selectedOther ? value : ""} disabled={disabled} data-selected={selectedOther} onChange={event => onChange(event.target.value)}>
      <option value="" disabled>{otherLabel}</option>
      {other.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    </select>}
  </div>;
}
