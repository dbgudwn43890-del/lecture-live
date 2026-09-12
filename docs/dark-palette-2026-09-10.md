# Dark palette refinement — 2026-09-10

- Request: reduce green cast; use black/charcoal for dark mode.
- Dark surfaces: paper `#151515`, panels `#202020`, raised menus `#292929`; neutral text, borders, selected backgrounds. Muted sage remains on controls; status colors remain meaningful.
- Shared tokens now drive classroom, login, billing/profile, notes, and phone microphone dark surfaces. Landing's separate light-dark palette matches. Light colors and recording behavior were not changed.
- Edited CSS: `app/globals.css`, `app/classroom/workspace.css`, `app/landing-experience.css`, `app/phone-mic/phone-mic.css`.
- Verified in Chrome: classroom dark screen, billing desktop, landing light/dark at 390 CSS px, phone microphone dark at 390 CSS px. Viewport override reset.
- Contrast: secondary text on raised menu 6.48:1, body on panel 14.55:1, primary button label 10.07:1.
- `git diff --check` passed. Impeccable detector reported existing out-of-scope layout/motion patterns; no layout/motion changes made.
- Pre-edit recording HTTP preflight passed with network access; initial sandbox-only fetch failed. Active recording appeared during visual review, so no server restart, recording-tab navigation, or build was performed. No microphone/STT validation claimed for this CSS change.
- Before-change source copies: `/private/tmp/lecue-dark-before/`.

## Production deployment

- Released to `https://www.lecue.app`: `dpl_2d3hpjGJ4LzrSo1DGcWbGMvh3xpJ`, READY.
- Candidate: `https://lecue-8v6fifcm5-dbgudwn43890-dels-projects.vercel.app`.
- Preserved the latest listening release `dpl_E6YCbXrb8tTpVqygGx5M2xN2M4sY`. All four before-change CSS copies matched that release exactly.
- Frozen snapshot: `/private/tmp/lecue-dark-release.i376bg87`. All 351 uploaded source file hashes matched the tested manifest `/private/tmp/lecue-dark-release-inputs.json`.
- App tests 651/651, typecheck, recording preflight/STT Worker unit tests 54/54, build-tool tests 14/14 passed. Linux production build completed.
- Two earlier candidates failed because the Vercel builder could not connect to ffmpeg.org. Included the existing official FFmpeg 8.1.2 source archive (previously signature-verified; SHA256 `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`). Installer uses this source with the same hash verification, version and audio-only configure flags. A missing file falls back to the existing bounded download; corrupt/unreadable source fails closed. No STT transport/Worker/environment changes.
- Production changes: four CSS files, pinned-source helper and tests, installer, official source archive. No unrelated working-tree changes or environment files uploaded.
- Local port 3000 was no longer running at deployment time. Separate snapshot server on localhost:3102 passed actual HTTP recording preflight; then stopped only that test server. No recording tab reloaded. Candidate and production CSP/Permissions-Policy/relay-health checks passed; anonymous protected APIs returned 401; public phone page retained noindex/no-referrer and its WebSocket policy.
- Production CSS verified: neutral global dark tokens and the landing dark palette (compiled by Lightning CSS). Production domain ID rechecked after promotion. Real microphone/STT audio was not re-tested for this color/build-source change.
