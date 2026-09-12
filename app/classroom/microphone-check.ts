/** Local level check only: no recorder, network connection, or credit request. */
export async function startMicrophoneCheck(deviceId: string, onLevel: (level: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
  let context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    // An incompletely connected node may reject disconnect; release the mic anyway.
    try { source?.disconnect(); } catch {}
    stream.getTracks().forEach(track => track.stop());
    void context?.close().catch(() => {});
  };
  try {
    context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source = context.createMediaStreamSource(stream);
    source.connect(analyser);
    const bytes = new Uint8Array(analyser.fftSize);
    const sample = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(bytes);
      const rms = Math.sqrt(bytes.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / bytes.length);
      onLevel(Math.min(1, rms * 5));
      frame = requestAnimationFrame(sample);
    };
    await context.resume();
    sample();
    return { label: stream.getAudioTracks()[0]?.label ?? "", stop };
  } catch (error) {
    stop();
    throw error;
  }
}
