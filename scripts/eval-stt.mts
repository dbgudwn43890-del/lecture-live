/**
 * STT 공급자 CER 실측: Deepgram(현행) vs Soniox vs Groq Whisper.
 * 강의 오디오 하나와 사람이 만든 기준 원고를 주면 세 공급자의 받아쓰기를
 * 같은 자로 잰다 (app/lib/cer.ts — 스트리밍 경로와 같은 채점 기준).
 *
 *   node --experimental-strip-types scripts/eval-stt.mts \
 *     --audio sample.m4a --ref sample.txt [--hints ko,en] [--terms "RAG,idempotency"]
 *
 * 필요한 키(없는 공급자는 건너뜀): DEEPGRAM_API_KEY, SONIOX_API_KEY, GROQ_API_KEY
 * 받아쓴 전문은 <audio>.<provider>.txt 로 남긴다 — 숫자만 보고 판단하지 말 것.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { characterErrorRate, termRecall } from "../app/lib/cer.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const audioPath = arg("audio");
const refPath = arg("ref");
if (!audioPath || !refPath) {
  console.error("usage: node --experimental-strip-types scripts/eval-stt.mts --audio <file> --ref <transcript.txt> [--hints ko,en] [--terms a,b]");
  process.exit(1);
}
const hints = (arg("hints") ?? "ko,en").split(",").map((hint) => hint.trim()).filter(Boolean);
const terms = (arg("terms") ?? "").split(",").map((term) => term.trim()).filter(Boolean);
const audio = readFileSync(audioPath);
const reference = readFileSync(refPath, "utf8");

async function deepgram(): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY 없음");
  // 운영 배치 경로와 같은 설정 (app/lib/deepgram.ts 참고: nova-3 + ko).
  const response = await fetch("https://api.deepgram.com/v1/listen?model=nova-3&language=ko&smart_format=true", {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/octet-stream" },
    body: audio,
  });
  if (!response.ok) throw new Error(`deepgram ${response.status}: ${await response.text()}`);
  const data = await response.json() as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } };
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}

async function soniox(): Promise<string> {
  const key = process.env.SONIOX_API_KEY;
  if (!key) throw new Error("SONIOX_API_KEY 없음");
  const auth = { Authorization: `Bearer ${key}` };

  const form = new FormData();
  form.set("file", new Blob([audio]), basename(audioPath!));
  const uploadResponse = await fetch("https://api.soniox.com/v1/files", { method: "POST", headers: auth, body: form });
  if (!uploadResponse.ok) throw new Error(`soniox upload ${uploadResponse.status}: ${await uploadResponse.text()}`);
  const { id: fileId } = await uploadResponse.json() as { id: string };

  const createResponse = await fetch("https://api.soniox.com/v1/transcriptions", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "stt-async-preview",
      file_id: fileId,
      language_hints: hints,
      // keyterm 대응물. 영어 전공용어가 한글 음차로 적히지 않게 표기를 고정한다.
      ...(terms.length ? { context: { terms } } : {}),
    }),
  });
  if (!createResponse.ok) throw new Error(`soniox create ${createResponse.status}: ${await createResponse.text()}`);
  const { id } = await createResponse.json() as { id: string };

  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const pollResponse = await fetch(`https://api.soniox.com/v1/transcriptions/${id}`, { headers: auth });
    const status = await pollResponse.json() as { status: string; error_message?: string };
    if (status.status === "completed") break;
    if (status.status === "error") throw new Error(`soniox: ${status.error_message}`);
    if (attempt === 119) throw new Error("soniox: 4분 내 완료 안 됨");
  }
  const textResponse = await fetch(`https://api.soniox.com/v1/transcriptions/${id}/transcript`, { headers: auth });
  const { text } = await textResponse.json() as { text: string };
  return text;
}

async function groq(): Promise<string> {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY 없음");
  const form = new FormData();
  form.set("file", new Blob([audio]), basename(audioPath!));
  form.set("model", "whisper-large-v3-turbo");
  form.set("response_format", "json");
  // language 미지정: 한·영 혼용을 스스로 어떻게 다루는지가 시험 대상이다.
  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!response.ok) throw new Error(`groq ${response.status}: ${await response.text()}`);
  const { text } = await response.json() as { text: string };
  return text;
}

const providers: Array<[string, () => Promise<string>]> = [
  ["deepgram", deepgram],
  ["soniox", soniox],
  ["groq", groq],
];

console.log(`audio=${audioPath} ref=${refPath} hints=${hints.join(",")}\n`);
const rows: string[] = [];
for (const [name, run] of providers) {
  const startedAt = Date.now();
  try {
    const hypothesis = await run();
    const seconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    writeFileSync(`${audioPath}.${name}.txt`, hypothesis);
    const cer = (characterErrorRate(reference, hypothesis) * 100).toFixed(2);
    const recall = terms.length ? ` termRecall=${(termRecall(terms, hypothesis) * 100).toFixed(0)}%` : "";
    rows.push(`${name.padEnd(9)} CER=${cer}%${recall}  (${seconds}s) -> ${audioPath}.${name}.txt`);
  } catch (caught) {
    rows.push(`${name.padEnd(9)} 실패: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}
console.log(rows.join("\n"));
