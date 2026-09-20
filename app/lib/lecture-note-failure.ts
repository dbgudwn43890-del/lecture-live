import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from "openai";

export type NoteFailureStage = "prepare" | "generate" | "parse" | "validate" | "save";

const validationReasons = {
  "invalid note object": "invalid_object",
  "invalid note text": "invalid_text",
  "invalid note list": "invalid_list",
  "missing note evidence": "missing_evidence",
  "unknown note evidence": "unknown_evidence",
  "empty note": "empty_note",
  "missing question provenance": "missing_question_provenance",
  "ambiguous question provenance": "ambiguous_question_provenance",
  "invalid section": "invalid_section",
  "empty list": "empty_list",
  "invalid table": "invalid_table",
  "uneven table": "uneven_table",
  "missing question IDs": "missing_question_ids",
  "invented student question": "invented_question",
  "lecture status request is not a learning question": "status_request_in_qa",
  "student question repeated": "repeated_question",
  "too many checks": "too_many_checks",
  "missing check question": "missing_check_question",
  "invalid note code": "invalid_code",
  "invalid code language": "invalid_code_language",
  "invalid note formula": "invalid_formula",
  "invalid material page": "invalid_material_page",
  "material does not match evidence": "material_evidence_mismatch",
  "unsupported note block": "unsupported_block",
  "invalid question exclusions": "invalid_question_exclusions",
  "invalid question exclusion reason": "invalid_exclusion_reason",
  "student question omitted": "omitted_question",
  "invalid concepts": "invalid_concepts",
  "too many concepts": "too_many_concepts",
} as const;

type NoteFailure = {
  category: "timeout" | "cancelled" | "provider" | "validation" | "parse" | "save" | "prepare";
  reason: typeof validationReasons[keyof typeof validationReasons]
    | "request_timeout" | "request_aborted" | "time_budget_exceeded"
    | "response_incomplete" | "response_failed" | "response_cancelled"
    | "connection_failed" | "http_error" | "provider_unknown"
    | "validation_unknown" | "invalid_json" | "parse_unknown" | "save_failed" | "prepare_failed";
  httpStatus?: number;
};

/** Return bounded diagnostic codes only; never pass through messages, causes or bodies. */
export function classifyNoteFailure(error: unknown, stage: NoteFailureStage, responseStatus?: string): NoteFailure {
  const detail = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; status?: unknown } : {};
  if (error instanceof APIConnectionTimeoutError || detail.name === "APIConnectionTimeoutError" || detail.name === "TimeoutError") {
    return { category: "timeout", reason: "request_timeout" };
  }
  if (error instanceof APIUserAbortError || detail.name === "APIUserAbortError" || detail.name === "AbortError") {
    return { category: "cancelled", reason: "request_aborted" };
  }
  if (stage === "validate") {
    const reason = typeof detail.message === "string" && Object.hasOwn(validationReasons, detail.message)
      ? validationReasons[detail.message as keyof typeof validationReasons] : "validation_unknown";
    return { category: "validation", reason };
  }
  if (stage === "parse") return { category: "parse", reason: error instanceof SyntaxError ? "invalid_json" : "parse_unknown" };
  if (stage === "save") return { category: "save", reason: "save_failed" };
  if (detail.message === "note preparation exceeded time budget") return { category: "timeout", reason: "time_budget_exceeded" };
  if (stage === "prepare") return { category: "prepare", reason: "prepare_failed" };
  if (responseStatus === "incomplete") return { category: "provider", reason: "response_incomplete" };
  if (responseStatus === "failed") return { category: "provider", reason: "response_failed" };
  if (responseStatus === "cancelled") return { category: "cancelled", reason: "response_cancelled" };
  if (error instanceof APIConnectionError || detail.name === "APIConnectionError") return { category: "provider", reason: "connection_failed" };
  if (typeof detail.status === "number" && [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504].includes(detail.status)) {
    return { category: "provider", reason: "http_error", httpStatus: detail.status };
  }
  return { category: "provider", reason: "provider_unknown" };
}
