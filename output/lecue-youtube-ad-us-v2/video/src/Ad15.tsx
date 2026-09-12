import React from "react";
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const FPS = 30;
export const DURATION = 15 * FPS;

const C = {
  ivory: "#F8F8F2",
  surface: "#FFFEFA",
  ink: "#25372C",
  forest: "#355E40",
  gold: "#C4A16A",
  red: "#D6453D",
  line: "#E1E0D6",
  muted: "#6F7C73",
  bubble: "#EEF1EC",
};
// ponytail: Geist not bundled; system sans fallback. Drop Geist woff2 in public/ and @font-face it if brand requires.
const FONT =
  '"Geist", -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif';

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;
const out = (f: number, r: [number, number], o: [number, number]) =>
  interpolate(f, r, o, { ...clamp, easing: Easing.out(Easing.cubic) });
const lin = (f: number, r: [number, number], o: [number, number]) =>
  interpolate(f, r, o, clamp);

const Rise: React.FC<{
  from: number;
  len?: number;
  dy?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ from, len = 12, dy = 18, style, children }) => {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        opacity: out(f, [from, from + len], [0, 1]),
        transform: `translateY(${out(f, [from, from + len], [dy, 0])}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

const Wordmark: React.FC<{ h: number; color?: string; invert?: boolean }> = ({
  h,
  color = C.ink,
  invert,
}) => (
  <div style={{ display: "flex", alignItems: "center", gap: h * 0.35 }}>
    <Img
      src={staticFile("lecue-symbol-b-master.png")}
      style={{ height: h * 1.2, filter: invert ? "invert(1)" : undefined }}
    />
    <span
      style={{ fontFamily: FONT, fontWeight: 700, fontSize: h, color, letterSpacing: -h * 0.02 }}
    >
      Lecue
    </span>
  </div>
);

const RecordingPill: React.FC<{ elapsed: number; size?: number }> = ({
  elapsed,
  size = 24,
}) => {
  const f = useCurrentFrame();
  const pulse = 0.55 + 0.45 * Math.abs(Math.sin((f / FPS) * Math.PI));
  const total = 24 * 60 + 13 + Math.floor(elapsed / FPS);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.55,
        padding: `${size * 0.45}px ${size * 0.9}px`,
        borderRadius: 999,
        background: C.surface,
        border: `1px solid ${C.line}`,
        fontFamily: FONT,
        fontSize: size,
        color: C.ink,
      }}
    >
      <span
        style={{
          width: size * 0.55,
          height: size * 0.55,
          borderRadius: 999,
          background: C.red,
          opacity: pulse,
        }}
      />
      <span style={{ fontWeight: 600 }}>Recording</span>
      <span style={{ color: C.muted, fontVariantNumeric: "tabular-nums" }}>
        {mm}:{ss}
      </span>
      <span style={{ color: C.line }}>|</span>
      <span style={{ color: C.muted }}>Listening along with you</span>
    </div>
  );
};

const Cursor: React.FC<{ x: number; y: number; press: number }> = ({ x, y, press }) => (
  <svg
    width={36}
    height={40}
    viewBox="0 0 18 20"
    style={{
      position: "absolute",
      left: x,
      top: y,
      transform: `scale(${1 - press * 0.12})`,
      transformOrigin: "2px 2px",
      filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.25))",
    }}
  >
    <path d="M2 1 L2 16 L6 12.5 L9 19 L11.5 18 L8.5 11.5 L14 11.5 Z" fill="#fff" stroke={C.ink} strokeWidth={1.2} strokeLinejoin="round" />
  </svg>
);

/* ---------- Scene 1: hook 0–3s ---------- */
const Hook: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.ivory }}>
      <div style={{ position: "absolute", left: 100, top: 60 }}>
        <Wordmark h={40} />
      </div>
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 34,
          fontFamily: FONT,
          fontSize: 132,
          fontWeight: 600,
          color: C.ink,
          letterSpacing: -3,
          paddingBottom: 90,
        }}
      >
        <Rise from={6} len={14}>Wait.</Rise>
        <Rise from={26} len={14}>What?</Rise>
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 660,
          display: "flex",
          justifyContent: "center",
          opacity: out(f, [54, 70], [0, 1]),
          transform: `translateY(${out(f, [54, 70], [16, 0])}px)`,
        }}
      >
        <RecordingPill elapsed={f} size={28} />
      </div>
    </AbsoluteFill>
  );
};

/* ---------- Scene 2+3: product UI, ask + answer, 3–11s ---------- */
const QUESTION = "Can you explain that last part?";
const PANEL = { w: 1500, h: 830, x: 210, y: 140 };
const INPUT = { x: PANEL.x + 40, y: PANEL.y + PANEL.h - 40 - 72, w: PANEL.w - 80, h: 72 };
const SEND = { cx: INPUT.x + INPUT.w - 44, cy: INPUT.y + 36 };

const StackedBar: React.FC<{ label: string; values: [number, number]; p: number; f: number; from: number }> = ({
  label,
  values,
  p,
}) => {
  const W = 880;
  const H = 62;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 28, fontFamily: FONT }}>
      <div style={{ width: 130, fontSize: 26, color: C.ink, fontWeight: 500 }}>{label}</div>
      <div style={{ display: "flex", height: H, width: W }}>
        {values.map((v, i) => (
          <div
            key={i}
            style={{
              width: (v / 100) * W * p,
              height: H,
              background: i === 0 ? C.forest : C.gold,
              borderRadius: i === 0 ? "10px 0 0 10px" : "0 10px 10px 0",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#fff",
              fontSize: 24,
              fontWeight: 600,
              opacity: 1,
            }}
          >
            <span style={{ opacity: lin(p, [0.9, 1], [0, 1]) }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const App: React.FC = () => {
  const f = useCurrentFrame(); // local, 0 at 3s
  const enter = out(f, [0, 22], [0, 1]);

  // cursor keyframes
  const kx = [
    [0, 1500, 1010],
    [24, INPUT.x + 330, INPUT.y + 40],
    [86, INPUT.x + 330, INPUT.y + 40],
    [104, SEND.cx + 4, SEND.cy + 4],
  ] as const;
  const cx = interpolate(f, kx.map((k) => k[0]), kx.map((k) => k[1]), { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const cy = interpolate(f, kx.map((k) => k[0]), kx.map((k) => k[2]), { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const press = (at: number) => (f >= at && f < at + 5 ? 1 : 0);
  const pressAmt = press(27) + press(112);
  const focused = f >= 28;
  const sent = f >= 118;
  const typed = sent ? "" : QUESTION.slice(0, Math.floor(lin(f, [33, 84], [0, QUESTION.length])));
  const caretOn = focused && !sent && Math.floor(f / 8) % 2 === 0;
  const cursorOpacity = lin(f, [122, 132], [1, 0]);

  const chartP = out(f, [150, 188], [0, 1]);
  const answerVisible = f >= 126;

  return (
    <AbsoluteFill style={{ background: C.ivory }}>
      <div style={{ position: "absolute", left: 100, top: 50 }}>
        <Wordmark h={36} />
      </div>

      {/* product panel */}
      <div
        style={{
          position: "absolute",
          left: PANEL.x,
          top: PANEL.y,
          width: PANEL.w,
          height: PANEL.h,
          background: C.surface,
          border: `1px solid ${C.line}`,
          borderRadius: 22,
          boxShadow: "0 18px 50px rgba(37,55,44,0.08)",
          opacity: enter,
          transform: `translateY(${(1 - enter) * 50}px)`,
          fontFamily: FONT,
          color: C.ink,
          overflow: "hidden",
        }}
      >
        {/* header */}
        <div
          style={{
            height: 92,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 40px",
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 600 }}>Today's lecture</div>
          <RecordingPill elapsed={f + 90} size={22} />
        </div>

        {/* messages */}
        <div style={{ position: "absolute", left: 40, right: 40, top: 120, bottom: 140 }}>
          {sent && (
            <Rise from={118} len={10} style={{ display: "flex", justifyContent: "flex-end" }}>
              <div
                style={{
                  background: C.bubble,
                  padding: "16px 26px",
                  borderRadius: 18,
                  fontSize: 30,
                  fontWeight: 500,
                }}
              >
                {QUESTION}
              </div>
            </Rise>
          )}
          {answerVisible && (
            <div style={{ marginTop: 26 }}>
              <Rise from={126} len={10} style={{ fontSize: 20, color: C.muted, marginBottom: 12 }}>
                Lecture assistant · Default AI
              </Rise>
              <Rise from={130} len={12} style={{ fontSize: 48, fontWeight: 600, letterSpacing: -1 }}>
                Same total. Different mix.
              </Rise>
              <Rise from={138} len={12} style={{ fontSize: 30, color: C.muted, marginTop: 8 }}>
                The total stays the same. The parts change.
              </Rise>
              <div style={{ marginTop: 30, display: "flex", flexDirection: "column", gap: 18, opacity: lin(f, [148, 152], [0, 1]) }}>
                <StackedBar label="Group A" values={[70, 30]} p={chartP} f={f} from={150} />
                <StackedBar label="Group B" values={[30, 70]} p={chartP} f={f} from={150} />
                <div style={{ display: "flex", alignItems: "center", gap: 28, marginLeft: 158, fontSize: 22, color: C.muted, opacity: out(f, [184, 196], [0, 1]) }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, background: C.forest }} /> Part 1
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, background: C.gold }} /> Part 2
                  </span>
                  <span style={{ marginLeft: 12 }}>Example values</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 48, marginTop: 34 }}>
                {[
                  [196, "1", "Compare the totals.", "Both add up to 100."],
                  [206, "2", "Look at the parts.", "The proportions change."],
                ].map(([from, n, t, b]) => (
                  <Rise key={n as string} from={from as number} len={12} style={{ display: "flex", gap: 16, alignItems: "baseline" }}>
                    <span style={{ fontSize: 24, color: C.gold, fontWeight: 700 }}>{n}</span>
                    <span>
                      <span style={{ fontSize: 28, fontWeight: 600 }}>{t}</span>
                      <span style={{ fontSize: 28, color: C.muted }}> {b}</span>
                    </span>
                  </Rise>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* composer */}
        <div
          style={{
            position: "absolute",
            left: 40,
            right: 40,
            bottom: 40,
            height: 72,
            borderRadius: 999,
            border: `2px solid ${focused && !sent ? C.forest : C.line}`,
            background: C.surface,
            display: "flex",
            alignItems: "center",
            padding: "0 16px 0 30px",
            fontSize: 30,
          }}
        >
          <div style={{ flex: 1, display: "flex", alignItems: "center" }}>
            {typed ? (
              <span>{typed}</span>
            ) : !focused || sent ? (
              <span style={{ color: C.muted }}>Ask about this lecture</span>
            ) : null}
            <span style={{ width: 2, height: 36, background: C.ink, marginLeft: 3, opacity: caretOn ? 1 : 0 }} />
          </div>
          <div
            aria-label="Send question"
            style={{
              width: 52,
              height: 52,
              borderRadius: 999,
              background: C.forest,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transform: `scale(${1 - press(112) * 0.1})`,
            }}
          >
            <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </div>
        </div>
      </div>

      <div style={{ opacity: cursorOpacity }}>
        <Cursor x={cx} y={cy} press={pressAmt} />
      </div>

      <div
        style={{
          position: "absolute",
          right: 100,
          bottom: 44,
          fontFamily: FONT,
          fontSize: 22,
          color: C.muted,
          opacity: enter,
        }}
      >
        Illustrative UI. Timing condensed.
      </div>
    </AbsoluteFill>
  );
};

/* ---------- Scene 4: brand 11–15s ---------- */
const Brand: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: C.forest, opacity: lin(f, [0, 12], [0, 1]), fontFamily: FONT, color: C.ivory }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 36, paddingBottom: 40 }}>
        <Rise from={10} len={16} dy={24}>
          <Wordmark h={110} color={C.ivory} invert />
        </Rise>
        <Rise from={22} len={16} style={{ fontSize: 60, fontWeight: 500, letterSpacing: -1 }}>
          AI that listens with you.
        </Rise>
        <Rise from={62} len={14} style={{ marginTop: 40, fontSize: 40, color: C.gold, fontWeight: 600, letterSpacing: 1 }}>
          lecue.app
        </Rise>
      </div>
    </AbsoluteFill>
  );
};

export const Ad15: React.FC = () => (
  <AbsoluteFill style={{ background: C.ivory }}>
    <Sequence from={0} durationInFrames={90} name="Hook">
      <Hook />
    </Sequence>
    <Sequence from={90} durationInFrames={240} name="App">
      <App />
    </Sequence>
    <Sequence from={330} durationInFrames={120} name="Brand">
      <Brand />
    </Sequence>
    <Sequence from={9} name="VO1"><Audio src={staticFile("vo1.wav")} /></Sequence>
    <Sequence from={92} name="VO2"><Audio src={staticFile("vo2.wav")} /></Sequence>
    <Sequence from={336} name="VO3"><Audio src={staticFile("vo3.wav")} /></Sequence>
  </AbsoluteFill>
);
