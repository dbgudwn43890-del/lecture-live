export function listeningState(status: string, waitingForAudio: boolean, finalizing: boolean, english: boolean) {
  if (finalizing) return { live: false, text: english ? "Saving your lecture…" : "수업을 저장하고 있어요" };
  if (status === "recording") return waitingForAudio
    ? { live: false, text: english ? "Waiting for lecture audio" : "강의 소리를 기다리고 있어요" }
    : { live: true, text: english ? "Listening along with you" : "소리를 함께 듣고 있어요" };
  const copy: Record<string, [string, string]> = {
    connecting: ["소리를 연결하고 있어요", "Connecting your audio"],
    paused: ["잠시 듣기를 멈췄어요", "Listening paused"],
    ended: ["함께 듣기를 마쳤어요", "Listening finished"],
    error: ["듣기가 멈췄어요 · 안내를 확인해 주세요", "Listening stopped · Check the notice"],
    idle: ["시작하면 함께 들을게요", "Ready to listen with you"],
  };
  return { live: false, text: (copy[status] ?? copy.idle)[english ? 1 : 0] };
}
