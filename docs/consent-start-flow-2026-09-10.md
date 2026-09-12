# Continue the requested action after consent

## Scope

Fix the first-use flow that returned to preparation with a “ready, click again”
notice after the user had already chosen to listen to a lecture.

- Remember whether the user chose microphone, browser-tab audio, or a recording file.
- Make the final consent button continue that action; remove the redundant ready notice.
- Keep native source/file selection in the consent click's activation window. Recording,
  audio metering, session creation, uploads, and speech-provider connections wait for
  successful consent persistence.
- Dispose acquired or late-arriving media if consent fails or the workspace closes.
  Guard duplicate submission synchronously and preserve the action on a failed save.
- Keep browsing available without consent. Consent wording, versions, and server-side
  access checks are unchanged.
- On phones, give the consent CTA its own full-width row and 44px touch targets.
  This is scoped to the consent dialog, not the lecture-deletion confirmation.

Impeccable's onboarding and craft-floor guidance informed action continuity,
explicit CTA wording, and the mobile touch-target correction. No broader redesign
or new animation was needed.

## Verification

- Full automated suite: 561/561 passed, including 28 input tests and 17 recorder-hook tests.
- TypeScript and `git diff --check`: passed.
- Local production Webpack build: passed after the flow implementation.
- Actual React Workspace/recorder browser harness: 10 scenarios passed before the
  mobile touch-target adjustment; all nine functional scenarios passed again after
  that adjustment. Covered both input sources, original-click
  activation, consent-before-recording, duplicate submission, failed consent,
  browse cancellation, file-picker continuation, picker cancellation/retry, and
  cleanup of acquired/late media on failure or unmount.
- Browser harness uses actual application modules with synthetic media and mocked
  API/audio/socket boundaries; it does not exercise a real microphone or a real
  speech provider. The upload test uses Chrome's native file-chooser event with a
  synthetic file. It is not an authenticated production end-to-end test.
- Final layout confirmation: Korean and English at 1440px, 390px, and 320px. No
  horizontal overflow; mobile CTA, browse button, and policy links have 44px touch
  targets. Desktop layout is unchanged. The harness loads local Pretendard but
  substitutes Arial/monospace for Next's Geist/IBM font variables; it is not a
  pixel-identical production typography check.

Evidence: `/private/tmp/lecue-consent-tests-final-20260910.log`,
`/private/tmp/lecue-consent-webpack-20260909.log`, and
`/private/tmp/lecue-consent-browser.KmYu2d/`.

## Release status

Deployed with the user's explicit approval and verified at **2026-09-10 00:29 KST**.

- Production: https://www.lecue.app
- Deployment: `dpl_DZ3dyBV89BzKBGyZWBRgTCMYhq6i`
- Candidate: https://lecue-omvmfz03m-dbgudwn43890-dels-projects.vercel.app
- Previous production: `dpl_E4DQFs9hzDWorsjVMzNV11pk6tkW`
- Both lecue.app and www.lecue.app, plus the project's Vercel aliases, point to
  the new READY deployment.

The other active task confirmed ownership and validation of the accompanying
recording-connection fixes. The matching speech relay Worker was already deployed;
this release did not redeploy it or change its configuration. A separate release
snapshot preserved the shared worktree and excluded four newer, unverified
live-assist experiment files by using their exact previous-production contents:
`app/api/live-assist/route.ts`, its test, `app/lib/live-assist-client.ts`, and its test.
This preserves existing production behavior rather than removing the earlier feature.

Release verification:

- Snapshot tests 561/561 and typecheck passed. Local dependencies and the audio
  decoder were shared only for testing and excluded from the upload.
- All 332 uploaded source-file hashes (338 entries including empty directories)
  match the frozen, validated release manifest.
- Vercel production build passed. The candidate was built with `--skip-domain`,
  checked, and then promoted without another source upload.
- Candidate smoke checks passed: public pages, classroom sign-in redirect, five
  protected APIs, consent API authentication, and PDF worker availability.
- Live production checks passed: `/` and `/en` 200; `/classroom` 307; anonymous
  `/api/consents` 401; PDF worker 200 with the expected installed-worker SHA-256
  `a33cfe728c584fdba4fcc1fd54bcdc2f9f2f13889ddbb5b2bd1d0f8cbe49b84e`.
  Content Security Policy remained present on all five responses.
- No authenticated production recording, user consent write, or paid provider
  request was used for release verification. The real native media permission UI
  and a full production lecture remain outside this automated check.

Release evidence is in `/private/tmp/lecue-consent-release.giGCgw/` and
`/private/tmp/lecue-consent-*-20260910.*`. No Git commit/push, database migration,
or shared source rollback was performed. Finish an open lecture before refreshing
to load the updated browser code.
