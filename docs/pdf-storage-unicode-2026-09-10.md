# PDF text storage Unicode fix

## Report and diagnosis

The user saw “이 자료를 저장하지 못했습니다.” when uploading a PDF on
localhost. The actual request log was `Material chunk save failed 22P05` and
`POST /api/materials 500` after approximately four seconds. Extraction and
embedding had completed; the failing stage was storing material text chunks.
The private PDF was not read or sent to another provider during this diagnosis.

Two independent unsafe text paths were reproduced:

1. PDF text extraction could retain NUL or unpaired UTF-16 surrogates. PostgreSQL
   JSON/text cannot store NUL and requires valid surrogate pairs. A synthetic NUL
   payload produced the same `22P05` as the reported upload.
2. `chunkPages` split strings every 1,800 UTF-16 code units. A valid mathematical
   character `𝑥` across that boundary became two invalid strings. Actual
   PostgreSQL rejected that separate reproducer with `22P02`.

The exact offending character in the user's private PDF has not been inspected.
The normalization covers both failures without requiring the original document.
Reference: [PostgreSQL JSON types and Unicode handling](https://www.postgresql.org/docs/17/datatype-json.html).

## Fix

- Normalize extracted text before indexing: remove NUL and replace already
  unpaired surrogate fragments with U+FFFD. Preserve valid text, mathematical
  symbols, combining characters, Korean/Japanese/English, whitespace and page IDs.
  Do not apply NFKC or flatten distinct mathematical characters into plain letters.
- Keep a complete surrogate pair on one side of each chunk boundary. Concatenated
  chunks retain every original valid character, including `𝑥` and emoji.
- Apply the same guard to Office-model extraction and stored terminology. Term
  truncation in the existing glossary utility may itself leave a lone surrogate.
- Limit filenames by complete Unicode characters. The original PDF bytes and
  private storage/ownership rules are unchanged.
- Plain-text file validation remains strict; this does not turn arbitrary binary
  TXT/CSV files into accepted text.

Only `app/api/materials/route.ts`, its test, `app/lib/material-text.ts` and its
test changed. The speech capture, recorder, token/relay, environment, billing and
database schema were not changed. The recording preflight passed before the edit.

## Verification

- Frozen release application tests: 577 passed, including 14 material upload
  route tests. Typecheck and diff check passed.
- Upload-route tests emulate PostgreSQL rejection of NUL/invalid surrogates and
  verify successful storage, identical embedding/stored text, no cleanup on
  success, and complete Unicode filenames. The Office path is covered too.
- Actual PostgreSQL read-only `jsonb_to_recordset` checks with synthetic data:
  old chunk split → `22P02`; old extraction artifacts → `22P05`; both corrected
  payloads → accepted. No production rows were read or written by those checks.
- No new paid model call, private PDF reading, or real production upload was
  performed by the assistant. The user retried the same PDF locally and confirmed
  successful upload. Local logs also recorded successful HTTP 201 responses.
  Their separate report that live-assist did not use the uploaded material is
  addressed by the live-assist context work, not by this storage fix.

Evidence: `/private/tmp/lecue-pdf-unicode-db-check-20260910.log`,
`/private/tmp/lecue-pdf-unicode-release-tests-20260910.log`,
`/private/tmp/lecue-pdf-unicode-release-info-20260910.json`.

## Release

Frozen copy: `/private/tmp/lecue-pdf-unicode-release.icqg7p`, based on the exact
previous production `dpl_4SC61u84AeN3mdirTZr49qVmtMYb` with only the four files above
replaced. Candidate `dpl_5w4yFTTK4BGg6aGywk7KpWi5WzYQ` is Ready; all 332 uploaded
source hashes, recording preflight, and anonymous API rejection checks passed.
The standalone candidate was not promoted. This fix was included in the verified
live-assist context release `dpl_7coEToSjkR8uzZQwXFdm36cmWxb5`, now promoted to
`https://www.lecue.app`. The combined release passed 605 tests, all 334 source
hash checks, candidate API/recording checks and post-promotion recording preflight.
