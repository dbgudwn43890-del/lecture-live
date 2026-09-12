# Classroom readability — 2026-09-08

## Current user direction

- A single centered conversation; no visible transcript pane. Audio capture, transcript storage, AI context and review notes remain.
- 2026-09-09 follow-up: keep the composer at the bottom even before the first question; only the empty-state greeting stays centered.
- Keep the original recording meter in the topbar. Remove the experimental Jarvis cores and local A/B toolbar.
- Compact title/lecture controls and composer; fade the conversation near the composer.
- Move material upload/manage into the composer's paperclip menu. Remove repeated material filename/page badges from every answer.
- Respect upward scrolling while answers stream. Follow again only after returning to the bottom, jumping to latest, or sending a new question.

## Implemented

- Desktop topbar about 58px (previously78); narrow screen68px (previously86).
- Empty composer about53px (previously83). Placeholder text no longer contributes to autosizing; entered multiline text expands up to144px. ResizeObserver recalculates after width changes.
- Material menu opens above the paperclip, closes on outside click/Escape, stays outside the masked message viewport.
- Message viewport has a short top fade and32px bottom fade; bottom padding keeps the final answer legible at the end of scrolling.
- `use-conversation-scroll.ts` replaces distance-only auto-follow with user intent handling and an explicit latest-answer button. No smooth-scroll momentum competes with upward scrolling.
- KaTeX rendering/style versions aligned through a scoped rehype-katex dependency override; shared math CSS preserves inline struts and scrolls padded display wrappers only. Applies to answers and review notes.
- Explicit PDF page requests now bypass similarity retrieval and fetch the requested pages first. Korean/English page labels and ranges are supported. Legacy chunks without reliable page boundaries fall back to the owner's original PDF; new chunks preserve page markers and do not span skipped empty pages.
- Missing page text, failed original reads and confirmed out-of-range pages are reported separately to the answer model. Native extraction does not claim to inspect diagrams or scanned images. Reads are bounded to 3 original PDFs, 12 requested pages and 60,000 context characters per request.

## Verification

- 2026-09-09 follow-up: authenticated Chrome screenshots confirm the same bottom composer for an empty lecture and an existing conversation. Narrow-screen check has no horizontal overflow and retains a roughly 53px input with 12px bottom pane padding. Removed the empty-state auto margins and its separate 48px composer padding.
- Authenticated Chrome local classroom: centered readable widths720px /780px with sidebar collapsed; no transcript, duplicate materials header or Jarvis controls.
- Empty/multiline composer, material menu and58px/68px header verified;390px screen has no horizontal overflow.
- Actual AnswerMarkdown SSR fixture: inline fractions/exponents, nested fractions/integrals, long display math, review note styles. All21 measured formulas had zero vertical clipping; long formulas scroll horizontally. Engine/CSS compatibility regression test added.
- Synthetic streaming fixture uses the exact production scroll controller, no API. After an upward action, scrollTop1696.11 remained fixed while scrollHeight increased3993→8875.
- Chrome confirmed that Cmd+ArrowDown resumes following during streaming (bottom gap under1px); upward input releases it immediately. 17 scroll-controller regressions cover wheel/touch/keyboard and layout changes.
- Full automated suite: 448/448 pass. Type checking and production build pass. The built `/api/ask` trace includes the PDF.js engine and worker required by the new original-PDF fallback. Temporary QA fixtures removed.
- Actual attached PDF page7 remains unverified: the first read encountered a transport failure; one elevated read-only check was rejected before execution by automatic approval review because service-role access to the private remote PDF lacked explicit authorization. No workaround, database write or paid model call was used. Page retrieval is covered by mocked route tests and native PDF extraction tests.
- No paid STT/AI calls, live recording operations or production mutations used for UI verification.

## Deployment

2026-09-09 19:51 KST: bottom composer follow-up and saving-state controls released with `dpl_9Q5busa8QEmbXths3B7yiwkdUb4g`. Prior release details follow.

Released to https://www.lecue.app on 2026-09-09, deployment `dpl_DujVgGqSUTaWgDY2qxURFHRBfz3k`. Includes these classroom UI changes and the subsequent general PDF retrieval fix. See [deployment record](deployment-2026-09-09.md). The older staged security candidate was not promoted.
