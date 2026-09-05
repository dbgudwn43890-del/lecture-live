"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** The browser owns focus trapping, Escape, and the inert background. */
export default function WorkspaceDialog({ label, onClose, children }: {
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog ref={ref} className="workspace-dialog" aria-label={label}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {children}
    </dialog>
  );
}
