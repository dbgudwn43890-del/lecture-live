# Lecue — 15-second US product ad

**AI that listens with you.**

Audience: US college and graduate students. Language: US English throughout. Maximum runtime: **15 seconds**. Build one 15-second master in 16:9 and recompose it for 9:16. Earlier 30-second timelines are superseded.

## Creative decision

Show someone using Lecue. The product stays on screen for the first 13 seconds. The viewer sees a recording start, a short typed question, the send action, and a beautiful graph answer. Only the final two seconds become an end card. No source lecture content, academic terminology, instructor voice, or trial offer appears.

The graph is a payoff, not a lesson. Preserve the actual UI structure and use precise editing to make the workflow easy to see. Reference the enlarged product interactions of the previously reviewed Grammarly film; retain Lecue's own assets and palette.

## Locked timeline

1920×1080, 30fps, **450 frames**. Ranges are start-inclusive and end-exclusive.

| Time | Frames | Picture and operation | Voiceover |
|---|---|---|---|
| 0–2.5s | 0–75 | Begin on the actual English classroom. One cursor clicks **In-person lecture**. Show the connecting-to-recording change and **Listening along with you**. Small Lecue branding is visible immediately. | “Lecue listens with you.” |
| 2.5–6s | 75–180 | A clear editorial time cut advances the same recording to a point with lecture context. Focus **Ask about this lecture**, type **Can you explain that last part?**, and click the actual upward **Send question** arrow. Retain the app header and recording state. | “Ask about what you just heard.” |
| 6–11s | 180–330 | After submission, the answer arrives: short takeaway, large stacked-bar graph, concise steps. Let the graph settle for at least 2.5 seconds, then show a small actual conversation scroll to reveal the steps. One coherent response, same app. | “It heard that, too.” Then pause. |
| 11–13s | 330–390 | Ease back to the full conversation and ongoing recording. The graph and explanation remain attached to the sent question. Add **AI that listens with you.** outside the product controls. | “Stay with the lecture.” |
| 13–15s | 390–450 | Forest-green end card. Approved **Lecue** logo and **lecue.app** only. Final second steady. | “Lecue.” |

Do not add a follow-up question in this runtime. The main interaction needs enough time to read and see its result. No separate “Wait. What?” typography intro; the opening product operation is the hook.

## The recognizable product screen

Use high-resolution source footage or a faithful layer reconstruction of the current English classroom. Preserve its real navigation, header, recording status, composer, and conversation layout. Start with enough of the application visible to establish where the action happens. Magnify the composer and answer without turning them into unrelated floating cards.

Required visible operations:

1. The pointer arrives at **In-person lecture**, clicks, and the status changes.
2. The composer receives focus; the question is entered; the pointer clicks the real up arrow.
3. A response appears only after submission. A small conversation scroll reveals its explanation while the recording state stays visible.

Use one pointer. A short hover before each click makes causality legible. Do not animate a fake hand, generate misspelled UI, or paste a click sound over a static screen with no state change. The scroll must move actual answer content, not a drawn scrollbar. Captured UI should stay sharp through enlarged crops.

The short opening uses an already-authorized test account and browser. A first-time microphone permission flow is not the focus of this ad. Show enough of connecting/recording to distinguish the start action, then visibly condense time before the question. The source context must exist before the AI responds. Never claim instant transcription or a measured response time.

## Make the AI feel present before the question

The clearest cue is continuity: the AI is visibly listening before the user asks, remains present while the user types, and continues after the answer.

- At the start click, show the actual recording state and **Listening along with you** together. Hold this state briefly before focusing the composer.
- Retain the same listening region at a consistent position within the film's UI framing. Keep the same session and counter across reframes; do not reveal the AI for the first time when the answer appears.
- During question entry, show the actual audio-reception indicator continuing to respond. This is illustrative timing in the storyboard; use the real captured signal in production. Do not make every visual react to a click instead of received audio.
- The generic question **Can you explain that last part?** contains no pasted lecture or long setup. The answer follows from context that was already being received.
- Over the answer, say **It heard that, too.** Use a calm, matter-of-fact reading. Do not voice a second AI character or insert a fake spoken conversation.
- In the final product shot, retain the active listening state and use **AI that listens with you.** as the brand line. The experience should feel like asking someone who is already following class.

