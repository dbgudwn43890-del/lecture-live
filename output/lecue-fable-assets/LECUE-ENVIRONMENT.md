# Lecue: product and execution environment

Verified on September 11, 2026. This is a factual asset handoff. Fable owns the video concept, structure, copy, storyboard and production decisions; no previous advertising plan is included.

## Product

Lecue is a browser-based learning assistant for university students. It listens to lecture audio, transcribes it, and uses the lecture context to answer the student's questions. The student can refer to a recent part of the lecture without manually supplying all the context. The central value is having an AI listening alongside you while you learn.

The product includes microphone-based in-person lectures, an online lecture audio option, recording upload, classroom/session organization, lecture materials, contextual Q&A, and review notes. Answers can include formatted explanations, tables and native charts when appropriate. The provided screenshots show the real interface. Availability and enabled states depend on the current session, account and permissions.

## Web access

- Public site: https://www.lecue.app/
- English site: https://www.lecue.app/en
- English classroom: https://www.lecue.app/en/classroom
- Local English classroom: http://localhost:3000/en/classroom
- Google Chrome is installed. An authenticated English production classroom tab exists on the owner's machine. Authentication belongs to that browser profile; it is not included in this package or automatically available to Fable.
- Microphone capture needs localhost or HTTPS, browser permission, and an explicit start action. An online lecture may require selecting a tab and enabling tab audio.
- This handoff includes no account cookies, API keys, environment secrets or private session URL. Fable running in a separate/cloud environment cannot access this machine's localhost or paths automatically.

## Local application environment

- OS: macOS 26.3.1, Apple Silicon (arm64).
- Shell: zsh.
- Repository: `/Users/kim2choi/01_Projects/강의_실시간`
- Installed Node.js: 26.8.1.
- Installed Next.js: 16.3.3; React: 19.2.8; TypeScript project.
- Application command: `npm run dev`, from the repository root.
- A Node process was observed listening on 127.0.0.1:3000. The sandbox's HTTP request could not connect, so HTTP health is not certified by this check. No server was started, stopped or restarted.
- Existing backend configuration is local to the owner. The app integrates authenticated storage and remote transcription/AI services; copying the frontend alone does not reproduce those services.
- The root README contains older stack information. The installed package versions above take precedence.

## Available local video workspace

`/Users/kim2choi/01_Projects/강의_실시간/output/lecue-youtube-ad-us-v3/video`

Remotion 4.0.523 and dependencies are installed. This is a scaffold: its current composition is empty, 1280×720 and 60 frames, not a finished ad. `npm run dev` opens Remotion Studio; `npm run build` bundles it. The folder and tools are optional resources, not a required creative or rendering workflow.

FFmpeg and FFprobe binaries also exist under that workspace's `node_modules/@remotion/compositor-darwin-arm64/`. They need that directory on `DYLD_LIBRARY_PATH`. FFprobe successfully inspected the supplied MOV. This bundled FFmpeg has a restricted filter build; do not assume every standard filter is supported.

Fable and its connected video tools were not accessible or inspected in this Codex session. Their executable names, API schemas, model version, authentication, rendering capabilities and filesystem access are therefore not asserted here.

## Assets

See `ASSETS.md` for dimensions, content and capture state. The owner's preferred answer is the three-row bond-price graph screenshot. The MOV is useful for real scrolling; its answer is not the preferred answer. A cursor-hidden, cropped MP4 derivative is included.

The package does not contain an ad script, prescribed shot order, timings, voiceover, animation plan or synthetic answer fixture.

## Owner's existing brief

US university and graduate students; English; maximum about 15 seconds; polished motion-graphics treatment; actual product use; AI listening alongside the student; no need to understand the lecture subject; no “Try the 30-second demo” CTA. Fable decides the creative execution.

## Capture conditions

Codex's screen-sharing/control cursor is not part of Lecue's product UI. It must not be treated as a brand asset or reproduced in generated interface assets. A cursor already burned into a screenshot or MOV is independent of any future cursor display setting.

Existing recordings must be preserved. Asset work does not require changing application code, provider configuration or the running server. The application repository's recording checks apply if changes affecting recording are later requested.
