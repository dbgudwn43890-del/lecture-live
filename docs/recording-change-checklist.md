# Recording change checks

Required by the user on 2026-09-10 after repeated recording start failures.

## Before and after a change

Run against the real target, not an exported HTML fixture:

```sh
npm run check:recording
npm run check:recording -- --base-url https://www.lecue.app --relay-url wss://lecue-stt-relay.lecue-app.workers.dev/v1/listen
```

The command reads only the public relay address from `.env.local` or its flags.
It checks enforced CSP, microphone/display-capture policy and the relay's public
health endpoint. It does not acquire audio, authenticate, issue a ticket, modify
the database, consume credits or call a paid speech provider.

No CSP/health failure does **not** establish successful recording. An active
recording on another tab/device, consent, auth, credits and the upstream provider
can still prevent a new recording. Diagnose the failing stage from safe metadata;
do not print tokens, cookies, keys, transcripts or raw upstream bodies.

When `STT_RELAY_URL` changes, restart the development server and reload the
browser document after checking for active recordings. Next API environment HMR
does not refresh a CSP captured when `next.config.ts` initialized.

## Automated regression checks

```sh
node --test scripts/check-recording.test.mjs
npm test
npm run typecheck
node --test workers/stt-relay/index.test.mjs
```

For transport/queue/Worker changes, use the installed Miniflare runtime and run
these actual workerd network tests with synthetic PCM and mocked providers:

```sh
MINIFLARE_MODULE=/private/tmp/lecue-relay-runtime-check/node_modules/miniflare/dist/src/index.js node --test workers/stt-relay/runtime.test.mjs
MINIFLARE_MODULE=/private/tmp/lecue-relay-runtime-check/node_modules/miniflare/dist/src/index.js STT_RELAY_LONG_SMOKE=1 node --test workers/stt-relay/runtime.test.mjs
MINIFLARE_MODULE=/private/tmp/lecue-relay-runtime-check/node_modules/miniflare/dist/src/index.js STT_RELAY_QUEUE_SMOKE=1 node --test workers/stt-relay/runtime.test.mjs
MINIFLARE_MODULE=/private/tmp/lecue-relay-runtime-check/node_modules/miniflare/dist/src/index.js STT_RELAY_CONTROL_SMOKE=1 node --test workers/stt-relay/runtime.test.mjs
```

If that temporary runtime no longer exists, locate/install the normal Miniflare
test dependency; do not mark this gate passed without running it. These tests
cover socket lifetime, the minute allowance boundary, buffered audio ordering,
and slow control responses. They are not real Deepgram/Soniox microphone tests.

## Browser and release verification

- In an authorized test session, confirm microphone/tab-audio start, transcription,
  more than 60 seconds across credit renewal, pause/resume, and end for changed
  paths. Exercise reconnect if transport changed. Do not silently stop a user's
  ongoing lecture to conduct the test.
- For a concurrent-recording fix, verify the second start explains the conflict,
  opens no speech socket, and does not pause/finish the first recording. Verify
  starting works again after the existing recording ends. Preserve the database
  lock as the authoritative protection against simultaneous requests.
- Run preflight against the candidate and production URLs and verify source
  hashes/build status. Browser tabs already open must load the new document after
  their recording is finished.
- In the work report, distinguish unit/mock tests, actual HTTP/Worker tests, and
  real authenticated voice tests. Explicitly record any unverified layer.
