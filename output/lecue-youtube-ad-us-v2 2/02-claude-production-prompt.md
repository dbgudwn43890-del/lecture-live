# Production prompt — Lecue US ad v2

Use this prompt with the complete v2 package. This supersedes the previous Korean, subject-specific creative. Do not reuse the previous lecture example, voiceover, or subtitles.

---

You are directing and producing a premium product-motion advertisement for Lecue using the production tools connected to this Claude environment. First inspect the tools' actual supported capabilities; do not assume a particular model API, compositing engine, or video tool exists.

## Objective

Make a short English-language YouTube ad for US college and graduate students.

**Positioning: AI that listens with you.**

**Show the use, not the subject matter.**

The viewer sees Lecue already listening during class, a student typing “Can you explain that last part?”, a beautifully structured visual answer unfolding, and recording continuing. The audience must not read, hear, or understand any lecture content to understand the ad.

## Non-negotiable creative rules

- All finished-ad copy, narration, UI, captions, and disclosures are US English.
- No source lecture material: no subject names, transcript, slides, formulas, or instructor voice. Answer content IS welcome: make a graph, short takeaway, and concise steps the visual highlight.
- The only readable user question is: **Can you explain that last part?**
- Show a readable, elegant answer: “Same total. Different mix.”, two stacked bars, and two short steps. Do not hide it behind a crop or replace it with placeholder lines. The viewer need not study the values.
- Do not add “Got it!” as a second interaction or a fictional “Back to class” control.
- Use After Effects-style 2D motion and real product UI. No filmed or generated people, desks, campuses, hands, computer hardware, or realistic camera scenes.
- Reference the enlarged UI and input-to-result composition of https://www.youtube.com/watch?v=JQX7SdUJGeo. Do not reuse its footage, music, icons, or words.
- Composite all text, logos, UI, and cursor motions as editable layers. Do not generate the interface through text-to-video.

## Locked master timeline

30 seconds, 1920×1080, 30fps, exactly 900 frames.

0–3s: small Lecue wordmark visible from the first frame. Big hook “Wait. What?” No lecture content. VO: “Missed that last part?”

3–7s: actual English recording UI, already receiving audio. Keep “Recording” and “Listening along with you” readable. Editorial headline outside the product: “AI that listens with you.” VO: “Lecue listens to your lecture with you.”

7–12s: focus the real composer, type “Can you explain that last part?”, then click the real up-arrow Send question action. One cursor, one submission. VO: “So when something doesn't click, just ask.”

12–21s: the hero answer unfolds. Takeaway first, large stacked-bar graph second, two short steps last. Heading: “Same total. Different mix.” VO: “Clear explanations. Visuals that help it click.” Leave 16.5–21s without narration. Hold the full answer long enough to appreciate the design.

21–24s: show the graph answer and ongoing recording together. Editorial copy: “Stay with the lecture.” VO: “All while recording.”

24–27s: forest-green brand field. Approved logo and “AI that listens with you.” VO: “Lecue. AI that listens with you.”

27–30s: hold “Try the 30-second demo”, “lecue.app”, and optionally “No signup needed”. VO: “Try the 30-second demo.” Keep the last second stable.

## Locked visual answer

Use the supplied `06-visual-answer-fixture.json`. These are explicitly synthetic test-context values, never claims about product performance.

Heading: “Same total. Different mix.”
Takeaway: “The total stays the same. The parts change.”
Chart: stacked-bar; Group A [70, 30], Group B [30, 70]; series “Part 1”, “Part 2”; unit “units”. Caption “Example values”.
Step 1: “Compare the totals.” / “Both add up to 100.”
Step 2: “Look at the parts.” / “The proportions change.”

Use forest and muted gold. Reveal segments proportionally, then hold. Keep one prominent chart; do not manufacture a multi-chart dashboard. The existing local renderer supports bar and stacked-bar. Its prompt uses source numbers and requests at most one chart when helpful. If capturing actual AI output, supply the fixture as test lecture context before asking. Wording can vary; exact recreation is illustrative. Do not change application code to make the ad.

## Product accuracy

Use the English interface as the source of truth. Confirm the final deployed labels before capturing. Local source currently supports:

- Recording
- Listening along with you
- Ask about this lecture
- Send question (upward arrow)
- Lecture assistant · Default AI for the default configuration

“Today's lecture” may be used as generic example session data; it is not a new product label. Preserve the actual placeholder's focus behavior.

The film begins after a user has started recording. No always-on listening or automatic spoken-question answering. This is typed Q&A grounded in an ongoing lecture. Do not invent source-jump links, permanent transcript dashboards, an accuracy metric, or an instant-response guarantee.

During the reconstructed interaction use “Illustrative UI. Timing condensed.” at 7–24s in the 30s master and 3–11s in the 15s version. A real capture must preserve what happened; disclose time edits accurately. Do not manipulate an active user recording or expose private lecture content to obtain footage.

The demo CTA does not promise unlimited free usage. Suggested English destination is https://www.lecue.app/?lang=en. Check it before trafficking. The public demo may still have subject-specific content; changing that landing page is outside this video task.

## Look and sound

Ivory #F8F8F2, surface #FFFEFA, ink #25372C, forest #355E40. Preserve native colors inside actual UI captures. Geist for English type; approved folded-L logo artwork. Do not use the older teal-and-orange logo by filename accident.

One focal motion at a time. Controlled masks, smooth deceleration, accurate click feedback, generous negative space. No AI orb, robot, brain, neon network, glitter, confetti, floating icons, rotating windows, or repeated bounce.

Natural US-English adult narrator. Calm and conversational. No forced slang or hype. The owner-defined brand pronunciation takes precedence; “leh-kyoo” is only a provisional scratch-track approximation. No lecture audio. One understated music bed, subtle typing, one dry click. Preserve the pause at 16.5–21s.

## Cutdowns

15s: 0–3 hook/listening, 3–7 type/send, 7–11 visual graph answer/recording, 11–15 brand/CTA. VO: “Missed that last part? Ask the AI that's listening with you. [Pause.] Lecue. Try the demo.”

6s: hook 0–2, positioning 2–4.5, brand/URL/demo CTA 4.5–6. VO: “Lecue. AI that listens with you.” No Q&A body.

Create 9:16 versions by recomposing the UI and text, not by center-cropping or speeding up the master.

## Workflow and delivery

Read the v2 creative plan, shotlist, copy, and asset notes. Produce hook/listening/question/end-card style frames, then a 30s animatic with scratch voice. Refine only the necessary scenes, assemble final audio and UI, then make the cutdowns.

If accurate UI assets are missing, identify the exact missing capture. Use clearly labeled illustrative composition for a draft, not an invented full product screen. If the connected tools cannot composite text and UI accurately, state the missing capability and deliver the supported rough rather than declaring a broken render final.

Deliver final 30/15/6s videos in 16:9 and 9:16, clean and captioned versions, final synced English SRT, editable project, assets, and separate VO/music/SFX stems. Verify duration, spelling, send-before-answer order, recording continuity, and mobile readability. Follow the user's authorized tool budget. Do not publish, upload, or buy ad placements without a separate request.

Begin with the style frames.
