import "./note-generation.css";

/** Indeterminate writing motion; it does not imply a completion percentage. */
export function NoteGenerationAnimation() {
  return <div className="note-writing" aria-hidden="true">
    <div className="note-writing-sheet"><span /><span /><span /><span /></div>
  </div>;
}

export function NoteGenerationIcon() {
  return <span className="note-writing-icon" aria-hidden="true"><i /><i /><i /></span>;
}
