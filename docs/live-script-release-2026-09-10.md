# Live-script release — 2026-09-10

## Scope

- Release the lightly edited, continuously appended transcript behind the Jarvis control. First batch is requested after about 1.5 seconds; subsequent batches at least 5 seconds apart, plus persistence/model latency.
- Exact current production source was recovered by SHA-1 matching all 351 source files. Only nine requested live-script files were added/changed; no production source was removed.
- Workspace integration was patched onto that baseline separately so unrelated local microphone-switch and lecture-summary changes were not included.
- No migrations, environment changes, new dependencies or relay deployment.

## Release hardening

- Korean text-derived segment identifiers expand substantially in the Supabase GET URL. Split lookups into conservative 4,000-encoded-character groups, with no more than four concurrent reads; retain ownership checks, exact coverage and chronological order.
- Reject an individually oversized identifier with 413 before database/provider access. The client explains the size limit without suggesting an automatic retry; earlier processed entries remain visible.
- Regression tests use the real installed Supabase SDK with a fake fetch to check actual URL encoding, not a provider or production database call.

## Verification before promotion

- Isolated release application suite: 689 passed, including 19 API and 19 client live-script regressions.
- Isolated relay suite: 26 passed. Recording preflight suite: 28 passed. TypeScript passed.
- Actual localhost, existing production release URL and `https://www.lecue.app`: enforced CSP, relay WebSocket, AudioWorklet/Worker, microphone/display-capture policy and public relay health passed.
- Upload audit: 357 files, all source hashes equal the tested release manifest; no environment files, temporary QA page or local analysis artifacts.
- Microphone capture, provider transcription and microphone handoff were not changed in this isolated release. Real microphone audio and actual model-output quality/latency were not tested.

## Deployment

- Baseline: `dpl_2d3hpjGJ4LzrSo1DGcWbGMvh3xpJ` (`lecue-8v6fifcm5-dbgudwn43890-dels-projects.vercel.app`).
- Candidate: `dpl_JCAU4C11cd9ZcaJwzhVoMVkJEUYm` (`lecue-hw10os5du-dbgudwn43890-dels-projects.vercel.app`).
- Candidate built successfully (`READY`) with production configuration while automatic domain promotion was disabled. All 357 uploaded source hashes matched the tested manifest before promotion.
- Promoted successfully to `https://www.lecue.app`; final inspection confirmed production points to `dpl_JCAU4C11cd9ZcaJwzhVoMVkJEUYm` in `READY` state.
- Before and after promotion, both candidate URL and production domain passed the recording HTTP preflight. Anonymous POSTs to `/api/live-script`, `/api/deepgram-token` and `/api/live-assist` returned 401 on the deployed candidate. Existing recording sessions were not reloaded or stopped.
- This verifies build, source identity, HTTP policies and authentication rejection only, not real audio recognition or model output quality.
