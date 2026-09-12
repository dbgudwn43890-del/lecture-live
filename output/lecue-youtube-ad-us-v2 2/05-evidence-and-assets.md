# Evidence and asset notes — US v2

## Scope

This revision removes source lecture content and makes the visual answer the hero and localizes the ad for US college and graduate students. It does not change the product, landing page, recording pipeline, or deployment. Product files were read only. No live microphone, Q&A response, or recording lifecycle was tested for this revision.

Previous research directly viewed the [public Lecue landing page and prepared demo](https://www.lecue.app/) and sampled key frames of the [Grammarly reference](https://www.youtube.com/watch?v=JQX7SdUJGeo). The public demo is illustrative, not a measured live-AI test.

## English labels verified in current local source

Repository root: `/Users/kim2choi/01_Projects/강의_실시간/`.

| Label / behavior | Evidence |
|---|---|
| Listening along with you | `app/classroom/listening-state.ts:5`; recording while receiving audio |
| Recording | `app/classroom/workspace-client.tsx:214` |
| Ask about this lecture | `app/classroom/workspace-client.tsx:2637`; placeholder can change with state/focus |
| Send question | `app/classroom/workspace-client.tsx:2649`; up-arrow submit action |
| Lecture assistant · Default AI | `app/classroom/workspace-client.tsx:1527`; actual default answer label |
| Lecture assistant · AI | `app/classroom/workspace-client.tsx:2518`; fallback, not necessarily the current default label |
| Try it in 30 seconds; Try without signing up | `app/landing-copy.ts:5`; official English landing copy |
| Short questions grounded in lecture so far | `app/api/ask/route.ts`; verified during original product review |

Line numbers describe the local working copy and can move. These labels have not been independently verified against a live English classroom session. Confirm final deployed UI before creating actual-screen footage.

## Editorial copy versus product labels

“AI that listens with you,” “Wait. What?”, “Stay with the lecture,” and “Try the 30-second demo” are proposed advertising copy. They must appear outside the product controls. “No signup needed” refers specifically to the public prepared demo. It must not imply recording with the full product requires no account or permissions.

“Can you explain that last part?” is a generic example user question. It demonstrates the intended contextual use; it does not guarantee every ambiguous question receives a correct answer. Do not imply every answer necessarily includes a chart.

Do not show general availability of automatic spoken-question detection or automatic answers; the original product review found that functionality restricted to approved administrator accounts. No source-jump links or permanent transcript dashboard are needed.

## Assets

The package contains copies of:

- `/Users/kim2choi/01_Projects/강의_실시간/design/brand/lecue-symbol-b-master.png`
- `/Users/kim2choi/01_Projects/강의_실시간/design/brand/lecue-logo-b-v1.png`

Approval evidence: `/Users/kim2choi/01_Projects/강의_실시간/design/brand/README.md`. Use the folded-L direction. The old `public/brand/lecue-logo.png` is not the artwork for this ad.

Advertising palette comes from the reviewed landing CSS. Product-native colors must remain accurate inside captured UI. Use sufficiently high-resolution artwork and retain logo geometry. No new image generation is required for this revision.

## Required capture, if producing real-screen footage

An English test session already recording, its current listening state, generic question entry, the send action, a pending response, and a completed answer containing a graph and structured explanation. Use authorized test content and avoid private course information. Keep real product timing or disclose any time compression. The response may be readable, but its explanation must be simple enough that no study is needed to follow the advertisement.

An English-locale landing destination is proposed using `?lang=en`; check the actual CTA and route before trafficking. The existing demo may still feature an academic example. Redesigning that experience is outside the scope of this ad revision.

## Chart capability confirmed during this revision

- `app/classroom/answer-chart.ts:7`: native answer chart types are `bar` and `stacked-bar`.
- `app/classroom/answer-chart.ts:85`: actual chart rendering supports caption, legend, labeled rows, and proportional segments.
- `app/classroom/learning-answer.css:42`: existing answer-chart styling.
- `app/api/ask/route.ts:136–137`: use at most one chart when source numerical values make it helpful; do not invent numbers to fill a chart.

These are current local-source findings, not verification of the release URL. Use the supplied synthetic fixture to ground an illustrative test response. A chart is possible when appropriate, not guaranteed for every lecture or question. Additional cinematic motion is editing, not a claimed in-app animation.
