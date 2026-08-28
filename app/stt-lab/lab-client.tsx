"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { downsampleAudio, encodeWav } from "../lib/audio";
import { characterErrorRate, termRecall } from "../lib/cer";
import { utteranceSegment } from "../lib/deepgram";
import type { DeepgramFinal } from "../lib/deepgram";
import styles from "./page.module.css";

type SetupState = "checking" | "ready" | "missing" | "login" | "error";
type RunState = "idle" | "recording" | "error";
type Result = { id: number; startSeconds: number; endSeconds: number; text: string; latencyMs: number };
type DeepgramMessage = DeepgramFinal & { type?: string; is_final?: boolean; speech_final?: boolean };

const REFERENCE_SCRIPT = [
  "증권은 재산상의 권리를 나타내는 문서나 전자 기록입니다. 주식은 회사의 일부를 소유한다는 권리이고, 채권은 돈을 빌려주고 돌려받을 권리입니다.",
  "증권회사는 기업이 주식이나 채권을 발행해 자금을 모으는 절차를 돕습니다. 투자자가 매수와 매도 주문을 내면 그 주문이 시장에서 체결되도록 연결하기도 합니다.",
  "이 실험에서는 경제학개론, 인공지능, 미분방정식처럼 한국어 강의에서 자주 나오는 표현과 숫자, 영어가 섞인 용어가 얼마나 정확히 기록되는지 확인합니다.",
].join("\n");

