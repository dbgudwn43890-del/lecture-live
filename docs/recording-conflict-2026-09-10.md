# Recording conflict diagnosis and release

## Confirmed cause

The repeated start failure in this incident was an existing recording on another
tab/device using the same account. Read-only metadata showed unused tickets for
failed starts and a different session with an actively renewed lease and advancing
PCM byte count. The user independently confirmed simultaneous use of the account.
Actual local and production CSP and relay health checks passed.

`open_stt_relay_service` correctly rejects another active connection with
`CONNECTION_ACTIVE`. A rejected WebSocket handshake does not expose its HTTP
response body to browser JavaScript, so the recorder displayed an unspecific
speech-connection message that incorrectly suggested checking the network.

## Change

The authenticated ticket route checks the current user's other live relay lease
before issuing a ticket. It returns HTTP 409, `RECORDING_ALREADY_ACTIVE`, and:

> 다른 탭이나 기기에서 녹음 중입니다. 해당 녹음을 일시정지하거나 종료한 뒤 다시 시작해 주세요.

English receives an equivalent instruction. No active session ID, ticket or key
is returned. The existing recording is not modified. Expired/closed leases and
other users' recordings do not block the account. Same-session reconnects retain
their existing behavior. The database lock remains authoritative for races after
the preliminary read; this change does not weaken concurrency or billing rules.

The recorder already preserves server error text. A new lifecycle regression
verifies this exact message, capture cleanup, no speech socket, no false audio-loss
notice, no automatic retry loop and successful deliberate retry after the conflict
is removed. Only the new failed attempt is cleaned up.

## Durable checks

`AGENTS.md` now requires a recording-impact check before related changes and
separate local/deployed verification. `npm run check:recording` checks actual CSP,
microphone/display-capture policy and the public relay health endpoint without
recording or paid API calls. See `recording-change-checklist.md` for the complete
gate and its limits. A passing HTTP preflight is not proof of actual transcription.

## Verification

- Application tests: 569 passed in the shared workspace and isolated release.
- New preflight tests: 28 passed; typecheck and diff check passed.
- Actual local and production preflight: passed before deployment.
- Verified live-assist UI and API use the exact verified administrator email
  `dbgudwn43890@gmail.com`; unauthorized, unverified and anonymous users are rejected
  before provider calls. Today's short-follow-up detection and content-free latency
  measurements are included in this release (see live-assist implementation log).
- No new real microphone, paid speech or paid model evaluation was performed in
  this change. The user confirmed the concurrent-recording cause. Real voice
  transcription and end-of-speech-to-answer latency are not asserted by these tests.

## Remaining diagnostic boundary

Two starts racing after the read still rely on the atomic database rejection.
Also, the issuer alone cannot distinguish a same-session reconnect from a second
tab opening that same session. These handshake failures can still have a generic
browser error. The regression fixed here is a different active lecture on the
account, which was the observed and user-confirmed failure.

## Release

Candidate: `dpl_4SC61u84AeN3mdirTZr49qVmtMYb`.
Release directory: `/private/tmp/lecue-recording-release.OSFMAs`.

The release starts from the exact previous production snapshot
`dpl_DZ3dyBV89BzKBGyZWBRgTCMYhq6i` and applies only the verified ticket route,
recorder regression, live-assist changes and package script. Shared worktree
changes are preserved. No database migration, Worker configuration, environment
secret, or cleanup schedule is changed.

Promoted to `https://www.lecue.app` on 2026-09-10 at approximately 00:48 KST.
Vercel resolves that domain to `dpl_4SC61u84AeN3mdirTZr49qVmtMYb` with READY status.
All 332 uploaded file hashes match the frozen, tested manifest. Candidate
preflight and anonymous access rejection on `/api/live-assist`,
`/api/deepgram-token` and `/api/consents` passed (401). Production recording
preflight passed again after promotion. No user recording was stopped or reloaded.

Evidence: `/private/tmp/lecue-recording-release-info-20260910.json`,
`/private/tmp/lecue-recording-candidate-check-20260910.log`,
`/private/tmp/lecue-recording-production-check-20260910.log`,
`/private/tmp/lecue-recording-production-inspect-20260910.log`.
