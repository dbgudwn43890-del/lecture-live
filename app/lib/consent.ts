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
