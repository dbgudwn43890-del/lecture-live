# QR phone microphone — 2026-09-10

## User flow

Classroom → **Use phone as microphone** → scan QR → allow microphone on phone → **Start with this microphone** on laptop. Korean and English included. Phone shows actual PCM input level, capture/connection state and pause/disconnect controls. Questions and answers remain on the laptop. The phone page must stay open/unlocked; wake lock is best effort.

## Implementation

- Phone captures mono signed PCM16 at 16 kHz with the existing AudioWorklet.
- An isolated `lecue-phone-mic` Worker/SQLite Durable Object forwards it to the desktop. Desktop feeds the existing PCM queue and STT path; no changes to the existing STT Worker, provider selection, account concurrency or credit validation.
- Phone gets only room-scoped capability. Owner creation requires verified authentication, recording consent and shared rate limiting. Anonymous claim requires a strong one-time invite, same origin and rate limit. Tokens use URL fragment / WebSocket subprotocol, not request URL parameters. No provider or account keys on phone.
- One owner and one phone per room; duplicate devices rejected. Invite 3 minutes, pairing at most 3 hours. Hashed capabilities and lifecycle metadata only in storage; no stored PCM.
- Phone retains up to 5 seconds /160 KB unacknowledged PCM in memory. Capture ID and sequence numbers deduplicate replay. Flow bounds, ACKs, heartbeat and reconnect protect against silent backlog. Longer disconnect/stall stops capture and asks for reconnect.
- Pause flushes final PCM; resume keeps pair. A full desktop reload remembers only a phone-session hint and requires a new QR to resume the same session, never silently selects the laptop mic. End/cancel/unmount revoke the pair.
- No database migration or new paid subscription required. Uses the existing Cloudflare paid account.

## Verification

- Baseline: local3000 initially not running; recorded fetch failure, started it and obtained passing recording preflight before changes. No existing recording was terminated.
- Frozen app release:649 tests pass, typecheck passes. Includes phone client, recorder external input, API/consent/origin/auth, reload re-pair, PCM sequencing and bounded replay.
- Existing recorder preflight tests and STT Worker tests54 pass.
- Existing real workerd/TCP suites: default,65-second minute boundary, queue/reconnect, slow control all pass. Providers mocked; PCM synthetic.
- New Worker14 unit tests and5 actual workerd/TCP scenarios pass, including65 seconds,5-second replay100-frame/160KB burst, role isolation, reconnect, final flush and expiry.
- Deployed phone Worker:65-second public Internet synthetic smoke passes;1301 frames /2,081,600 bytes received in order. Wrong capability and duplicate owner rejected; phone reconnect and final flush confirmed; only freshly created test rooms deleted.
- Chrome: authenticated local QR creation,45+second owner waiting/heartbeat, cancellation; desktop QR layout and Korean/English phone layouts at390px inspected. No real microphone permission or lecture recording started.
- Candidate public phone page200/noindex/no-referrer/phone WebSocket CSP; originless phone API403; existing materials/live-assist/STT ticket APIs401. Existing recording HTTP preflight passes.
- npm audit found an existing sharp/libheif vulnerability during dependency installation. Updated compatible sharp patch; npm audit now0 vulnerabilities. QR uses local `qrcode`1.5.4; no external QR service.

## Release

Candidate: `dpl_7mt77KoFxmRMjXnT8ifTafqhPP9t`
URL: https://lecue-m2fb6zgbu-dbgudwn43890-dels-projects.vercel.app
Frozen source: `/private/tmp/lecue-phone-release.snM1i0`
346 uploaded source files match the tested SHA1 manifest. Snapshot starts from the preceding verified live release and changes only21 explicit files.
Worker source SHA256: `62797ffc29d882863d9ba9d38779be74d12e88674d314ea8c9e95782e3dc7cae` verified against Cloudflare upload.

Environment: `PHONE_MIC_RELAY_URL` plus encrypted `PHONE_MIC_SECRET`; `.env.phone-mic.local` Git/Vercel ignored. App server restarted after configuration; existing STT URL unchanged.

## Remaining real-device verification

Physical iPhone/Android microphone capture, Safari permission/AudioContext lifecycle, phone lock/background and an actual phone→STT transcript must still be confirmed on a real handset. Synthetic PCM, HTTP checks and browser layout inspection do not establish this. User can check scan→allow→start→speech→pause/resume→end in one short lecture.

## Production completion

Promoted to `https://www.lecue.app` and verified domain resolves to `dpl_7mt77KoFxmRMjXnT8ifTafqhPP9t`, READY. Post-deploy recording preflight all PASS. Phone page200 with exact phone WebSocket CSP/noindex/no-referrer; valid-origin anonymous create401; foreign-origin request403.

Actual application-controller integration also passed against the deployed Worker:20,480 synthetic PCM bytes preserved,2 captures/2 stops, desktop pause/resume plus phone pause,0 unexpected ends, normal final socket closure and pairing revocation. Owner waited12 seconds and stayed paused8 seconds with healthy heartbeat. Only microphone/AudioWorklet input was mocked; both application controllers and WebSocket/Worker transport were real. No STT, account database or private audio in this test.

Chrome production classroom shows the phone entry and QR pairing dialog. Handset recording/transcription remains the real-device boundary described above.
