"use client";
import { useEffect, useRef, useState } from "react";

/** Keep the question panel beside the fitted frame, even for a tall captured tab. */
export function useOnlineLayout(active: boolean, aspectRatio: number) {
  const panesRef = useRef<HTMLElement>(null);
  const [maxWidth, setMaxWidth] = useState<number>();
  useEffect(() => {
    const panes = panesRef.current;
    const workspace = panes?.closest(".workspace-main");
    const stage = panes?.querySelector(".lecture-preview-stage");
    if (!active || !panes || !workspace || !stage) return;
    const measure = () => {
      if (window.innerWidth <= 800) { setMaxWidth(undefined); return; }
      const preview = panes.querySelector(".lecture-preview");
      if (!preview) return;
      const padding = getComputedStyle(preview);
      // The grid column remains present while Questions/Transcript swap visibility.
      const columns = getComputedStyle(panes).gridTemplateColumns.split(" ");
      const sideWidth = Number.parseFloat(columns[1]);
      if (!Number.isFinite(sideWidth)) return;
      const fitted = stage.getBoundingClientRect().height * aspectRatio
        + Number.parseFloat(padding.paddingLeft) + Number.parseFloat(padding.paddingRight) + sideWidth;
      setMaxWidth(Math.min(1560, Math.max(720, Math.round(fitted))));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, [active, aspectRatio]);
  return { panesRef, maxWidth: active ? maxWidth : undefined };
}