A tiny shared emphasis on the existing input meter and listening indicator can make the connection visible. Keep it restrained; no extra robot, orb, avatar, ears, floating consciousness, or implied always-on surveillance. The user-started recording action establishes when listening begins. There is no claim the AI listens outside that session or knows everything the user knows.

## The graph answer

A simple illustrative response keeps the visual rich without teaching a subject:

- Heading: **Same total. Different mix.**
- Takeaway: **The total stays the same. The parts change.**
- Chart: two equal-length stacked bars, **Group A 70 : 30**, **Group B 30 : 70**. Series: **Part 1**, **Part 2**. Small caption: **Example values**.
- Step 1: **Compare the totals.** Both add up to 100.
- Step 2: **Look at the parts.** The proportions change.

Do not narrate the chart numbers or explanations. The viewer should recognize a clear visual answer before reading it. One generous graph, strong type hierarchy, and a short scroll are sufficient.

Use `06-visual-answer-fixture.json` to supply the numbers as synthetic test context when capturing a generated answer. They are not product accuracy, grades, savings, or performance statistics. Exact reconstructed wording must be labeled illustrative. The current local product supports bar and stacked-bar charts; use those supported types. Do not invent a multi-chart dashboard or interactive simulator.

Timing within the answer: 6–7s response/heading; 7–7.6s chart reveal; 7.6–10.1s graph readable and stable; 10.1–11s small scroll to the two steps. Grow both segments proportionally; their final widths must reflect the data. This growth is post-production motion, not a promise about a native app animation.

## Locked voiceover

> Lecue listens with you.
> Ask about what you just heard.
> It heard that, too.
> [Pause]
> Stay with the lecture.
> Lecue.

Natural, calm US-English adult voice. No lecture audio. Do not read the question or chart aloud. Use the owner's brand pronunciation; “leh-kyoo” is only a provisional scratch-track guide. Record first, then adjust within the fixed 15-second duration. Do not accelerate a longer narration to make it fit.

## Copy and closing

Core brand line: **AI that listens with you.**

Closing: **Lecue / lecue.app**. No duration-based offer, trial CTA, signup badge, or free-use claim. Keep the visit destination on the English experience, proposed as `https://www.lecue.app/?lang=en`; verify the actual route before trafficking. This task does not change the website.

For reconstructed/time-condensed product footage, show **Illustrative UI. Timing condensed.** at 0–13s, in readable secondary type. Tailor the disclosure to the actual production method. No unsupported speed claim.

## Art and sound

After Effects-style 2D product motion. No people, physical room, desk, laptop hardware, or realistic camera footage. Advertising palette: ivory #F8F8F2, surface #FFFEFA, ink #25372C, forest #355E40. Graph secondary color: muted gold #C4A16A. Inside actual captures, preserve the product's native colors and spacing.

Use Geist for editable English copy and approved folded-L artwork. No old teal/orange logo. Emphasize operation and response, with clean masks and controlled camera crops. Avoid AI orbs, glitter, confetti, spinning screens, and repeated bounce. The chart and composer must remain legible on a small display.

One quiet music bed, short typing, two dry clicks, a subtle response cue. No instructor voice or explanatory lecture audio. Leave breathing room after “It heard that, too.” Deliver voice, music, and effects as separate tracks.

## Production deliverables

- One master no longer than **15.00 seconds**, 30fps, 450 frames.
- 1920×1080 landscape and separately composed 1080×1920 vertical versions.
- H.264 MP4, Rec.709 SDR, AAC 48kHz; clean and captioned versions.
- English SRT aligned to final audio; editable project; source UI captures; logo assets; audio stems.
- Five keyframes: start action, entered question, graph answer, full conversation, end card.

Use real screen footage as the production source when available, plus editable cursor, text, masks, and chart motion. The supplied interactive storyboard is a scripted reconstruction, not actual captured Lecue footage. Do not modify app code or interrupt a user's active recording to obtain source material.

Final check: without audio, can a viewer see what was clicked, what was asked, and what came back? Can they tell the AI is listening during class? Is the graph attractive without requiring any knowledge of the lecture? Is the runtime at most 15 seconds? No publishing or ad spend is authorized by this package.
