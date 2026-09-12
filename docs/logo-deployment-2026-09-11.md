# Lecue logo B production deployment — 2026-09-11

User authorized logo application and production deployment, including tab icons, link previews, login and billing branding.

Production: `dpl_Vg1HY6oHJ6L8JfzrseyT67S7qQR1`
Release: https://lecue-8oz9tr6pc-dbgudwn43890-dels-projects.vercel.app
Canonical: https://www.lecue.app
Previous production: `dpl_JCAU4C11cd9ZcaJwzhVoMVkJEUYm`

## Isolation

Created `/private/tmp/lecue-logo-release-zrcet7_4` from the exact previous production source (357 SHA1 matches). Changed 13 logo/metadata files, adding 4 assets. All 361 uploaded source SHA1 values match `/private/tmp/lecue-logo-release-shas.json`. Vercel-generated `out/` entries are build output, not uploaded source.

Unrelated pending recording, security, environment, database and relay changes were excluded. No recording tabs were reloaded or stopped. No DB migrations or payment transactions were performed.

## Verification

- Isolated release: 689 tests passed and typecheck passed; production build succeeded.
- Recording HTTP preflight passed locally and before/after deployment for production and candidate.
- Candidate direct request initially encountered Vercel SSO protection. Retested the same `runRecordingCheck` implementation using authenticated `vercel curl` HTTP headers; all seven checks passed.
- Production and release post-deploy preflight: all seven checks passed.
- Production asset bytes match local files for icon.png, apple-icon.png, symbol and social image.
- `/`, `/en`, `/login`, `/billing` return symbol markup, icon links and social image metadata.
- Production domain inspection confirms the new deployment.
- Earlier browser visual review covered desktop/mobile landing and dark login. No real microphone/transcription test was performed for this visual-only release; HTTP checks and unit tests do not prove transcription.

## Paddle boundary

The site's billing screen has the logo. The authenticated live Paddle dashboard was inspected at Checkout Settings (General/Overlay), Account Settings and account menu. Overlay exposed brand color only; no logo upload control was found. No Paddle settings were changed. Branding inside Paddle's separately hosted payment overlay remains unapplied; do not report it as complete.

Coordinated with the separate security/recording task so its subsequent release incorporates these logo changes.
