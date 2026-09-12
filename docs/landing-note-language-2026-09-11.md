# Landing copy and review-note language

## Applied scope

- Shortened Korean and English landing copy around listening together, asking, and reviewing. Preserved the existing page design, sample math, inline demo, navigation, and return/Escape behavior. The sample is labeled; it does not activate a microphone or imply automatic replies.
- Added a compact language picker to classroom Settings and the review-note dialog. Default: the first supported device/browser language (`navigator.languages`), then the display locale if none matches. Explicit choices are English, Korean, Spanish, Japanese, simplified Chinese, French, German, Portuguese, and Hindi.
- The choice is stored per browser in `lecue-note-language`; system language and cross-tab storage changes are observed. It is independent of display and speech-recognition language.
- Note POST requests carry a validated concrete language, never `system`. The prompt and schema follow it; the server saves trusted language metadata after content validation. Missing language preserves older clients' display-locale fallback. No database migration.
- Existing notes do not change on selection. Explicit regeneration applies the selection; active jobs, original questions, source identifiers, and previous content on failure remain intact. The picker is disabled during generation. Selection alone makes no generation request or charge.

## Verification

- Before/after actual localhost recording preflight: passed. Production preflight before release: passed. Capture, transport, concurrency, credits, and relay configuration were not changed.
- Full app tests: 805 passed at the integration checkpoint; language controller follow-up: 20 passed. Note backend/resolver focused suite: 60 passed. Recording preflight tests: 28 passed. TypeScript passed.
- Isolated Chrome using actual note components/CSS: English desktop light/dark, Korean 390px dark and 500px settings layout; checked menu bounds, keyboard/Escape focus return, choice persistence, and submission/disabled behavior. No actual AI note generation, microphone access, or paid model calls.
- Actual local landing: English desktop and Korean mobile checked, with no horizontal overflow. Impeccable detector passed for changed landing/picker files.
- Release source is frozen separately from the dirty workspace; only the 16 files in this feature differ from the previously verified production source. Test harnesses, environment files, and documentation are excluded from deployment.

## Release

Candidate: `https://lecue-14wcb08ja-dbgudwn43890-dels-projects.vercel.app` (`dpl_BQ62euuj9tiGcuU7E4B25EGKYpFv`).

Deployed to https://www.lecue.app. Build passed; all 395 uploaded source hashes matched the frozen source and final workspace.

Candidate URL has Vercel login protection. Anonymous preflight correctly stopped at its cross-origin login redirect; authenticated Vercel CLI GET returned HTTP 200 with the new landing. The same recording checker passed using these actual response headers and a live relay health read, before and after promotion. Public production preflight passed without authentication.

Production Chrome checks passed for Korean desktop (1440px) and English mobile (390px): new hero copy, inline demo opens with answer hidden, question reveals answer, 50%/57.5% equal-weight calculation, Escape closes and restores focus, no horizontal overflow or page errors. No real audio transcription or paid note generation was performed for this UI/output-language change.
