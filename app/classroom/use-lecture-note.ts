"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { trackAnalytics } from "../lib/analytics-client";
import { createLectureNoteController } from "./lecture-note-state";
import type { LectureNoteState } from "./lecture-note-state";
import type { NoteLanguage } from "../lib/note-language";

export type LectureNoteController = LectureNoteState & {
  generate: (force: boolean) => Promise<void>;
  reload: () => Promise<void>;
};

/** Mount in the classroom, rather than in the dismissible note dialog. */
export function useLectureNote(sessionId: string | null, isEnglish: boolean, language?: NoteLanguage): LectureNoteController {
  const controller = useMemo(() => createLectureNoteController(sessionId, isEnglish), [sessionId, isEnglish]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  const previous = useRef({ controller, phase: state.phase });

  useEffect(() => {
    controller.start();
    const refresh = () => { if (!document.hidden) void controller.reload(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.dispose();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [controller]);

  useEffect(() => {
    const last = previous.current;
    previous.current = { controller, phase: state.phase };
    if (last.controller === controller && last.phase === "generating" && state.phase === "ready" && !state.message) {
      trackAnalytics("review_note_complete");
    }
    if (last.controller === controller && last.phase === "generating" && state.phase === "ready" && !state.message
      && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        new Notification(isEnglish ? "Your lecture note is ready" : "강의 노트가 완성됐어요", {
          body: isEnglish ? "Come back to review today's lecture." : "돌아와서 오늘 강의를 복습해 보세요.",
        });
      } catch { /* Some browsers grant permission but do not support desktop notifications. */ }
    }
  }, [controller, state.phase, state.message, isEnglish]);

  // Capture the selected language when submitting. Changing a writing preference
  // must not dispose the session controller or interrupt its background polling.
  return { ...state, generate: (force: boolean) => controller.generate(force, language), reload: controller.reload };
}
