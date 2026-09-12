import React from "react";
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, staticFile, useCurrentFrame } from "remotion";

export type LecueAdProps = { voice: "andrew" | "ava" | null };

const IVORY = "#F7F8F3";
const FOREST = "rgb(71,93,69)";
const QUESTION = "Can you explain that last part?";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const easeOut = Easing.out(Easing.cubic);

// Non-destructive crop: source pixel (cx, cy) lands at output (0,0), scaled by s.
const Crop: React.FC<{ src: string; w: number; cx: number; cy: number; s: number; children?: React.ReactNode }> = ({ src, w, cx, cy, s, children }) => (
  <div style={{ position: "absolute", left: -cx * s, top: -cy * s, width: w * s, transformOrigin: "0 0" }}>
    <Img src={src} style={{ width: w * s, display: "block" }} />
    {/* children are positioned in SOURCE pixel space */}
    <div style={{ position: "absolute", left: 0, top: 0, transform: `scale(${s})`, transformOrigin: "0 0" }}>{children}</div>
  </div>
);

const Cursor: React.FC<{ x: number; y: number; pressed?: boolean }> = ({ x, y, pressed }) => (
  <svg style={{ position: "absolute", left: x, top: y, width: 30, height: 36, transform: pressed ? "scale(0.92)" : undefined, transformOrigin: "2px 2px" }} viewBox="0 0 20 24">
    <path d="M2 2 L2 19 L6.5 15 L9.5 22 L12.5 20.7 L9.5 14 L15.5 14 Z" fill="#111" stroke="#fff" strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);

// Shared amplitude envelope: three restrained pulses, 0.35 s return.
const envelope = (frame: number) => {
  const pulses: [number, number][] = [[57, 1], [79.5, 0.8], [103.5, 0.9]];
  return Math.max(0, ...pulses.map(([f, a]) => (frame < f ? 0 : a * interpolate(frame - f, [0, 2, 10.5], [0, 1, 0], clamp))));
};

const Start: React.FC = () => {
  const f = useCurrentFrame();
  const s = 2.2, cx = 2000, cy = 842;
  const bx = (2225 - cx) * s, by = (926 - cy) * s; // In-person button center in output px
  const p = interpolate(f, [4, 27], [0, 1], { ...clamp, easing: easeOut });
  const x = interpolate(p, [0, 1], [bx + 420, bx]), y = interpolate(p, [0, 1], [by + 240, by]);
  const pressed = f >= 30 && f < 35;
  return (
    <AbsoluteFill style={{ background: IVORY }}>
      <Crop src={staticFile("screens/01-prepare.png")} w={3024} cx={cx} cy={cy} s={s}>
        {pressed && <div style={{ position: "absolute", left: 2041, top: 879, width: 370, height: 96, borderRadius: 10, background: "rgba(0,0,0,0.14)" }} />}
      </Crop>
      <Cursor x={x} y={y} pressed={pressed} />
    </AbsoluteFill>
  );
};

