# PDF context reliability — 2026-09-09

## User requirement

Uploaded materials must support ordinary questions without the learner naming a page. The previous explicit-page fix addressed only one symptom. Existing answer text is historical; changing retrieval affects new answers, not previously saved responses.

## Confirmed causes in code

- General retrieval kept a 600-character opening excerpt per document, four question matches and two recent-transcript matches, all behind a similarity threshold.
- Embedding or any retrieval RPC failure discarded detailed material context and retained only opening excerpts.
- General document discovery was limited to the four newest attachments even though a session supports twenty.
- A successful document upload and a successful relevant excerpt lookup were incorrectly treated as interchangeable by the answer context.

## General question retrieval

- Discover all twenty supported attachments within the current user's session. Read a bounded index window with a lookahead to distinguish complete stored text from a prefix.
- Supply complete indexed text when it fits one shared 60,000-character context budget. This avoids dependence on similarity scores for ordinary slide decks.
- Search large indexes with sanitized literal keywords as well as semantic similarity. Include neighboring passages around strong matches and retain keyword/index context when embeddings or semantic RPCs fail.
- Merge duplicate hits, prioritize the question and recent lecture context, and report full/selected/unavailable stored-text coverage to the answer model. A failed read is not evidence of a missing upload.
- Current material evidence takes precedence over earlier AI claims that it could not see the material. Indexed text does not imply inspection of PDF graphics or scanned pages.
- Preserve exact-page lookup as an additional supported case. General questions do not download every original PDF or add a separate LLM retrieval round.

## Ingestion safeguards

- All native PDF pages are read before saving an index; an interior-page failure cannot save a partial document.
- PDFs exceeding the existing 500-page processing limit are rejected with a clear split-file instruction, instead of silently treating the first 500 pages as the whole file.
- Embedding responses must contain one valid indexed vector per chunk before any document or original-file write.
- PDF workers are destroyed after success or failure.

## Verification scope

- Upload-route regressions verify middle/final-page retention and partial-ingestion failure handling.
- A self-contained twelve-page PDF is read by the real PDF.js engine and passed through chunking, verifying all twelve distinct topics survive. No PDF.js mock, private source, or paid model is used in that integration test.
- General question route tests verify complete twelve-page text without page syntax, a topic on page80 outside the preview, keyword/neighbor fallback after embedding failure, semantic RPC failure, the sixth attachment, and owner isolation. Context tests cover all twenty identities, ranking, full/partial states and the shared character budget.
- Full suite: **475/475 passed**. Type checking and production build passed. No paid AI answer evaluation was run.
- The user's private uploaded PDF has not been read in this work: the prior automatic approval rejection remains respected.
- Released to production on 2026-09-09 as `dpl_DujVgGqSUTaWgDY2qxURFHRBfz3k`; see [deployment record](deployment-2026-09-09.md). Verification above remains local/integration verification, not a paid production answer test.
