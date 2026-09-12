# Shared logo alignment — 2026-09-11

The folded-L PNG has transparent margins: alpha bounds (58,45)–(203,217) in a 256×256 canvas. Billing/login combined a 1.5em canvas with an extra 8px gap; landing used separate corrections. This made the visible symbol too large and separated from the lettering.

Set shared `.brand-lockup` gap to 0 and its symbol to 1.15em with translate(.08em,-.08em). Removed the landing-only correction. This preserves the actual visible gap inside the image while aligning the symbol with the lettering. The image asset, favicon, classroom text logo and standalone symbols are unchanged.

Verified real localhost billing (desktop), landing and login (mobile) in isolated Chrome, with the actual fonts loaded. Computed dimensions match; no horizontal overflow. TypeScript and 810 existing tests passed. Recording preflight passed before/after localhost and before production deployment. The design detector reported five pre-existing global CSS findings outside this change; none were added at the changed lines.

Deployed to https://www.lecue.app (dpl_FYLnTEQGed6D1wBeEgh417E3zsSF). All 395 deployed source hashes match the frozen source and final workspace. Actual production Chrome checks passed for billing, landing and login logos; dimensions and optical offsets match localhost. Production alias and before/after recording HTTP preflight verified; authenticated Vercel candidate headers used for the protected release URL. No actual audio capture was started for this CSS-only change. Release artifact and source manifest: `/private/tmp/lecue-logo-align-release-path.txt`, `/private/tmp/lecue-logo-align-release-shas.json`.
