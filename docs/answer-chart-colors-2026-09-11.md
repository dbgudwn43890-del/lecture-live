# Answer chart colors — 2026-09-11

Requested: use appropriate multiple colors in answer graphs and deploy.

Only runtime changes: `app/classroom/answer-chart.ts` and `app/classroom/learning-answer.css`.

- Plain bar charts assign a distinct categorical color to each row, up to the existing eight-row limit. Their one-series metric label remains, without a misleading single-color legend swatch.
- Stacked bars use the same four series colors in every row and in the legend.
- Chart-scoped blue, ochre, teal, mauve and complementary category colors have explicit light/dark variants. Print keeps the light palette. Labels, actual values, bar proportions and accessible descriptions remain intact.
- Model output still cannot supply CSS, colors, URLs or executable graph code. Existing saved charts use the updated renderer without regeneration.

## Verification

- Existing test suite: 810 passed; TypeScript passed.
- Isolated real Chrome rendered the actual React chart component and current application CSS with synthetic examples: eight-category bars and four-series stacked bars, light/dark, 960px/390px viewports. No horizontal overflow; legend/series colors match; category colors are distinct. Minimum measured bar/track contrast: light 3.81:1, dark 6.43:1. Screenshots visually reviewed.
- Local and production recording HTTP preflight passed before deployment. No capture, recorder lifecycle, relay, consent, credit or provider logic changed. No real microphone/tab capture or paid AI requests were started for this visual change.
- Compared all 395 files against the last verified production source manifest: only the two requested runtime files differ. Frozen candidate manifest: `/private/tmp/lecue-chart-colors-release-shas.json`.
- The recording-upload review remains a separate, unfixed item; this release does not claim to resolve it.

## Deployment

Promoted to https://www.lecue.app as `dpl_J415KeLJKVidyQXLWH6CyVRKAuoY`; release URL: https://lecue-rhoyz8out-dbgudwn43890-dels-projects.vercel.app.

All 395 uploaded source hashes match the frozen source and final workspace. Build succeeded. The production alias matches this deployment. Recording preflight passed on the authenticated release URL and public production before/after promotion, and on the real local server after changes. Candidate protection was preserved; official Vercel CLI authenticated HTTP headers were used to check the protected candidate. Evidence: `/private/tmp/lecue-chart-colors-candidate-verification.json`, `/private/tmp/lecue-chart-colors-after-verification.json`.
