# Asset inventory

## Ready to use

| File in assets/ | Content |
|---|---|
| 01-prepare-cursor-hidden.png | Actual Prepare screen, 3024×1496. The screen-sharing cursor and halo are covered using an adjacent empty strip. |
| 02-recording-cursor-hidden.png | Actual recording screen, 3012×1488, Recording 0:16. Composer is disabled in this capture. Cursor and halo covered. |
| 03-graph-answer-cursor-hidden.png | Owner's preferred three-row graph answer, 3024×1482. Ended session. Cursor and halo covered. |
| Corresponding .svg files | Self-contained source-image compositions with an editable cursor-cover layer. These are not vector reconstructions of the product UI. |
| 04-interaction-cursor-hidden.mp4 | Cursor-cleaned derivative of the owner's silent screen recording. The crop excludes browser chrome, sidebar and footer. Product scrolling retained; answer content is the original video's repo explanation. |
| lecue-logo-b-v1.png | Approved folded-L symbol and wordmark source. |
| lecue-symbol-b-master.png | Approved transparent symbol source. |

The PNGs preserve the original UI, text, chart values and dimensions. Only the small cursor region is composited. The source screenshots can include Korean history and personal account information outside future ad crops; they are internal production materials.

## Reference originals

The untouched PNGs and 10.160-second MOV (3248×2000, H.264, variable frame rate, no audio) are preserved locally in `reference-originals/`. That directory is excluded from the handoff ZIP so Fable only receives cleaned production assets.

The graph screenshot and video both come from an ended session. The video shows an already-existing answer and scrolling; it does not include typed input or a send click. The PNG listening state is a separate capture. These are asset facts, not a proposed edit sequence.

## Video cleanup

The MP4 is 10.167 seconds (305 frames at 30fps; rounded from the 10.160-second source). It uses a 2560×1296 crop of the main product area and a 30fps constant-frame-rate conversion. Dark native cursor pixels are located inside the relevant content region; a small neighboring patch from the same scanlines replaces the cursor and its edge. Scroll motion and product content remain from the source. Encoding can introduce small pixel differences; this is a derived production asset, not a byte-identical recording.

No tagline, voiceover, storyboard, shot timing or creative animation is attached to these assets. Fable can plan from the product facts and sources.
