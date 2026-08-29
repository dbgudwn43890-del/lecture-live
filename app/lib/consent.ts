/**
 * ACC-02/ACC-03. The version stamped onto every stored consent row. Bump it
 * when the wording a learner agreed to changes in substance — the unique index
 * on (user_id, consent_type, document_version) then makes the gate ask again,
 * and the old row stays as the record of what was agreed before.
 */
export const CONSENT_VERSION = "2026-08-30";

export const CONSENT_TYPES = ["age_14", "recording"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

export function isConsentType(value: unknown): value is ConsentType {
  return typeof value === "string" && (CONSENT_TYPES as readonly string[]).includes(value);
}
