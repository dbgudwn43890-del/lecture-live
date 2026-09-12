import { PcmStreamEncoder } from "../lib/pcm-stream.ts";

export type PcmRecorder = { state: "recording" | "stopping" | "inactive"; stop(): Promise<void> };

/** Canonical mono PCM for the metered server relay, with no audible output. */
export async function createPcmRecorder(stream: MediaStream, onData: (bytes: ArrayBuffer) => void, onStop: () => void | Promise<void>): Promise<PcmRecorder> {
  let context: AudioContext;
  try { context = new AudioContext({ sampleRate: 16_000 }); } catch { context = new AudioContext(); }
  try {
    await context.audioWorklet.addModule("/pcm-capture-worklet.js");
    const encoder = new PcmStreamEncoder(context.sampleRate);
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "pcm-capture", { channelCount: 1, channelCountMode: "explicit", numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const silent = context.createGain();
    silent.gain.value = 0;
    source.connect(capture); capture.connect(silent); silent.connect(context.destination);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishCapture!: () => void;
    const stopped = new Promise<void>((resolve) => { finishCapture = resolve; }).then(onStop);
    const finish = () => {
      if (recorder.state === "inactive") return;
      recorder.state = "inactive";
      clearTimeout(timer);
      capture.port.onmessage = null;
      source.disconnect(); capture.disconnect(); silent.disconnect();
      void context.close().catch(() => {});
      finishCapture();
    };
    const recorder: PcmRecorder = {
      state: "recording",
      stop() {
        if (recorder.state === "recording") {
          recorder.state = "stopping";
          capture.port.postMessage({ type: "flush" });
          timer = setTimeout(finish, 250);
        }
        return stopped;
      },
    };
    capture.port.onmessage = (event: MessageEvent<ArrayBuffer | { type: string }>) => {
      if (recorder.state === "inactive") return;
      if (event.data instanceof ArrayBuffer) {
        const bytes = encoder.encode(new Float32Array(event.data));
        if (bytes.byteLength) onData(bytes);
      } else if (event.data?.type === "flushed") finish();
    };
    await context.resume();
    return recorder;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
