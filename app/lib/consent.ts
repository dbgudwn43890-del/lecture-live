/**
 * ACC-02/ACC-03. The version stamped onto every stored consent row. Bump it
 * when the wording a learner agreed to changes in substance — the unique index
 * on (user_id, consent_type, document_version) then makes the gate ask again,
 * and the old row stays as the record of what was agreed before.
 */
export const CONSENT_VERSION = "2026-08-30";

/** Required to record; existing accounts are not interrupted for signup-only notices. */
export const CONSENT_TYPES = ["age_14", "recording"] as const;
export const SIGNUP_CONSENT_TYPES = [...CONSENT_TYPES, "assessment"] as const;
export type ConsentType = (typeof SIGNUP_CONSENT_TYPES)[number];

export function isConsentType(value: unknown): value is ConsentType {
  return typeof value === "string" && (SIGNUP_CONSENT_TYPES as readonly string[]).includes(value);
}

/**
 * The exact wording a learner agrees to, in one place next to the version
 * that stamps it. It used to be copy-pasted between the signup form and the
 * workspace gate — a reworded checkbox in one spot silently detached the
 * stored version from what half the users actually read. Change wording here
 * and bump CONSENT_VERSION together.
 */
export const CONSENT_COPY: Record<ConsentType, { ko: string; en: string }> = {
  age_14: {
    ko: "만 14세 이상입니다.",
    en: "I am 14 years of age or older.",
  },
  recording: {
    ko: "Lecue가 마이크로 강의를 녹음하고, 받아쓰기를 위해 음성을 외부 AI 서비스로 보내는 데 동의합니다. 원본 음성은 스크립트를 만든 뒤 보관하지 않습니다.",
    en: "Lecue records lectures through my microphone and sends the audio to an external AI service for transcription. The original audio is not kept once the transcript is made.",
  },
  assessment: {
    ko: "시험·퀴즈 등 평가 중에는 Lecue를 사용하지 않겠습니다.",
    en: "I will not use Lecue during an exam, quiz, or graded assessment.",
  },
};

// Structural on purpose: naming the real client type here drags the SSR
// client's generics into a TS2589 blowup at every call site.
type ConsentReader = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: "consents"): any;
};

/**
 * The dialog in the workspace is UX, not enforcement — anyone can call the
 * recording APIs directly. Age and recording consent are legal requirements,
 * so the routes that start transcription check the stored rows themselves.
 * Fails closed: a read error blocks recording rather than waiving the gate.
 */
export async function hasRecordingConsents(supabase: ConsentReader): Promise<boolean> {
  const { data, error } = await supabase
    .from("consents")
    .select("consent_type")
    .eq("document_version", CONSENT_VERSION)
    .in("consent_type", CONSENT_TYPES);
  if (error || !Array.isArray(data)) return false;
  const accepted = new Set(data.map((row) => (row as { consent_type?: string }).consent_type));
  return CONSENT_TYPES.every((type) => accepted.has(type));
}
