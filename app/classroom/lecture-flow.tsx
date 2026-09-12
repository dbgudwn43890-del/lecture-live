import { ArrowDown } from "lucide-react";
import { useConversationScroll } from "./use-conversation-scroll";
import type { useLiveScript } from "./use-live-script";

function time(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
}

function emphasize(text: string, keywords: string[]) {
  const words = keywords.filter(Boolean).sort((left, right) => right.length - left.length);
  if (!words.length) return text;
  const pattern = new RegExp("(" + words.map(word => word.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  const known = new Set(words.map(word => word.toLocaleLowerCase()));
  return text.split(pattern).map((part, index) => known.has(part.toLocaleLowerCase())
    ? <mark key={index}>{part}</mark> : part);
}

export default function LectureFlow({ sessionId, english, status, script }: {
  sessionId: string; english: boolean; status: string; script: ReturnType<typeof useLiveScript>;
}) {
  const { entries, pending, phase, error, retry } = script;
  const { messagesScrollRef, isFollowingLatest, jumpToLatest } = useConversationScroll(entries, sessionId);
  return <div className="live-script-view">
    <div className="lecture-flow-body live-script-scroll" ref={messagesScrollRef} tabIndex={0}
      role="region" aria-label={english ? "Live lecture text" : "실시간 강의 내용"}>
      {entries.length === 0 && !pending && !error && <div className="lecture-flow-empty">
        <strong>{english ? "Follow along, a few words at a time" : "방금 한 말부터, 짧게"}</strong>
        <p>{!sessionId || status === "idle"
          ? (english ? "Start the lecture. Lightly shortened speech will appear here as you listen." : "수업을 시작하면 들은 말을 조금씩 다듬어 보여드려요.")
          : (english ? "New sentences appear once the speech is recognized." : "말소리가 인식되면 짧게 다듬은 문장이 이어져요.")}</p>
      </div>}
      {entries.length > 0 && <ol className="live-script-lines">{entries.map(entry => <li key={entry.id}>
        <span className="lecture-flow-time">{time(entry.startMs)}</span>
        <p>{emphasize(entry.text, entry.keywords)}</p>
      </li>)}</ol>}
      {pending && !error && <p className="live-script-working" role="status">
        {phase === "processing" ? (english ? "Tidying up the latest words…" : "방금 들은 말을 다듬고 있어요…")
          : (english ? "The next words are on their way…" : "이어서 한 말을 받아오고 있어요…")}
      </p>}
      {error && <div className="lecture-flow-feedback" role="status">
        <p>{error}</p><button type="button" onClick={retry}>{english ? "Try again" : "다시 이어받기"}</button>
      </div>}
    </div>
    {!isFollowingLatest && entries.length > 0 && <button type="button" className="live-script-latest" onClick={jumpToLatest}>
      <ArrowDown size={13} aria-hidden="true" />{english ? "Latest words" : "최근 내용으로"}
    </button>}
  </div>;
}
