"use client";
import { useEffect, useRef, useState } from "react";
import { Maximize, MonitorPlay } from "lucide-react";

/** Local video-only view of the already-authorized tab. Never encode or upload frames. */
export default function LecturePreview({ stream, isEnglish }: { stream: MediaStream | null; isEnglish: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    video.srcObject = stream;
    setNeedsPlay(false);
    if (stream) void video.play().catch(() => { if (active) setNeedsPlay(true); });
    return () => { active = false; video.srcObject = null; }; // recorder owns tracks
  }, [stream]);
  return <div className="lecture-preview">
    <div className="lecture-preview-screen">
      <video ref={videoRef} autoPlay muted playsInline aria-label={isEnglish ? "Shared lecture screen" : "공유 중인 강의 화면"} hidden={!stream} />
      {!stream && <p><MonitorPlay size={28} aria-hidden="true" />{isEnglish ? "Your shared lecture will appear here." : "공유한 강의 화면이 여기에 표시돼요."}</p>}
      {needsPlay && <button type="button" onClick={() => void videoRef.current?.play().then(() => setNeedsPlay(false)).catch(() => {})}>{isEnglish ? "Show lecture" : "강의 화면 보기"}</button>}
    </div>
    <div className="lecture-preview-caption"><span>{isEnglish ? "Control playback in the original lecture tab." : "재생·배속은 원래 강의 탭에서 조절하세요."}</span>
      {stream && <button type="button" aria-label={isEnglish ? "Full screen" : "전체 화면"} onClick={() => void videoRef.current?.requestFullscreen?.().catch(() => {})}><Maximize size={16} aria-hidden="true" /></button>}
    </div>
  </div>;
}
