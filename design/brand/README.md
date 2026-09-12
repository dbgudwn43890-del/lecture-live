# Lecue folded-L brand assets

Approved direction: B, a folded bookmark forming L.

- `lecue-logo-b-v1.png`: original approved symbol and wordmark.
- `lecue-symbol-b-master.png`: transparent symbol generated from the approved logo with built-in imagegen.
- `/public/brand/lecue-symbol-b.png`: 256px web mask; follows foreground color in light/dark themes.
- `/app/icon.png`: 64px browser icon on white.
- `/app/apple-icon.png`: 180px home-screen icon on white.

Generation prompt: Extract only the approved folded-bookmark L; preserve shape, proportions, rounded corners and diagonal negative-space fold; remove lettering; pure black on transparent background with balanced padding. Assets resized using Sharp.

Applied to landing header/footer and example notebook seal, login, billing, legal header, classroom/sidebar loading state, and phone microphone header. Classroom uses the symbol alone with an accessible home-link label.

Validation: app tests 766 passed; relay tests 26 passed; typecheck passed. Local recording HTTP preflight passed before and after. Initial sandbox-only network fetch failed; unrestricted read-only check passed. Browser verified desktop/mobile landing and dark login, theme-following mask, generated icon links. Existing design-detector warnings concern pre-existing borders/animations, not the logo additions.

No recording lifecycle, provider, authentication, billing behavior, or server configuration was changed. No real audio test or production deployment was performed. Existing unrelated working-tree edits were preserved.

## Production update — 2026-09-11

Logo B is deployed at https://www.lecue.app, including tab/apple icons, link-preview image, login and billing page branding. Deployment and verification: `docs/logo-deployment-2026-09-11.md`. Paddle's separately hosted payment overlay logo is still pending because no logo upload control was available in the inspected live dashboard.
