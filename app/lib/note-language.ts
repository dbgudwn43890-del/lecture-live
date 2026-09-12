/** Note output choices are independent of the lecture's transcription language. */
export const NOTE_LANGUAGES = [
  { code: "en", nativeLabel: "English", enLabel: "English", koLabel: "영어" },
  { code: "ko", nativeLabel: "한국어", enLabel: "Korean", koLabel: "한국어" },
  { code: "es", nativeLabel: "Español", enLabel: "Spanish", koLabel: "스페인어" },
  { code: "ja", nativeLabel: "日本語", enLabel: "Japanese", koLabel: "일본어" },
  { code: "zh", nativeLabel: "中文（简体）", enLabel: "Chinese (Simplified)", koLabel: "중국어(간체)" },
  { code: "fr", nativeLabel: "Français", enLabel: "French", koLabel: "프랑스어" },
  { code: "de", nativeLabel: "Deutsch", enLabel: "German", koLabel: "독일어" },
  { code: "pt", nativeLabel: "Português", enLabel: "Portuguese", koLabel: "포르투갈어" },
  { code: "hi", nativeLabel: "हिन्दी", enLabel: "Hindi", koLabel: "힌디어" },
] as const;

export type NoteLanguage = (typeof NOTE_LANGUAGES)[number]["code"];
export type NoteLanguagePreference = "system" | NoteLanguage;

export function isNoteLanguage(value: unknown): value is NoteLanguage {
  return NOTE_LANGUAGES.some(language => language.code === value);
}

export function normalizeNoteLanguagePreference(value: unknown): NoteLanguagePreference {
  return isNoteLanguage(value) ? value : "system";
}

/** Resolve the first supported browser BCP 47 language; no browser APIs on SSR. */
export function resolveNoteLanguage(
  preference: NoteLanguagePreference,
  systemLanguages: readonly string[],
  fallbackLocale: "en" | "ko",
): NoteLanguage {
  if (isNoteLanguage(preference)) return preference;
  for (const systemLanguage of systemLanguages) {
    try {
      const base = Intl.getCanonicalLocales(systemLanguage)[0]?.split("-")[0];
      if (isNoteLanguage(base)) return base;
    } catch {
      // A malformed or unsupported browser preference must not prevent a note.
    }
  }
  return fallbackLocale;
}
