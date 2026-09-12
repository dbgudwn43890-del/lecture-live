import type { PcmRecorder } from "../classroom/pcm-recorder";

/** Paired remote capture; bytes are canonical 16 kHz mono signed PCM16 LE. */
export type ExternalPcmSource = {
  /**
   * Resolve after capture-start acknowledgement. stop() waits for final PCM
   * and the stopped acknowledgement, then awaits onStop. It keeps the pair.
   * onEnded is unexpected input loss after the transport's reconnect grace;
   * intentional stop/dispose must not call it.
   */
  start(onData: (bytes: ArrayBuffer) => void, onStop: () => void | Promise<void>, onEnded: () => void): Promise<PcmRecorder>;
  /** Pair is usable, including paused capture and the <=5s reconnect grace. */
  isLive(): boolean;
  /** Final, idempotent cleanup: stop capture and revoke the pairing. */
  dispose(): void;
};
