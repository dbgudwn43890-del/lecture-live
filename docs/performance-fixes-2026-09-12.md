# Performance fixes — 2026-09-12

The review covered commit `2533c17`. The owner approved fixing every finding and deleting the advertising files.

## Changes

- Removed 811 advertising source/export files (250.79 MiB tracked content) from `output/`. Application assets remain. Excluded output from TypeScript and deployment inputs and ignored future advertising exports. Git history is not rewritten.
- Reuse the verified FFmpeg decoder in GitHub Actions. The cache key includes the pinned Ubuntu runner, architecture, installer, downloader and source archive. The installer identity includes its complete build recipe and still checks the executable version before reuse. No codecs or verification limits changed.
- Prepare the bounded PDF worker before `npm test`, including a fresh CI checkout.
- When live assist remains disabled in the same session, retain the latest input without rebuilding transcript/context or publishing an unchanged state. Enabling still establishes the current speech baseline.
- Concurrent note reads share a request. A 15-second deadline covers response headers and the JSON body, releases stalled reads and preserves polling, explicit retry, generation invalidation and quiet disposal.
- Share PDF documents only while their rendered pages have consumers. Cancel a departing page's render, and abort the URL request/destroy the loading task after the final consumer leaves. A one-turn release delay preserves Strict Mode reuse. Reopening requests a fresh signed URL.
- Reuse the chart number formatters without changing locale, precision or scientific notation boundaries.
- Run upload expiration/storage cleanup with Next `after` so it does not delay the status response. Owner scoping, persistent deletion jobs and retries remain; cleanup failures do not fail the status read.
- Remove the always-empty question context fields/branches, duplicate concept validation and unread diagram ref. Preserve material retrieval, saved-answer fidelity and DB field limits.
- Pass the required `Error` reason when cancelling a PDF.js text reader. The installed PDF.js 6.3.289 rejects cancellation without that reason; this was verified with a synthetic PDF.

## Validation

- Final production Turbopack build, TypeScript check and all 945 application tests passed. Separate recording-preflight/relay tests: 54 passed. Build helper tests: 16 passed.
- Local recording baseline: the server was initially absent; relay health passed. Started a new local server without restarting another process, then all actual local HTTP recording preflight checks passed before editing and after changes. Production HTTP recording preflight also passed.
- Disabled live assist, 60 simulated clock updates: zero transcript/history reads and zero state publications after initialization. Enable/session-switch/pending-answer regressions passed.
- Actual loopback HTTP tests cover stalled headers and partial JSON bodies; additional tests cover the combined deadline, late completion, retry and disposal.
- Real browser/PDF.js check with a synthetic two-page PDF: one document load shared by two canvases; retaining one page kept the document alive; closing the final page destroyed it; reopening created a fresh load and rendered both pages without errors. The temporary unauthenticated test route was removed before the release build. This verifies the renderer lifecycle, not production authentication or the OS print dialog.
- Copied a real built decoder into a fresh isolated checkout with no source archive. Installation reused that cache in 0.204 seconds with an unchanged binary timestamp, without compilation. The previous GitHub run spent about 32.5 seconds compiling FFmpeg during a 46-second install.
- During parallel build/test execution the pre-existing intermittent huge-PDF worker `TypeError` occurred once. Subsequent sequential full tests passed. Repeated isolated synthetic runs did not reproduce that TypeError, so its cause is not claimed fixed. The independently confirmed cancellation contract violation was corrected; normal PDF, resource bounds and cancellation tests passed.

Capture/PCM, speech sockets, token issuance, provider calls, credit accounting, relay transport and recording controls were not changed. This validation did not initiate a new authenticated microphone or tab-audio transcription. Operational deployment requires access to the existing Lecue Vercel project; no environment values or database schema were changed by this work.