const ListenAsk: React.FC = () => {
  const f = useCurrentFrame() + 45; // absolute frame
  // camera: wide listening framing -> 1:1 composer framing (fast move at 126-134)
  const t = interpolate(f, [126, 134], [0, 1], { ...clamp, easing: easeOut });
  const s = interpolate(t, [0, 1], [1920 / 2530, 1]);
  const cx = interpolate(t, [0, 1], [460, 784]), cy = interpolate(t, [0, 1], [0, 360]);
  const env = envelope(f);
  const typed = Math.round(interpolate(f, [130, 163], [0, QUESTION.length], clamp));
  const enabled = typed > 0;
  const pressed = f >= 164 && f < 170;
  // cursor: appears after camera move, travels to the arrow button
  const cp = interpolate(f, [136, 160], [0, 1], { ...clamp, easing: easeOut });
  const arrow = { x: (2411 - cx) * s, y: (1333 - cy) * s };
  const curX = interpolate(cp, [0, 1], [arrow.x - 260, arrow.x - 4]), curY = interpolate(cp, [0, 1], [arrow.y + 180, arrow.y - 4]);
  return (
    <AbsoluteFill style={{ background: IVORY }}>
      <Crop src={staticFile("screens/02-recording.png")} w={3012} cx={cx} cy={cy} s={s}>
        {/* listening icon ring, native position */}
        <div style={{ position: "absolute", left: 547.5 - 30, top: 169.5 - 30, width: 60, height: 60, borderRadius: "50%", border: `3px solid ${FOREST}`, opacity: 0.22 * env, transform: `scale(${1 + 0.1 * env})` }} />
        {/* input indicator dots: same envelope, scaled in place */}
        <div style={{ position: "absolute", left: 1918, top: 36, width: 60, height: 30, overflow: "hidden", transform: `scale(${1 + 0.1 * env})`, transformOrigin: "center" }}>
          <Img src={staticFile("screens/02-recording.png")} style={{ position: "absolute", left: -1918, top: -36, width: 3012 }} />
        </div>
        <div style={{ position: "absolute", left: 1918, top: 36, width: 60, height: 30, borderRadius: 15, background: FOREST, opacity: 0.22 * env, filter: "blur(6px)" }} />
        {/* illustrative enabled composer (source composer is disabled) */}
        {f >= 128 && (
          <>
            <div style={{ position: "absolute", left: 1110, top: 1298, width: 1240, height: 70, background: "#FFFFFC" }} />
            <div style={{ position: "absolute", left: 1132, top: 1316, fontSize: 27, fontFamily: "-apple-system, Inter, Helvetica, Arial, sans-serif", color: "#2a2f2a", whiteSpace: "pre" }}>
              {QUESTION.slice(0, typed)}
              {f < 164 && Math.floor(f / 8) % 2 === 0 ? "|" : ""}
            </div>
            {enabled && (
              <div style={{ position: "absolute", left: 2411 - 33, top: 1333 - 33, width: 66, height: 66, borderRadius: "50%", background: FOREST, opacity: pressed ? 0.8 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </div>
            )}
          </>
        )}
      </Crop>
      {f >= 136 && <Cursor x={curX} y={curY} pressed={pressed} />}
      {f >= 128 && <div style={{ position: "absolute", right: 28, bottom: 14, fontSize: 18, color: "#6b7069", fontFamily: "-apple-system, Helvetica, Arial, sans-serif" }}>Illustrative interaction. Timing condensed.</div>}
    </AbsoluteFill>
  );
};

const ROWS = [[529, 562], [631, 664], [733, 766]]; // bar row y extents (source px)
const BAR_X = [1215, 2200];

const Answer: React.FC = () => {
  const f = useCurrentFrame() + 170; // sequence starts at 170 for the crossfade
  const s = 1, cx = 900;
  const cy = interpolate(f, [332, 372], [160, 360], { ...clamp, easing: Easing.out(Easing.quad) });
  const src = staticFile("screens/03-graph-answer.png");
  const drift = interpolate(f, [330, 390], [0, 1], { ...clamp, easing: easeOut });
  return (
    <AbsoluteFill style={{ background: IVORY }}>
      <Crop src={src} w={3024} cx={cx} cy={cy} s={s}>
        {ROWS.map(([y0, y1], i) => {
          const p = interpolate(f, [184 + i * 2.4, 184 + i * 2.4 + 21], [0, 1], { ...clamp, easing: easeOut });
          return (
            <React.Fragment key={i}>
              {/* cover original bar pixels, then re-reveal the SAME pixels left to right */}
              <div style={{ position: "absolute", left: BAR_X[0], top: y0 - 2, width: BAR_X[1] - BAR_X[0], height: y1 - y0 + 4, background: IVORY }} />
              <div style={{ position: "absolute", left: BAR_X[0], top: y0 - 2, width: (BAR_X[1] - BAR_X[0]) * p, height: y1 - y0 + 4, overflow: "hidden" }}><Img src={src} style={{ position: "absolute", left: -BAR_X[0], top: -(y0 - 2), width: 3024, maxWidth: "none" }} /></div>
            </React.Fragment>
          );
        })}
      </Crop>
      {f >= 330 && <Cursor x={1500 + drift * 40} y={620 + drift * 90} />}
    </AbsoluteFill>
  );
};

const End: React.FC = () => (
  <AbsoluteFill style={{ background: "#fff", alignItems: "center", justifyContent: "center" }}>
    <Img src={staticFile("lecue-logo-alpha.png")} style={{ height: 560 }} />
    <div style={{ marginTop: -30, fontSize: 42, letterSpacing: 2, fontWeight: 600, color: "#111", fontFamily: "-apple-system, Inter, Helvetica, Arial, sans-serif" }}>lecue.app</div>
  </AbsoluteFill>
);

// Incoming scene fades over the previous one for `len` frames.
const Fade: React.FC<{ from: number; len: number; children: React.ReactNode }> = ({ from, len, children }) => {
  const f = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: interpolate(f, [from, from + len], [0, 1], clamp) }}>{children}</AbsoluteFill>;
};

export const LecueAd: React.FC<LecueAdProps> = ({ voice }) => (
  <AbsoluteFill style={{ background: IVORY }}>
    <Sequence from={0} durationInFrames={52} layout="none"><Start /></Sequence>
    <Fade from={45} len={7}><Sequence from={45} durationInFrames={135} layout="none"><ListenAsk /></Sequence></Fade>
    <Fade from={170} len={10}><Sequence from={170} durationInFrames={220} layout="none"><Answer /></Sequence></Fade>
    <Fade from={382} len={8}><Sequence from={382} layout="none"><End /></Sequence></Fade>

    <Sequence from={30}><Audio src={staticFile("sfx/click.wav")} /></Sequence>
    {Array.from({ length: QUESTION.length }, (_, i) => Math.round(130 + (i * 33) / QUESTION.length)).map((fr, i) => (
      <Sequence key={i} from={fr}><Audio src={staticFile("sfx/key.wav")} volume={0.6} /></Sequence>
    ))}
    <Sequence from={164}><Audio src={staticFile("sfx/send.wav")} /></Sequence>
    <Sequence from={206}><Audio src={staticFile("sfx/tone.wav")} volume={0.7} /></Sequence>
    {voice && <Sequence from={51}><Audio src={staticFile(`vo/vo1-${voice}.mp3`)} /></Sequence>}
    {voice && <Sequence from={210}><Audio src={staticFile(`vo/vo2-${voice}.mp3`)} /></Sequence>}
  </AbsoluteFill>
);

