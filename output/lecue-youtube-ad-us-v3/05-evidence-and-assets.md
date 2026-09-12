# Evidence and asset notes — US v3 / 15s

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

**AI that listens with you.** and **It heard that, too.** are ad copy. They do not replace real controls. The finished end card contains only the approved logo and lecue.app. No trial offer or signup promise is made.

The actual **In-person lecture** start control was rechecked in `app/classroom/workspace-client.tsx` during this revision. For a previously authorized account, it requests a microphone recording. Show the true connection and listening states before the question, then visibly condense time to a point with enough received lecture context. Recording consent, permission, credits, and account checks still apply.

No live recording was started for this planning task. The interactive storyboard is a local scripted reconstruction. Production requires fresh high-resolution English classroom footage or a faithful disclosed reconstruction. Do not describe the storyboard as actual screen footage.

## Assets

The package contains copies of:

- `/Users/kim2choi/01_Projects/강의_실시간/design/brand/lecue-symbol-b-master.png`
- `/Users/kim2choi/01_Projects/강의_실시간/design/brand/lecue-logo-b-v1.png`

Approval evidence: `/Users/kim2choi/01_Projects/강의_실시간/design/brand/README.md`. Use the folded-L direction. The old `public/brand/lecue-logo.png` is not the artwork for this ad.

Advertising palette comes from the reviewed landing CSS. Product-native colors must remain accurate inside captured UI. Use sufficiently high-resolution artwork and retain logo geometry. No new image generation is required for this revision.

## Required capture, if producing real-screen footage

An English test session already recording, its current listening state, generic question entry, the send action, a pending response, and a completed answer containing a graph and structured explanation. Use authorized test content and avoid private course information. Keep real product timing or disclose any time compression. The response may be readable, but its explanation must be simple enough that no study is needed to follow the advertisement.

An English-locale destination is proposed using `?lang=en`; check the route before trafficking. Website changes are outside this ad revision.

## Chart capability confirmed during this revision

- `app/classroom/answer-chart.ts:7`: native answer chart types are `bar` and `stacked-bar`.
- `app/classroom/answer-chart.ts:85`: actual chart rendering supports caption, legend, labeled rows, and proportional segments.
- `app/classroom/learning-answer.css:42`: existing answer-chart styling.
- `app/api/ask/route.ts:136–137`: use at most one chart when source numerical values make it helpful; do not invent numbers to fill a chart.

These are current local-source findings, not verification of the release URL. Use the supplied synthetic fixture to ground an illustrative test response. A chart is possible when appropriate, not guaranteed for every lecture or question. Additional cinematic motion is editing, not a claimed in-app animation.