function formatSeconds(value: number) {
  const minutes = Math.floor(value / 60);
  const seconds = Math.floor(value % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function KoreanSttLab() {
  const [setup, setSetup] = useState<SetupState>("checking");
  const [runState, setRunState] = useState<RunState>("idle");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [interim, setInterim] = useState("");
  const [reference, setReference] = useState(REFERENCE_SCRIPT);
  const [keyterms, setKeyterms] = useState("");
  const [error, setError] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const elapsedIntervalRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const bufferRef = useRef<DeepgramMessage[]>([]);
  const resultIdRef = useRef(0);

  useEffect(() => {
    fetch("/api/transcribe-lab", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) return setSetup("login");
        if (!response.ok) return setSetup("error");
        const data = await response.json() as { configured?: boolean };
        setSetup(data.configured ? "ready" : "missing");
      })
      .catch(() => setSetup("error"));

    return () => stopCapture();
  }, []);

  const transcript = useMemo(() => results.map((result) => result.text).join(" "), [results]);

  // 엄지 척/아래로는 keyterm 개수도 포맷 옵션도 정할 수 없다. 여기 숫자가
  // 강의 경로의 설정을 정한다 (PRD 26.2).
  const metrics = useMemo(() => {
    const terms = keyterms.split(/[,\n]/).map((term) => term.trim()).filter(Boolean);
    const latencies = results.filter((result) => result.latencyMs > 0);
    return {
      cer: transcript && reference.trim() ? characterErrorRate(reference, transcript) : null,
      recall: terms.length ? termRecall(terms, transcript) : null,
      latency: latencies.length
        ? Math.round(latencies.reduce((sum, result) => sum + result.latencyMs, 0) / latencies.length)
        : 0,
    };
  }, [keyterms, reference, results, transcript]);

  function flushUtterance() {
    const finals = bufferRef.current;
    bufferRef.current = [];
    setInterim("");
    if (!finals.length) return;
    const segment = utteranceSegment(finals);
    if (!segment) return;
    setResults((current) => [...current, {
      id: ++resultIdRef.current,
      startSeconds: segment.startMs / 1_000,
      endSeconds: segment.endMs / 1_000,
      text: segment.text,
      latencyMs: Math.max(0, Date.now() - (startedAtRef.current + segment.endMs)),
    }]);
  }

  function stopCapture() {
    if (elapsedIntervalRef.current !== null) window.clearInterval(elapsedIntervalRef.current);
    elapsedIntervalRef.current = null;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "CloseStream" }));
    }
    socketRef.current?.close();
    socketRef.current = null;
    workletRef.current?.disconnect();
    sourceRef.current?.disconnect();
    sinkRef.current?.disconnect();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void contextRef.current?.close();
    streamRef.current = null;
    contextRef.current = null;
    sourceRef.current = null;
    workletRef.current = null;
    sinkRef.current = null;
    setRunState("idle");
  }

  async function startCapture() {
    if (setup !== "ready" || runState === "recording") return;
    setError("");
    setResults([]);
    setInterim("");
    setElapsedSeconds(0);
    bufferRef.current = [];

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 마이크 입력을 지원하지 않습니다.");

      const tokenResponse = await fetch("/api/transcribe-lab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyterms }),
      });
      const tokenData = await tokenResponse.json() as { accessToken?: string; listenUrl?: string; error?: string };
      if (!tokenResponse.ok || !tokenData.accessToken || !tokenData.listenUrl) {
        throw new Error(tokenData.error || "음성 인식 연결을 준비하지 못했습니다.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      await context.audioWorklet.addModule("/pcm-capture-worklet.js");
      await context.resume();

      const socket = new WebSocket(tokenData.listenUrl, ["bearer", tokenData.accessToken]);
      socketRef.current = socket;
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as DeepgramMessage;
        if (message.type === "UtteranceEnd") return flushUtterance();
        if (message.type !== "Results") return;
        const text = message.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
        if (message.is_final) {
          if (text) bufferRef.current.push(message);
          if (message.speech_final) flushUtterance();
          else setInterim(utteranceSegment(bufferRef.current)?.text ?? "");
          return;
        }
        if (!text) return;
        const buffered = utteranceSegment(bufferRef.current)?.text ?? "";
        setInterim(buffered ? `${buffered} ${text}` : text);
      };
      socket.onclose = () => {
        // stopCapture clears the current socket before its close event arrives.
        // If this socket is still current, Deepgram closed it unexpectedly.
        if (socketRef.current === socket) {
          setError("연결이 끊겼습니다. 다시 시작해 주세요.");
          stopCapture();
        }
      };

      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "pcm-capture");
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(context.destination);

      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // 랩은 컨테이너 없는 PCM이 맞는 유일한 곳이다. 헤더가 없으니 프레이밍이
        // 바이트 단위로 정확하고, 재연결 시 초기화 세그먼트 문제도 없다.
        const wav = encodeWav(downsampleAudio(new Float32Array(event.data), context.sampleRate));
        socket.send(wav.slice(44));
      };

      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = source;
      workletRef.current = worklet;
      sinkRef.current = sink;
      startedAtRef.current = Date.now();
      setRunState("recording");
      elapsedIntervalRef.current = window.setInterval(() => {
        setElapsedSeconds((Date.now() - startedAtRef.current) / 1_000);
      }, 250);
    } catch (caught) {
      stopCapture();
      setRunState("error");
      setError(caught instanceof Error ? caught.message : "마이크를 시작하지 못했습니다.");
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.topbar}>
        <Link href="/">Lecue</Link>
        <span>한국어 STT 실험실</span>
        <Link href="/classroom">기존 강의실</Link>
      </header>

      <section className={styles.intro}>
        <div>
          <p>DEEPGRAM NOVA-3 · 실시간 스트리밍</p>
          <h1>한국어 강의,<br />숫자로 검증하기.</h1>
        </div>
        <p>강의 경로와 같은 파라미터로 소켓을 열고, 아래 기준 원고와 대조해 문자 오류율·용어 재현율·확정 지연을 잽니다. 크레딧은 차감하지 않으며 음성 원본을 Lecue에 저장하지 않습니다.</p>
      </section>

      <section className={styles.setup} aria-live="polite">
        <strong>준비 상태</strong>
        {setup === "checking" && <p>서버 설정을 확인하는 중입니다.</p>}
        {setup === "ready" && <p className={styles.ready}>연결 준비 완료 · 마이크 테스트를 시작할 수 있습니다.</p>}
        {setup === "login" && <p><Link href="/login">먼저 로그인</Link>한 뒤 이 화면으로 돌아오세요.</p>}
        {setup === "missing" && <p><code>.env.local</code>에 <code>DEEPGRAM_API_KEY</code>를 넣고 개발 서버를 다시 시작해야 합니다.</p>}
        {setup === "error" && <p>설정 상태를 읽지 못했습니다. 개발 서버 로그를 확인해 주세요.</p>}
      </section>

      <section className={styles.controls}>
        <div>
          <span className={runState === "recording" ? styles.liveDot : styles.idleDot} />
          <strong>{runState === "recording" ? "기록 중" : "대기 중"}</strong>
          <time>{formatSeconds(elapsedSeconds)}</time>
          {interim && <small>{interim}</small>}
        </div>
        {runState === "recording"
          ? <button className={styles.stopButton} type="button" onClick={stopCapture}>테스트 끝내기</button>
          : <button type="button" onClick={() => void startCapture()} disabled={setup !== "ready"}>마이크 테스트 시작</button>}
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.workspace}>
        <section className={styles.script}>
          <header><span>기준 원고</span><small>이 글을 읽으면 오류율이 계산됩니다</small></header>
          <div>
            <textarea
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              rows={8}
              aria-label="기준 원고"
              disabled={runState === "recording"}
            />
            <label>
              <span>용어집 (쉼표로 구분)</span>
              <input
                value={keyterms}
                onChange={(event) => setKeyterms(event.target.value)}
                placeholder="한계효용, 기회비용"
                disabled={runState === "recording"}
              />
            </label>
          </div>
        </section>

        <section className={styles.results}>
          <header><span>발화 단위 결과</span><small>{results.length}개 구간</small></header>
          <div className={styles.resultList}>
            {!results.length && <div className={styles.empty}><b>아직 결과가 없습니다.</b><span>한 문장을 말하고 잠시 쉬면 첫 구간이 확정됩니다.</span></div>}
            {results.map((result) => (
              <article key={result.id}>
                <header><time>{formatSeconds(result.startSeconds)}–{formatSeconds(result.endSeconds)}</time><span>확정 {(result.latencyMs / 1_000).toFixed(1)}초</span></header>
                <p>{result.text}</p>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className={styles.metrics}>
        <div><span>문자 오류율</span><strong>{metrics.cer === null ? "—" : `${(metrics.cer * 100).toFixed(1)}%`}</strong></div>
        <div><span>용어 재현율</span><strong>{metrics.recall === null ? "—" : `${(metrics.recall * 100).toFixed(0)}%`}</strong></div>
        <div><span>평균 확정 지연</span><strong>{metrics.latency ? `${(metrics.latency / 1_000).toFixed(1)}초` : "—"}</strong></div>
        <p>같은 원고를 조용한 환경과 실제 강의 환경에서 각각 읽고, 용어집 개수와 포맷 옵션을 하나씩 바꿔 이 세 숫자로 비교합니다.</p>
      </section>
    </main>
  );
}
