import type { SupabaseClient } from "@supabase/supabase-js";

import { buildMaterialContext, materialSearchTerms, type MaterialContextChunk } from "./material-context";

export const LIVE_ASSIST_MATERIAL_CHARACTERS = 16_000;
export const LIVE_ASSIST_MATERIAL_TIMEOUT_MS = 5_000;
const MAX_DOCUMENTS = 20;
const INDEX_CHUNKS = 12;
const LEXICAL_CHUNKS = 8;
const READ_CONCURRENCY = 4;

export type LiveAssistMaterialContext = {
  text: string;
  status: "none" | "ready" | "partial" | "unavailable";
  documentCount: number | null;
};
type Document = { id: string; user_id: string; session_id: string; filename: string };
type StoredChunk = { id: string; document_id: string; user_id: string; start_page: number; end_page: number; text: string };

/** Server-owned stored text only. Never download originals or invoke a model. */
export async function loadLiveAssistMaterialContext(
  admin: SupabaseClient,
  input: { userId: string; sessionId: string; query: string; signal?: AbortSignal },
): Promise<LiveAssistMaterialContext> {
  let documentCount: number | null = null;
  const unavailable = (): LiveAssistMaterialContext => ({
    text: "Uploaded material text could not be verified. Do not infer that no material was uploaded or answer about its contents without evidence.",
    status: "unavailable", documentCount,
  });
  const deadline = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), LIVE_ASSIST_MATERIAL_TIMEOUT_MS);
  let onAbort!: () => void;
  const cancelled = new Promise<LiveAssistMaterialContext>(resolve => {
    onAbort = () => resolve(unavailable());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  async function retrieve(): Promise<LiveAssistMaterialContext> {
    try {
      signal.throwIfAborted();
      let documentQuery = admin.from("material_documents").select("id,user_id,session_id,filename", { count: "exact" })
        .eq("user_id", input.userId).eq("session_id", input.sessionId)
        .order("created_at", { ascending: false }).order("id", { ascending: true }).limit(MAX_DOCUMENTS + 1);
      documentQuery = documentQuery.abortSignal(signal);
      const { data, error, count } = await documentQuery;
      if (error) throw error;
      if (!Array.isArray(data)) return unavailable();
      documentCount = typeof count === "number" ? count : data.length;
      if (!data.length) return { text: "No materials are currently attached to this lecture session.", status: "none", documentCount: 0 };
      const documents = data.slice(0, MAX_DOCUMENTS) as Document[];
      if (documents.some(document => document.user_id !== input.userId || document.session_id !== input.sessionId
        || typeof document.id !== "string" || typeof document.filename !== "string")) return unavailable();

      // Only literal letters/numbers enter PostgREST filters, never raw speech.
      const terms = materialSearchTerms(input.query).filter(term => /^[\p{L}\p{N}]+$/u.test(term));
      const indexes: Array<{ document: { id: string; filename: string; indexComplete: boolean }; chunks: MaterialContextChunk[] }> = [];
      let next = 0;
      let failed = false;
      const read = async (document: Document, lexical: boolean, prefixIds: string[] = []): Promise<StoredChunk[] | null> => {
        try {
          signal.throwIfAborted();
          let query = admin.from("material_chunks").select("id,document_id,user_id,start_page,end_page,text")
            .eq("user_id", input.userId).eq("document_id", document.id);
          if (lexical) {
            query = query.or(terms.map(term => `text.ilike.%${term}%`).join(","));
            // Use encoded filter arguments, not interpolated raw identifier lists.
            // The eight new hits must not be spent on the prefix already loaded.
            for (const id of prefixIds) query = query.neq("id", id);
          }
          query = query.order("start_page", { ascending: true }).order("id", { ascending: true }).limit(lexical ? LEXICAL_CHUNKS : INDEX_CHUNKS + 1);
          query = query.abortSignal(signal);
          const { data: rows, error: readError } = await query;
          if (readError) throw readError;
          if (!Array.isArray(rows) || rows.some(row => row.user_id !== input.userId || row.document_id !== document.id
            || typeof row.id !== "string" || typeof row.text !== "string" || !row.text.trim()
            || !Number.isSafeInteger(row.start_page) || row.start_page < 1
            || !Number.isSafeInteger(row.end_page) || row.end_page < row.start_page)) return null;
          return rows as StoredChunk[];
        } catch (error) {
          if (!signal.aborted) console.error("Live assist material chunk lookup failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
          return null;
        }
      };
      // Per-document limits keep a large deck from starving a newly added resume.
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, documents.length) }, async () => {
        while (!failed && next < documents.length) {
          const index = next++;
          const document = documents[index];
          const prefix = await read(document, false);
          if (!prefix?.length) { failed = true; return; }
          const complete = prefix.length <= INDEX_CHUNKS;
          const lexical = !complete && terms.length ? await read(document, true, prefix.slice(0, INDEX_CHUNKS).map(row => row.id)) : [];
          if (!lexical) { failed = true; return; }
          indexes[index] = {
            document: { id: document.id, filename: document.filename, indexComplete: complete },
            chunks: [...prefix.slice(0, INDEX_CHUNKS), ...lexical].map(row => ({
              id: row.id, documentId: row.document_id, startPage: row.start_page, endPage: row.end_page, text: row.text,
            })),
          };
        }
      }));
      if (failed || signal.aborted) return unavailable();
      const overflow = data.length > MAX_DOCUMENTS || documentCount > MAX_DOCUMENTS;
      const notice = overflow ? "Additional attached materials exceed this request's document limit and were not read.\n\n" : "";
      const contextInput = { documents: indexes.map(index => index.document), chunks: indexes.flatMap(index => index.chunks), question: input.query, anchor: "" };
      const full = buildMaterialContext(contextInput);
      const budget = LIVE_ASSIST_MATERIAL_CHARACTERS - notice.length;
      const context = full.text.length <= budget ? full : buildMaterialContext({ ...contextInput, maxCharacters: budget });
      if (!context.sources.length) return unavailable();
      return {
        text: notice + context.text,
        status: !overflow && indexes.every(index => index.document.indexComplete) && full.text.length <= budget ? "ready" : "partial",
        documentCount,
      };
    } catch (error) {
      if (!signal.aborted) console.error("Live assist material document lookup failed", error && typeof error === "object" && "code" in error ? error.code : "unknown");
      return unavailable();
    }
  }
  try {
    if (signal.aborted) return unavailable();
    // Also bound callers if a DB transport fails to settle after cancellation.
    return await Promise.race([retrieve(), cancelled]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
