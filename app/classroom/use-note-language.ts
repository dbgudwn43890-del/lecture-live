"use client";

import { useEffect, useState } from "react";
import { normalizeNoteLanguagePreference, resolveNoteLanguage, type NoteLanguagePreference } from "../lib/note-language";

const STORAGE_KEY = "lecue-note-language";

/** A writing preference never changes the capture language or an active job. */
export function useNoteLanguage(locale: "ko" | "en") {
  const [preference, setPreference] = useState<NoteLanguagePreference>("system");
  const [systemLanguages, setSystemLanguages] = useState<readonly string[]>([]);
  useEffect(() => {
    const readSystem = () => setSystemLanguages(navigator.languages?.length ? [...navigator.languages] : [navigator.language]);
    const readPreference = () => {
      try { setPreference(normalizeNoteLanguagePreference(window.localStorage.getItem(STORAGE_KEY))); }
      catch { /* The default and in-memory choice work when storage is blocked. */ }
    };
    const storageChanged = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) readPreference(); };
    readSystem(); readPreference();
    window.addEventListener("languagechange", readSystem);
    window.addEventListener("storage", storageChanged);
    return () => {
      window.removeEventListener("languagechange", readSystem);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);
  function change(next: NoteLanguagePreference) {
    setPreference(next);
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep this visit's choice. */ }
  }
  return { preference, language: resolveNoteLanguage(preference, systemLanguages, locale),
    systemLanguage: resolveNoteLanguage("system", systemLanguages, locale), change };
}
