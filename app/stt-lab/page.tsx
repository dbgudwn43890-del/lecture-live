"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { downsampleAudio, encodeWav } from "../lib/audio";
import styles from "./page.module.css";

type SetupState = "checking" | "ready" | "missing" | "login" | "error";
type RunState = "idle" | "recording" | "error";
type Result = {
  id: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  latencyMs: number;
  verdict?: "good" | "bad";
};

const WINDOW_SECONDS = 6;
const UPDATE_SECONDS = 5;

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
  const [error, setError] = useState("");
  const [requestPending, setRequestPending] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sinkRef = useRef<GainNode | null>(null);
  const intervalRef = useRef<number | null>(null);
  const elapsedIntervalRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const chunksRef = useRef<Float32Array[]>([]);
  const totalSamplesRef = useRef(0);
  const sampleRateRef = useRef(48_000);
  const pendingRef = useRef(false);
  const previousTextRef = useRef("");
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

  const metrics = useMemo(() => {
    const completed = results.filter((result) => result.latencyMs > 0);
    const average = completed.length
      ? Math.round(completed.reduce((sum, result) => sum + result.latencyMs, 0) / completed.length)
      : 0;
    const rated = completed.filter((result) => result.verdict);
    const good = rated.filter((result) => result.verdict === "good").length;
    return { average, rated: rated.length, good };
  }, [results]);

  function stopCapture() {
    if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    if (elapsedIntervalRef.current !== null) window.clearInterval(elapsedIntervalRef.current);
    intervalRef.current = null;
    elapsedIntervalRef.current = null;
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

  async function sendWindow() {
    if (pendingRef.current || totalSamplesRef.current < sampleRateRef.current * 2) return;
    pendingRef.current = true;
    setRequestPending(true);

    const available = totalSamplesRef.current;
    const merged = new Float32Array(available);
    let offset = 0;
    for (const chunk of chunksRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    const windowSamples = Math.min(available, sampleRateRef.current * WINDOW_SECONDS);
    const windowAudio = merged.slice(available - windowSamples);
    const endSeconds = Math.max(0, (Date.now() - startedAtRef.current) / 1_000);
    const startSeconds = Math.max(0, endSeconds - windowSamples / sampleRateRef.current);
    const wav = encodeWav(downsampleAudio(windowAudio, sampleRateRef.current));
    const formData = new FormData();
    formData.set("audio", new File([wav], "lecture-window.wav", { type: "audio/wav" }));
    if (previousTextRef.current) formData.set("prompt", previousTextRef.current.slice(-500));

    try {
      const response = await fetch("/api/transcribe-lab", { method: "POST", body: formData });
      const data = await response.json() as { text?: string; latencyMs?: number; error?: string };
      if (!response.ok) throw new Error(data.error || "음성 인식에 실패했습니다.");
      const text = data.text?.trim() || "(말소리가 감지되지 않았습니다.)";
      previousTextRef.current = text;
      setResults((current) => [
        ...current,
        {
          id: ++resultIdRef.current,
          startSeconds,
          endSeconds,
          text,
          latencyMs: data.latencyMs ?? 0,
        },
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "음성 인식에 실패했습니다.");
      setRunState("error");
      stopCapture();
    } finally {
      pendingRef.current = false;
      setRequestPending(false);
    }
  }

  async function startCapture() {
    if (setup !== "ready" || runState === "recording") return;
    setError("");
    setResults([]);
    setElapsedSeconds(0);
    previousTextRef.current = "";
    chunksRef.current = [];
    totalSamplesRef.current = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("이 브라우저는 마이크 입력을 지원하지 않습니다.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext();
      await context.audioWorklet.addModule("/pcm-capture-worklet.js");
      await context.resume();

      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "pcm-capture");
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet).connect(sink).connect(context.destination);

      sampleRateRef.current = context.sampleRate;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const chunk = new Float32Array(event.data);
        chunksRef.current.push(chunk);
        totalSamplesRef.current += chunk.length;

        const maxSamples = context.sampleRate * (WINDOW_SECONDS + 2);
        while (
          chunksRef.current.length > 1 &&
          totalSamplesRef.current - chunksRef.current[0].length >= maxSamples
        ) {
          totalSamplesRef.current -= chunksRef.current.shift()!.length;
        }
      };

      streamRef.current = stream;
      contextRef.current = context;
      sourceRef.current = source;
      workletRef.current = worklet;
      sinkRef.current = sink;
      startedAtRef.current = Date.now();
      setRunState("recording");
      intervalRef.current = window.setInterval(() => void sendWindow(), UPDATE_SECONDS * 1_000);
      elapsedIntervalRef.current = window.setInterval(() => {
        setElapsedSeconds((Date.now() - startedAtRef.current) / 1_000);
      }, 250);
    } catch (caught) {
      stopCapture();
      setRunState("error");
      setError(caught instanceof Error ? caught.message : "마이크를 시작하지 못했습니다.");
    }
  }

  function rateResult(id: number, verdict: "good" | "bad") {
    setResults((current) => current.map((result) => result.id === id ? { ...result, verdict } : result));
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
          <p>WHISPER LARGE V3 TURBO · 5초 갱신 실험</p>
          <h1>한국어 강의,<br />직접 검증하기.</h1>
        </div>
        <p>6초 음성을 5초마다 보내 새 결과를 받습니다(겹침 1초). 이 화면은 기존 Deepgram 강의실과 분리된 비용·품질 검증용이며, 음성 원본을 Lecue에 저장하지 않습니다.</p>
      </section>

      <section className={styles.setup} aria-live="polite">
        <strong>준비 상태</strong>
        {setup === "checking" && <p>서버 설정을 확인하는 중입니다.</p>}
        {setup === "ready" && <p className={styles.ready}>연결 준비 완료 · 마이크 테스트를 시작할 수 있습니다.</p>}
        {setup === "login" && <p><Link href="/login">먼저 로그인</Link>한 뒤 이 화면으로 돌아오세요.</p>}
        {setup === "missing" && <p><code>.env.local</code>에 <code>CLOUDFLARE_ACCOUNT_ID</code>와 <code>CLOUDFLARE_API_TOKEN</code>을 넣고 개발 서버를 다시 시작해야 합니다.</p>}
        {setup === "error" && <p>설정 상태를 읽지 못했습니다. 개발 서버 로그를 확인해 주세요.</p>}
      </section>

      <section className={styles.controls}>
        <div>
          <span className={runState === "recording" ? styles.liveDot : styles.idleDot} />
          <strong>{runState === "recording" ? "기록 중" : "대기 중"}</strong>
          <time>{formatSeconds(elapsedSeconds)}</time>
          {requestPending && <small>전사 중…</small>}
        </div>
        {runState === "recording"
          ? <button className={styles.stopButton} type="button" onClick={stopCapture}>테스트 끝내기</button>
          : <button type="button" onClick={() => void startCapture()} disabled={setup !== "ready"}>마이크 테스트 시작</button>}
      </section>

      {error && <p className={styles.error} role="alert">{error}</p>}

      <div className={styles.workspace}>
        <section className={styles.script}>
          <header><span>읽을 예시</span><small>보통 말하는 속도로 읽으세요</small></header>
          <div>
            <p>증권은 재산상의 권리를 나타내는 문서나 전자 기록입니다. 주식은 회사의 일부를 소유한다는 권리이고, 채권은 돈을 빌려주고 돌려받을 권리입니다.</p>
            <p>증권회사는 기업이 주식이나 채권을 발행해 자금을 모으는 절차를 돕습니다. 투자자가 매수와 매도 주문을 내면 그 주문이 시장에서 체결되도록 연결하기도 합니다.</p>
            <p>이 실험에서는 경제학개론, 인공지능, 미분방정식처럼 한국어 강의에서 자주 나오는 표현과 숫자, 영어가 섞인 용어가 얼마나 정확히 기록되는지 확인합니다.</p>
          </div>
        </section>

        <section className={styles.results}>
          <header><span>5초마다 받은 결과</span><small>{results.length}개 구간</small></header>
          <div className={styles.resultList}>
            {!results.length && <div className={styles.empty}><b>아직 결과가 없습니다.</b><span>시작 후 첫 결과까지 약 5초와 모델 처리 시간이 걸립니다.</span></div>}
            {results.map((result) => (
              <article key={result.id}>
                <header><time>{formatSeconds(result.startSeconds)}–{formatSeconds(result.endSeconds)}</time><span>응답 {(result.latencyMs / 1_000).toFixed(1)}초</span></header>
                <p>{result.text}</p>
                <div><span>이 구간은 쓸 만한가요?</span><button className={result.verdict === "good" ? styles.selected : undefined} type="button" onClick={() => rateResult(result.id, "good")}>좋음</button><button className={result.verdict === "bad" ? styles.selected : undefined} type="button" onClick={() => rateResult(result.id, "bad")}>아쉬움</button></div>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className={styles.metrics}>
        <div><span>평균 모델 응답</span><strong>{metrics.average ? `${(metrics.average / 1_000).toFixed(1)}초` : "—"}</strong></div>
        <div><span>직접 평가</span><strong>{metrics.rated ? `${metrics.good}/${metrics.rated} 좋음` : "—"}</strong></div>
        <p>합격 기준 제안: 조용한 환경과 실제 강의 환경에서 각각 10분씩 시험해 핵심 용어가 대부분 맞고, 결과가 발화 후 10초 안에 안정적으로 보이면 메인 경로에 연결합니다.</p>
      </section>
    </main>
  );
}
