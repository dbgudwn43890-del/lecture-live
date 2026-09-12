<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# User preferences

- Do not use Ponytail or related skills unless the user explicitly asks.

# Recording stability gate

The user requires this check whenever a change can affect speech recognition.
Treat capture/PCM, recording lifecycle, live-assist timing, token issuance,
relay/callbacks, auth/consent/credits, CSP/Permissions-Policy, environment settings,
and server/build/deployment changes as recording-impacting until checked.

- Before editing, identify the affected connection stages and run
  `npm run check:recording` against the actual local server. Record existing
  failures so an old failure is not attributed to a new change.
- Preserve active recordings. Check before restarting a server, reloading a
  recording tab, or changing a relay. Do not terminate another tab/device's
  session to make a test pass; retain account-level concurrency and credit checks.
- Add a regression for the observed failure. Run the relevant recorder, token,
  relay and live-assist tests plus typecheck after changes. Include
  `node --test scripts/check-recording.test.mjs` when the preflight changes.
- Environment changes affecting Next config require a full dev-server restart
  and a fresh browser document when no recording is active. HMR is insufficient:
  inspect actual HTTP CSP/permissions with `check:recording` again.
- For transport/queue/Worker changes, also run the actual workerd network smoke
  tests in `docs/recording-change-checklist.md`, including the minute boundary.
- Before and after deployment run the same preflight against the release URL
  and `https://www.lecue.app`. Verify the deployed source matches the tested copy.
- Confirm actual microphone/tab-audio start, pause/resume and end when these
  paths change. Report separately what was mocked, checked over HTTP, and tested
  with real audio. A green preflight or mocked test does not prove transcription.
- Error messages must state a verified cause and an action where known. An
  existing recording, missing consent, exhausted credits or blocked microphone
  must not be reported as a generic internet connection failure. Never expose
  tickets, provider keys, or raw upstream responses in messages or logs.

Commands and verification boundaries: `docs/recording-change-checklist.md`.
