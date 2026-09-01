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
