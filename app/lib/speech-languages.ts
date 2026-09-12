/**
 * Product transcription choices; `multi` means Korean + English via Soniox.
 * Single-language codes use Nova-3; `zh` produces simplified Mandarin Chinese.
 * https://developers.deepgram.com/docs/models-languages-overview
 */
export const SPEECH_LANGUAGES = [
  { code: "en", nativeLabel: "English", enLabel: "English", koLabel: "영어" },
  { code: "ko", nativeLabel: "한국어", enLabel: "Korean", koLabel: "한국어" },
  { code: "multi", nativeLabel: "한국어 + English", enLabel: "Korean + English", koLabel: "한국어 + 영어" },
  { code: "es", nativeLabel: "Español", enLabel: "Spanish", koLabel: "스페인어" },
  { code: "ja", nativeLabel: "日本語", enLabel: "Japanese", koLabel: "일본어" },
  { code: "zh", nativeLabel: "中文（普通话）", enLabel: "Chinese (Mandarin)", koLabel: "중국어(보통화)" },
  { code: "fr", nativeLabel: "Français", enLabel: "French", koLabel: "프랑스어" },
  { code: "de", nativeLabel: "Deutsch", enLabel: "German", koLabel: "독일어" },
  { code: "pt", nativeLabel: "Português", enLabel: "Portuguese", koLabel: "포르투갈어" },
  { code: "hi", nativeLabel: "हिन्दी", enLabel: "Hindi", koLabel: "힌디어" },
] as const;

export type SpeechLanguage = (typeof SPEECH_LANGUAGES)[number]["code"];

export function isSpeechLanguage(value: unknown): value is SpeechLanguage {
  return SPEECH_LANGUAGES.some((language) => language.code === value);
}
