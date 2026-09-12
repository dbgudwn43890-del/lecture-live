"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Maximize, Minimize, MonitorPlay } from "lucide-react";

/** Local video-only view of the already-authorized tab. Never encode or upload frames. */
export default function LecturePreview({ stream, isEnglish, waitingForAudio = false, onAspectRatioChange }: { stream: MediaStream | null; isEnglish: boolean; waitingForAudio?: boolean; onAspectRatioChange?: (ratio: number) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [needsPlay, setNeedsPlay] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [expandError, setExpandError] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);
  useEffect(() => { onAspectRatioChange?.(aspectRatio); }, [aspectRatio, onAspectRatioChange]);
  useEffect(() => {
    const workspace = videoRef.current?.closest(".workspace-main");
    const update = () => setExpanded(Boolean(workspace && document.fullscreenElement === workspace));
    document.addEventListener("fullscreenchange", update);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      if (workspace && document.fullscreenElement === workspace) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let active = true;
    const updateRatio = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) setAspectRatio(video.videoWidth / video.videoHeight);
    };
    video.addEventListener("resize", updateRatio);
    video.addEventListener("loadedmetadata", updateRatio);
    video.srcObject = stream;
    setAspectRatio(16 / 9);
    setNeedsPlay(false);
    if (stream) void video.play().catch(() => { if (active) setNeedsPlay(true); });
    return () => {
      active = false;
      video.removeEventListener("resize", updateRatio);
      video.removeEventListener("loadedmetadata", updateRatio);
      video.srcObject = null; // recorder owns tracks
    };
  }, [stream]);
  return <div className="lecture-preview" style={{ "--preview-ratio": aspectRatio } as CSSProperties}>
    <div className="lecture-preview-stage"><div className="lecture-preview-screen">
      <video ref={videoRef} autoPlay muted playsInline aria-label={isEnglish ? "Shared lecture screen" : "공유 중인 강의 화면"} hidden={!stream} />
      {!stream && <p><MonitorPlay size={28} aria-hidden="true" />{isEnglish ? "Your shared lecture will appear here." : "공유한 강의 화면이 여기에 표시돼요."}</p>}
      {needsPlay && <button type="button" onClick={() => void videoRef.current?.play().then(() => setNeedsPlay(false)).catch(() => {})}>{isEnglish ? "Show lecture" : "강의 화면 보기"}</button>}
    </div></div>
    <div className="lecture-preview-caption"><span role="status">{waitingForAudio
      ? (isEnglish ? "Play your lecture to start receiving audio." : "강의를 재생하면 소리가 들어와요.")
      : (isEnglish ? "Playback and speed: original lecture tab" : "재생·배속 조절은 원래 강의 탭에서")}</span>
      {stream && <button type="button" aria-label={expanded ? (isEnglish ? "Exit full screen" : "전체 화면 나가기") : (isEnglish ? "Full screen with questions" : "질문과 함께 전체 화면")} onClick={() => {
        setExpandError(false);
        const panel = videoRef.current?.closest<HTMLElement>(".workspace-main");
        const action = document.fullscreenElement ? document.exitFullscreen() : panel?.requestFullscreen?.();
        if (action) void action.catch(() => setExpandError(true));
        else setExpandError(true);
      }}>{expanded ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}</button>}
    </div>
    {expandError && <p role="status">{isEnglish ? "Couldn’t enter full screen. Try clicking the button again." : "전체 화면을 열지 못했어요. 버튼을 다시 눌러 주세요."}</p>}
  </div>;
}
