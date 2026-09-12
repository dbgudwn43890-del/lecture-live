"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** A user's upward intent wins before the browser applies its first scroll pixel. */
export function createConversationScrollController(
  scroller: HTMLElement,
  onFollowingChange: (following: boolean) => void,
) {
  const view = scroller.ownerDocument.defaultView!;
  let following = true;
  let disposed = false;
  let frame: number | null = null;
  let jumpPending = false;
  let direction: "up" | "down" | null = null;
  let touchY: number | null = null;
  let previousTop = scroller.scrollTop;
  const scrollRange = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  let previousRange = scrollRange();
  const observedChildren = new Set<Element>();
  const atBottom = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2;

  function setFollowing(next: boolean) {
    if (following === next) return;
    following = next;
    onFollowingChange(next);
  }

  function cancelFrame() {
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
  }

  function scrollInstantly(top: number) {
    scroller.scrollTo({ top, behavior: "instant" });
    previousTop = scroller.scrollTop;
    previousRange = scrollRange();
  }

  function refresh() {
    if (disposed || !following || frame !== null) return;
    frame = view.requestAnimationFrame(() => {
      frame = null;
      if (!disposed && following) scrollInstantly(scroller.scrollHeight);
      jumpPending = false;
    });
  }

  function pause() {
    cancelFrame();
    jumpPending = false;
    if (!following) return;
    setFollowing(false);
    // An instant scroll to the current offset also cancels an older smooth scroll.
    scrollInstantly(scroller.scrollTop);
  }

  function jumpToLatest() {
    direction = "down";
    jumpPending = true;
    cancelFrame();
    scrollInstantly(scroller.scrollHeight);
    setFollowing(true);
    refresh();
  }

  function noteIntent(next: "up" | "down") {
    direction = next;
    if (next === "up") {
      if (scroller.scrollHeight > scroller.clientHeight + 1) pause();
    } else if (!following && atBottom()) {
      jumpToLatest();
    }
  }

  function onWheel(event: WheelEvent) {
    if (event.ctrlKey || event.deltaY === 0) return;
    noteIntent(event.deltaY < 0 ? "up" : "down");
  }

  function onTouchStart(event: TouchEvent) {
    touchY = event.touches.length === 1 ? event.touches[0].clientY : null;
  }

  function onTouchMove(event: TouchEvent) {
    if (touchY === null || event.touches.length !== 1) return;
    const nextY = event.touches[0].clientY;
    if (nextY !== touchY) noteIntent(nextY > touchY ? "up" : "down");
    touchY = nextY;
  }

  function onTouchEnd() { touchY = null; }
  function onPointerDown() { direction = null; jumpPending = false; }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    if (event.metaKey && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (event.key === "End" || (event.metaKey && event.key === "ArrowDown")) {
      event.preventDefault();
      jumpToLatest();
    } else if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) {
      noteIntent("up");
    } else if (["ArrowDown", "PageDown"].includes(event.key) || event.key === " ") {
      noteIntent("down");
    }
  }

  function onScroll() {
    const top = scroller.scrollTop;
    const delta = top - previousTop;
    // A taller viewport clamps scrollTop just like shorter content does. This
    // is layout movement, not upward intent, even if a follow control vanished.
    const clampedAfterResize = scrollRange() < previousRange && atBottom();
    previousTop = top;
    previousRange = scrollRange();
    if (following && delta < -.01 && !clampedAfterResize && !jumpPending) {
      pause();
    } else if (!following && atBottom() && direction !== "up" && (delta > .01 || direction === "down")) {
      jumpToLatest();
    }
  }

  const resizeObserver = new view.ResizeObserver(refresh);
  function observeChildren() {
    const currentChildren = new Set(scroller.children);
    for (const child of observedChildren) {
      if (!currentChildren.has(child)) {
        resizeObserver.unobserve(child);
        observedChildren.delete(child);
      }
    }
    for (const child of currentChildren) {
      if (!observedChildren.has(child)) {
        resizeObserver.observe(child);
        observedChildren.add(child);
      }
    }
    refresh();
  }
  const mutationObserver = new view.MutationObserver(observeChildren);
  resizeObserver.observe(scroller);
  observeChildren();
  mutationObserver.observe(scroller, { childList: true });
  scroller.addEventListener("wheel", onWheel, { passive: true, capture: true });
  scroller.addEventListener("touchstart", onTouchStart, { passive: true, capture: true });
  scroller.addEventListener("touchmove", onTouchMove, { passive: true, capture: true });
  scroller.addEventListener("touchend", onTouchEnd, { passive: true });
  scroller.addEventListener("touchcancel", onTouchEnd, { passive: true });
  scroller.addEventListener("pointerdown", onPointerDown, { passive: true, capture: true });
  scroller.addEventListener("keydown", onKeyDown);
  scroller.addEventListener("scroll", onScroll, { passive: true });

  return {
    refresh,
    jumpToLatest,
    dispose() {
      disposed = true;
      cancelFrame();
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      scroller.removeEventListener("wheel", onWheel, { capture: true });
      scroller.removeEventListener("touchstart", onTouchStart, { capture: true });
      scroller.removeEventListener("touchmove", onTouchMove, { capture: true });
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("pointerdown", onPointerDown, { capture: true });
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("scroll", onScroll);
    },
  };
}

export function useConversationScroll(content: unknown, resetKey: unknown) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const controllerRef = useRef<ReturnType<typeof createConversationScrollController> | null>(null);
  const messagesScrollRef = useCallback((node: HTMLDivElement | null) => setScroller(node), []);
  const jumpToLatest = useCallback(() => controllerRef.current?.jumpToLatest(), []);

  useLayoutEffect(() => {
    if (!scroller) return;
    const controller = createConversationScrollController(scroller, setIsFollowingLatest);
    controllerRef.current = controller;
    setIsFollowingLatest(true);
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [scroller]);

  useLayoutEffect(() => { controllerRef.current?.refresh(); }, [content, scroller]);
  useLayoutEffect(() => { jumpToLatest(); }, [resetKey, scroller, jumpToLatest]);

  return { messagesScrollRef, isFollowingLatest, jumpToLatest };
}
