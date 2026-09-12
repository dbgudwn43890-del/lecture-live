"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createLiveAssistController, type LiveAssistInput } from "../lib/live-assist-client";

export function useLiveAssist(options: LiveAssistInput) {
  // A new controller also clears old-session answers during render, before an
  // effect could expose them to the workspace's message-merging effect.
  const controller = useMemo(() => createLiveAssistController(), [options.sessionId]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    controller.start();
    return () => controller.dispose();
  }, [controller]);
  useEffect(() => {
    controller.update(options);
  }, [controller, options.enabled, options.sessionId, options.status, options.segments, options.interim, options.locale, options.elapsedMs,
    options.conversation, options.materialRevision, options.manualQuestionPending]);
  return { ...state, retry: controller.retry };
}
