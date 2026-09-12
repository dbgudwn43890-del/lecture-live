import { SPEECH_LANGUAGES, isSpeechLanguage, type SpeechLanguage } from "./speech-languages";

export function initialSpeechLanguage(saved: string | null, region: "kr" | "global"): SpeechLanguage {
  return isSpeechLanguage(saved) ? saved : region === "kr" ? "multi" : "en";
}

export function lectureLanguageChoices(region: "kr" | "global", locale: "ko" | "en") {
  const primaryIds: SpeechLanguage[] = region === "kr" ? ["ko", "multi", "en"] : ["en"];
  const primary = primaryIds.map(id => {
    const language = SPEECH_LANGUAGES.find(item => item.code === id)!;
    return { id, label: id === "multi" ? locale === "ko" ? language.koLabel : language.enLabel : language.nativeLabel };
  });
  const other = SPEECH_LANGUAGES.filter(item => !primaryIds.includes(item.code)).map(language => ({
    id: language.code,
    label: language.code === "ko" ? "한국어" : language.code === "multi" ? language.enLabel
      : `${language.nativeLabel} · ${locale === "ko" ? language.koLabel : language.enLabel}`,
  }));
  return { primary, other };
}
