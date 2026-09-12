# Classroom UI copy cleanup — 2026-09-11

Removed Korean/English recognition-mode descriptions from lecture preparation and settings, repeated microphone/input explanations, material terminology-recognition claims, and the lecture-flow subtitle. Kept language/input choices, permissions/consent gates, errors, progress and change restrictions. Renamed Korean settings label to 수업 언어; removed unused description styles and collapsed the mobile settings gap.

Only four presentation files changed: workspace-client.tsx, workspace.css, listening-indicator.tsx, listening-indicator.css. No capture, speech routing, session, credit, or timing changes.

Verification: TypeScript and 810 existing app tests passed. Actual workspace components with isolated sample API responses checked in Chrome at 1440px English, 390px Korean, and 390px English dark; language persistence, microphone settings access, note-language presence, and no horizontal overflow verified. No real recording, paid AI call, or data upload. Impeccable detector passed.

Local/production HTTP recording preflight passed before and after. Fixed release URL checked using Vercel CLI authenticated response headers with the same preflight (Vercel login protection otherwise redirects). All 395 uploaded source hashes match the frozen workspace. Production alias verified.

Deployed: https://www.lecue.app
Release: https://lecue-pl7g9gikj-dbgudwn43890-dels-projects.vercel.app
Deployment: dpl_GxZVA9KGNKDdov5ezpFKW8jaiMiw
