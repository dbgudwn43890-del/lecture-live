import { chunkPages, type MaterialPage } from "./material-text.ts";

export const MAX_MATERIAL_CHARACTERS = 500_000;
export const MAX_MATERIAL_CHUNKS = 400;
// UTF-8 bytes are a conservative upper bound for byte-based embedding tokens.
// Keep the entire request below the provider's aggregate input limit without
// guessing a characters-per-token ratio for Korean, equations or other scripts.
export const MAX_MATERIAL_TOKEN_BOUND = 250_000;

export function boundedMaterialChunks(pages: MaterialPage[]) {
  let characters = 0;
  let tokenBound = 0;
  for (const page of pages) {
    characters += page.text.length;
    tokenBound += Buffer.byteLength(page.text, "utf8");
    if (characters > MAX_MATERIAL_CHARACTERS || tokenBound > MAX_MATERIAL_TOKEN_BOUND) {
      throw new Error("MATERIAL_TEXT_LIMIT");
    }
  }
  const chunks = chunkPages(pages, 1_800, MAX_MATERIAL_CHUNKS);
  // Page markers added by chunking also consume embedding input tokens.
  tokenBound = chunks.reduce((total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"), 0);
  if (tokenBound > MAX_MATERIAL_TOKEN_BOUND) throw new Error("MATERIAL_TEXT_LIMIT");
  return { chunks, characters, tokenBound };
}
