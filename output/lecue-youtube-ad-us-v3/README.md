# Lecue — US v3 / 15-second product ad

**AI that listens with you.**

Final scope: one English ad for US college and graduate students, **at most 15 seconds**. Product UI fills the first 13 seconds: start recording, type and send a short question, see a rich graph answer, and scroll the explanation. Final two seconds: logo and lecue.app only. No trial offer or source lecture material.

This package supersedes the previous versions, including the longer timeline. It contains production plans and a scripted storyboard, not finished screen footage or a completed video.

## Files

- [01-creative-plan.md](01-creative-plan.md): final five-shot timeline and direction.
- [02-claude-production-prompt.md](02-claude-production-prompt.md): execution prompt.
- [03-shotlist.json](03-shotlist.json): timing and locked copy.
- [04-copy.txt](04-copy.txt): English narration and screen text.
- [05-evidence-and-assets.md](05-evidence-and-assets.md): source facts and actual capture needs.
- [06-visual-answer-fixture.json](06-visual-answer-fixture.json): synthetic graph data.
- [subtitles](subtitles): 15-second English SRT draft; retime to final voice.
- [assets](assets): approved logo source copies.

Give Claude this complete package and the task in `02-claude-production-prompt.md`. Produce 16:9 and 9:16 versions, both no longer than 15 seconds. Do not reuse the previous voiceovers or end cards.

Current visual source: the user-supplied Prepare and Recording screenshots in `assets/screens/`. See `07-screen-capture-notes.md`. Use their real layout, not the earlier simplified reconstruction. A question-ready screen and graph-answer screen are still needed for the remaining sequence.
