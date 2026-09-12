# Jarvis lecture flow and microphone handoff

Implemented locally; not deployed in this change.

## UI

- Listening indicator and text sit slightly lower; two restrained orbital arcs reuse the existing microphone level. Hidden documents and reduced-motion preferences stop rotation.
- Clicking opens a native, light-dismiss popover (maximum 420px wide / 440px high) with chronological, lightly shortened speech. Outside click, Escape and close control dismiss it. No raw transcript fallback, section headings or note-style bullet points.
- A workspace-level controller processes final speech even while the popover is closed: first request after about 1.5 seconds, later requests at least 5 seconds apart, one request at a time. These are request timings, not guaranteed display latency; persistence and model processing add time. Pausing/ending flushes the pending tail.
- `/api/live-script` resolves stored segments only after verified-email and session-ownership checks. It uses GPT-4o-mini with strict structured output to remove fillers/repetition while preserving chronology, uncertainty, questions, negation, numbers and mixed-language terms. It does not answer spoken questions or create study notes.
- Bounded retries handle persistence lag, rate limits and transient errors. Session changes abort pending work; source corrections invalidate the affected passage. A bounded sessionStorage cache contains only processed text and opaque fingerprints, not raw transcript-bearing segment IDs. Scrolling up preserves the reading position; a latest-content button restores auto-follow.
- Existing 10-minute summaries remain a separate internal AI-context mechanism. The Jarvis popover no longer waits for or displays them.

## Phone ↔ computer

- Source selector is an action control so a refreshed phone session can explicitly select computer even before phone pairing is restored.
- Pairing a phone leaves existing computer capture running. Once ready, the hook drains and confirms pause, then resumes the same session with the replacement. This is a short interruption, not gapless recording.
- Preserves transcript, clock offsets, server concurrency and credits. Failures remain paused; unadopted pairs are disposed, adopted pairs retained for retry. Phone session restoration hints are persisted even if resumed capture fails.
- No Worker, relay protocol, schema, environment or credit policy changes.

## Verification

- Initial local preflight failed: dev server was not running (old lock PID absent). Started a new server without stopping/reloading any recording. localhost preflight then passed; 127.0.0.1 redirects to localhost.
- Application suite: 676 passed; TypeScript and diff check passed.
- Recorder suite includes 11 handoff regressions. Related PCM/phone/token/session/live-assist and relay unit tests passed.
- Real browser sample-data fixture: desktop/mobile, dark/light, summary and empty state, outside dismiss, Escape and trigger focus verified. Temporary fixture removed. This is not authenticated production lecture-data QA.
- Actual phone/computer microphone audio, real transcription and hardware handoff have NOT been tested. These must be verified before claiming real-device recording stability.

## Follow-up: real-time transcript clarification

- Replaced the initial 10-minute-summary UI with the live processing pipeline above; no microphone, Worker, relay protocol, environment or schema changes in this follow-up.
- Application suite: 710 passed, including 16 live-script API and 18 client-controller regressions. Recording preflight/relay suite: 54 passed. TypeScript and diff checks passed.
- Before/after checks against the actual localhost server passed CSP, microphone/display-capture policy and public relay health. An initial sandbox-restricted post-check could not fetch either endpoint; the authorized read-only check passed without restarting the server.
- Browser QA used synthetic final speech and a mocked model response, with the actual client controller and popover. Processing while closed and appending on reopen were verified, including a 390px light-theme layout. The temporary fixture was removed.
- Real provider output quality/latency was not evaluated: the synthetic provider smoke call was denied by network approval, and was not retried through another mechanism. No actual microphone audio, production lecture data or deployment was exercised in this follow-up.
