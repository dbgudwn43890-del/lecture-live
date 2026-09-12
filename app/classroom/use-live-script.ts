"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createLiveScriptController, type LiveScriptInput } from "../lib/live-script-client";

/** Mount at workspace level, never inside the transient listening popover. */
export function useLiveScript(options: LiveScriptInput) {
  const controller = useMemo(() => createLiveScriptController(), [options.sessionId, options.locale]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    controller.update(options);
  }, [controller, options.sessionId, options.status, options.segments, options.locale]);
  return { ...state, retry: controller.retry };
}
