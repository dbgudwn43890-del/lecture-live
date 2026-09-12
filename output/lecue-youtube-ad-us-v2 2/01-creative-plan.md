# Lecue — “Already listening”

## Creative decision

**The viewer should understand how to use Lecue without learning anything from the lecture.**

Audience: US college and graduate students using a laptop during class. This audience is specified by the owner; it is not a claim about measured customer demographics.

Positioning: **AI that listens with you.**

The story is one familiar moment: you miss something, ask about it, and stay with class. Lecue already has the lecture context because it has been listening. Show that through recording state and a short typed question. Do not make a particular academic concept the reason the ad works.

The first version required the viewer to read a technical term and its explanation. This revision removes that task completely. The only readable user question is **“Can you explain that last part?”** The answer is the visual payoff: a large graph, a short takeaway, and two clear steps. It should feel immediately helpful without requiring the viewer to study it.

## Visual grammar

Use the product-first composition of the [provided Grammarly reference](https://www.youtube.com/watch?v=JQX7SdUJGeo): enlarged UI, an unmistakable interaction, a visible response, and a clear brand close. The earlier research sampled its key frames; it did not establish conversion performance. Retain Lecue's own brand and original assets.

Create an After Effects-style 2D product film. No filmed or generated people, campus footage, desks, hands, computer hardware, or physical camera moves. Flat surfaces, crisp type, precise cursor motion, and controlled masking carry the ad.

## 30-second master

1920×1080, 30fps, 900 frames. Time ranges are start-inclusive and end-exclusive. Narration timing is provisional until recorded.

| Shot | Time | Picture and action | Narration | Readable ad copy |
|---|---|---|---|---|
| 1 | 0–3s | Ivory field, small Lecue wordmark from frame one. An insertion caret briefly pauses. No lecture text appears. Large hook resolves in two beats. | “Missed that last part?” | “Wait. What?” |
| 2 | 3–7s | Reveal an enlarged crop of the actual English recording UI. Recording is already active; the listening indicator is the visual anchor. Brand proposition sits outside the product crop. | “Lecue listens to your lecture with you.” | “AI that listens with you.” |
| 3 | 7–12s | Move to the existing question composer. One cursor types the question, reaches the upward send arrow, pauses, and clicks. Retain the active recording state. | “So when something doesn't click, just ask.” | “Can you explain that last part?” |
| 4 | 12–21s | A short takeaway, a large two-color stacked-bar graph, and two concise steps unfold in the answer. Enlarge the graph through an editorial crop. Leave 16.5–21s without narration. | “Clear explanations. Visuals that help it click.” | “Same total. Different mix.” |
| 5 | 21–24s | Ease back to show the visual answer and ongoing recording together. The elapsed time continues normally. | “All while recording.” | “Stay with the lecture.” |
| 6 | 24–27s | Approved logo and positioning take over on a forest-green field. | “Lecue. AI that listens with you.” | “AI that listens with you.” |
| 7 | 27–30s | Hold a simple end card. One CTA, one URL, optional signup reassurance. Keep the last second stable. | “Try the 30-second demo.” | “Try the 30-second demo” / “lecue.app” / “No signup needed” |

The CTA is deliberately about the public demo, not an unlimited free product. Suggested destination: `https://www.lecue.app/?lang=en`, using the site's English locale parameter. Verify the final landing experience at trafficking time. The currently published demo may still contain a subject-specific example; this ad revision does not change the website.

## What must and must not be readable

**Readable:** Lecue, English recording/listening labels, one generic question, the assistant label, a short answer heading, graph labels, two short steps, benefit copy, CTA, and URL.

**Not shown:** lecture subject names, transcript, slides, formulas, academic jargon, subject-specific questions, lecture sound bites, or instructor narration. Graphs belong to the answer; no source lecture material is displayed.

A generic demonstration session title such as “Today's lecture” can identify the setting. It is example session data, not a new UI control. If it adds clutter, crop it out.

### Visual answer — the hero shot

- Heading: **Same total. Different mix.**
- Takeaway: **The total stays the same. The parts change.**
- Graph: two equal-length stacked bars. **Group A: 70 / 30**, **Group B: 30 / 70**. Forest and muted gold distinguish **Part 1** and **Part 2**. Caption: **Example values**.
- Step 1: **Compare the totals.** Both add up to 100.
- Step 2: **Look at the parts.** The proportions change.

The exact numbers are not narrated. The equal outer lengths and changing inner proportions register before any labels are read. These are synthetic teaching-example values, not grades, performance gains, or accuracy scores.

At 12–13s the takeaway appears. At 13–15s the graph reveals; scale both segments together so their proportions remain correct throughout. At 15–17s two concise explanation steps appear below. At 17–21s hold the complete answer with subtle editorial reframing. Avoid simultaneous motion everywhere.

Use one generous chart in the main answer. The local product supports bar and stacked-bar charts and requests at most one graph when the supplied numbers warrant it. Do not invent a multi-chart dashboard, pie chart, line plot, or interactive simulator. Visual richness comes from scale, hierarchy, typography, and choreography. A second chart type can be a separate future creative, not another unsolicited answer in this film.

Use `06-visual-answer-fixture.json` as synthetic test context when producing a real response. It supplies the numbers; do not ask the model to invent statistics. Actual generated wording can vary. An exact reconstruction stays labeled illustrative.

No typed “Got it!” or second question is needed. One clear submission is enough. The return to class is a composition change and continuing recording state, not a fictional “Back to class” button.

## Locked voiceover

> Missed that last part?
> Lecue listens to your lecture with you.
> So when something doesn't click, just ask.
> Clear explanations. Visuals that help it click.
>
> [Pause]
>
> All while recording.
> Lecue. AI that listens with you.
> Try the 30-second demo.

Use a natural US-English adult voice. Calm, direct, and conversational, with contractions. Avoid exaggerated enthusiasm, a corporate training voice, a forced Gen-Z persona, or slang that dates the film. Use the owner's brand pronunciation; the prior Korean direction “레큐” can be approximated as “leh-kyoo” for a scratch track, not treated as a confirmed official US audio identity.

The question, graph values, and explanation steps are not read aloud. One narrator, no audible lecture. The audience gets time to take in the answer design without studying the example.

## Product interaction

Use the current English UI, not translated Korean screenshots:

- Recording status: **Recording**.
- Active audio-receiving state: **Listening along with you**.
- Existing question placeholder: **Ask about this lecture**. It can disappear on focus; preserve actual behavior.
- Up-arrow action, accessible label: **Send question**.
- Default assistant label: **Lecture assistant · Default AI**. If the captured session uses a different supported configuration, retain that capture's actual label.

The scene begins after recording setup. Do not imply passive listening before permission or a user-started recording. No microphone click is needed in this 30-second film; the main operation is typing and sending a question. Recording continues during the exchange.

Do not portray general access to automatic spoken-question detection or unsolicited answers. Do not invent a transcript dashboard, source-jump button, or AI feature. The recording indicator is proof that audio is being received, not an accuracy score.

Use **“Illustrative UI. Timing condensed.”** during the reconstructed interaction, 7–24s in the master and 3–11s in the 15s cut. If a real-time recording is used without time edits, adapt the disclosure to match what was actually done. No subsecond-speed promise or simulated stopwatch measurement.

## Art direction and motion

Advertising palette: ivory #F8F8F2, warm surface #FFFEFA, ink #25372C, forest #355E40. Use the product's native colors inside actual UI captures. Avoid introducing a new neon or violet brand palette.

Use Geist for editable English text, with a neutral sans-serif fallback. Preserve the approved logo artwork. At 1080p, start around 80–104px for hero copy, 48–60px for the typed question, and 28–34px for secondary copy. Check the real mobile-size result before delivery.

Only one focal object moves at a time. A UI crop can translate, enlarge, and settle. Use masks and clean easing. Make the answer graph the largest visual payoff. Use forest #355E40 and muted gold #C4A16A with clear labels. Preserve the actual vertical answer structure; enlargement is an editorial film effect, not a new product layout. Avoid decorative cards nested inside cards.

Starting motion ranges at 30fps: cursor press 4–6 frames, small state changes 8–12 frames, main reframing 18–24 frames. These are proposed production values, not measurements of the reference.

Avoid floating 3D icons, AI orbs, glitter, neural-network imagery, sound waves turning into answers, rubbery bounce, spinning windows, confetti, and exaggerated zooms. The product interaction must do the persuasive work.

## Sound

One restrained electronic bed, dry typing, one soft click. No lecture audio, whispering voices, magic sparkle sound, or repeated whooshes. A 90–105 BPM starting range can support measured momentum. Select or create music with appropriate commercial rights.

Pull music back under narration, leave the 16.5–21s pause intact, and keep the end card intelligible. A suggested mix starting point is -14 to -16 LUFS integrated, true peak at or below -1 dBTP; this is a proposed mix target, not a claimed platform requirement. Deliver voice, music, and effects separately as well as a full mix.

## 15-second cut

| Time | Picture | Narration |
|---|---|---|
| 0–3s | Hook plus active listening state; no lecture material | “Missed that last part?” |
| 3–7s | Type the same generic question and send | “Ask the AI that's listening with you.” |
| 7–11s | A large stacked-bar graph, short takeaway, and two steps appear; recording continues | Pause |
| 11–15s | Logo, positioning, demo CTA, URL | “Lecue. Try the demo.” |

Do not speed up the whole master. Retain a comprehensible question and a visible send action. No academic examples are introduced in the cutdown.

## 6-second cut

0–2s: **“Wait. What?”** with early Lecue branding.

2–4.5s: **“AI that listens with you.”**

4.5–6s: logo, **lecue.app**, and small **“Try the demo”**.

Voiceover: **“Lecue. AI that listens with you.”** Read from approximately 0.5–4.8s, then let the card hold. No full Q&A demonstration in six seconds.

## 9:16 adaptation

Recompose at 1080×1920. Place the hook and branding above one enlarged product crop; put the question in the central field. Show the recording state near the crop, never as a fake extra product control. Keep essential text clear of platform overlays and check the actual placement preview before release. Do not center-crop the landscape master.

## Production handoff and checks

Create four style frames first: hook, active listening, typed question, and end card. Build a scratch-voice 30s animatic, then assemble final UI, voice, and sound. Only after the master is coherent should the shorter and vertical versions be edited.

All English text, logos, and UI interactions must be composited deterministically as editable layers. Do not ask a text-to-video model to draw the interface. Use real source UI where possible; keep illustrative abstractions distinguishable from a complete working product capture.

The owner should be able to watch the muted film and answer: “Who is it for?”, “What do I do?”, and “Why does this AI have the context?” The intended answers are “students in class,” “type a short question,” and “it has been listening to the lecture.” There is deliberately no question about what the class was teaching.

Delivery: 30/15/6s in 16:9 and 9:16, H.264 MP4, Rec.709 SDR, AAC 48kHz; captions and clean versions; English SRT retimed to final voice; editable project; approved assets and audio stems. Optional high-quality intermediate master if supported. No upload or ad spend is authorized by this production brief.
