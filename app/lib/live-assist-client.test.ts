import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLiveConversation, buildLiveMaterialRevision, buildLiveTranscript, createLiveAssistController, novelSpeech, parseRetryAfter, readLiveAssistStream, speechKey, type LiveAssistInput } from "./live-assist-client.ts";

const encoder = new TextEncoder();
const waitResponse = () => new Response('{"decision":"wait"}\n');
const answerResponse = (text = "A clear explanation.") => new Response([
  { decision: "answer" }, { delta: text }, { done: true },
].map((event) => JSON.stringify(event)).join("\n"));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(respond: (call: { body: Record<string, unknown>; signal: AbortSignal }, index: number) => Response | Promise<Response> = waitResponse) {
  let time = 0;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const calls: Array<{ body: Record<string, unknown>; signal: AbortSignal }> = [];
  const controller = createLiveAssistController({
    now: () => time, id: () => `test-${++sequence}`,
    setTimer(callback, milliseconds) { const handle = ++sequence; timers.set(handle, { at: time + milliseconds, callback }); return handle; },
    clearTimer(handle) { timers.delete(handle as number); },
    fetcher: (async (_url, init) => {
      const call = { body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal };
      calls.push(call);
      return respond(call, calls.length);
    }) as typeof fetch,
  });
  let input: LiveAssistInput = { enabled: true, sessionId: "session-a", status: "recording", segments: [{ text: "이미 들은 수업 내용입니다." }], interim: "", locale: "ko", elapsedMs: 0 };
  controller.update(input);
  return {
    controller, calls,
    update(patch: Partial<LiveAssistInput>) { input = { ...input, ...patch }; controller.update(input); },
    async advance(milliseconds: number) {
      const target = time + milliseconds;
      let executions = 0;
      for (;;) {
        await flush();
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++executions < 200, "timers must not form an immediate retry storm");
        timers.delete(next[0]); time = next[1].at; next[1].callback();
      }
      time = target;
      await flush();
    },
  };
}

function controlledStream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }));
  return {
    response,
    send(event: unknown) { writer.enqueue(encoder.encode(JSON.stringify(event) + "\n")); },
    end() { writer.close(); },
  };
}

test("conversation keeps recent completed manual chat in order, within twelve messages and 6000 characters", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, text: `submitted ${index}` }));
  const conversation = buildLiveConversation([
    ...messages,
    { role: "assistant", text: "automatic output", kind: "live-assist" },
    { role: "assistant", text: "unfinished manual answer", pending: true },
    { role: "user", text: "   " },
    { role: "assistant", text: "finished manual answer", pending: false },
  ]);
  assert.equal(conversation.length, 12);
  assert.deepEqual(conversation[0], { role: "user", content: "submitted 9" });
  assert.deepEqual(conversation.at(-1), { role: "assistant", content: "finished manual answer" });
  assert.doesNotMatch(JSON.stringify(conversation), /automatic output|unfinished manual answer/);
  const bounded = buildLiveConversation([
    { role: "user", text: "old material " + "x".repeat(7_000) },
    { role: "assistant", text: "y".repeat(4_000) },
  ]);
  assert.equal(bounded.reduce((total, message) => total + message.content.length, 0), 6_000);
  assert.equal(bounded[0].content, "x".repeat(2_000));
  assert.equal(bounded[1].content, "y".repeat(4_000));
});

test("material revision is stable across ordering and excludes other sessions", () => {
  const documents = [
    { id: "b", session_id: "session-a", created_at: "2026-09-10T02:00:00Z" },
    { id: "a", session_id: "session-a", created_at: "2026-09-10T01:00:00Z" },
    { id: "foreign", session_id: "session-b", created_at: "2026-09-10T03:00:00Z" },
  ];
  const revision = buildLiveMaterialRevision(documents, "session-a");
  assert.equal(revision, buildLiveMaterialRevision([...documents].reverse(), "session-a"));
  assert.doesNotMatch(revision, /foreign/);
  assert.notEqual(revision, buildLiveMaterialRevision(documents.slice(1), "session-a"));
  assert.notEqual(revision, buildLiveMaterialRevision(documents.map((document) => ({ ...document, created_at: "changed" })), "session-a"));
  assert.equal(buildLiveMaterialRevision(documents, null), "[]");
});

test("requests bound conversation even when a controller caller supplies an oversized history", async () => {
  const h = harness();
  const conversation = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `${index}:` + "x".repeat(600) }));
  h.update({ conversation, materialRevision: "client-only-revision", interim: "첨부 자료의 가정을 설명해줘." });
  await h.advance(600);
  const sent = h.calls[0].body.conversation as Array<{ role: string; content: string }>;
  assert.ok(sent.length <= 12);
  assert.equal(sent.reduce((total, message) => total + message.content.length, 0), 6_000);
  assert.ok(sent.at(-1)!.content.startsWith("19:"));
  assert.equal(h.calls[0].body.materialRevision, undefined, "the server loads owned material independently");
  h.controller.dispose();
});

test("idle context changes do not consume the settle delay of later speech", async () => {
  const h = harness(() => answerResponse());
  h.update({ materialRevision: "pdf-added-before-any-speech" });
  await h.advance(3_000);
  h.update({ interim: "왜요?" });
  await h.advance(599);
  assert.equal(h.calls.length, 0);
  await h.advance(1);
  assert.equal(h.calls.length, 1);
  h.update({ conversation: [{ role: "user", content: "다음 질문의 배경 정보입니다." }] });
  await h.advance(3_000);
  h.update({ interim: "왜요? 예시는?" });
  await h.advance(599);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("a WAIT is reconsidered once per changed conversation or material revision without more speech", async () => {
  const h = harness();
  h.update({ interim: "그 자료의 결론을 알려줘." });
  await h.advance(600);
  const conversation = [{ role: "user" as const, content: "이 자료는 신규 고객 만족도 조사입니다." }];
  h.update({ conversation });
  await h.advance(1_499);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body.conversation, conversation);
  h.update({ conversation: conversation.map((message) => ({ ...message })), elapsedMs: 5_000 });
  await h.advance(10_000);
  assert.equal(h.calls.length, 2, "equal content and elapsed time do not poll WAIT");
  h.update({ materialRevision: "new-visible-pdf" });
  await h.advance(599);
  assert.equal(h.calls.length, 2);
  await h.advance(1);
  assert.equal(h.calls.length, 3);
  await h.advance(60_000);
  assert.equal(h.calls.length, 3);
  h.controller.dispose();
});

test("context changes during an in-flight WAIT are coalesced into its latest context", async () => {
  let resolve!: (response: Response) => void;
  const h = harness((_call, index) => index === 1 ? new Promise<Response>((done) => { resolve = done; }) : waitResponse());
  h.update({ interim: "어떤 조건을 적용해야 하나요?" });
  await h.advance(600);
  h.update({ conversation: [{ role: "user", content: "첫 번째 조건" }] });
  await h.advance(500);
  h.update({ conversation: [{ role: "user", content: "수정한 최종 조건" }], materialRevision: "uploaded" });
  await h.advance(3_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].signal.aborted, false);
  resolve(waitResponse());
  await h.advance(0);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body.conversation, [{ role: "user", content: "수정한 최종 조건" }]);
  await h.advance(60_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("streamed live answers do not become conversation or trigger their own follow-up", async () => {
  const stream = controlledStream();
  const h = harness((_call, index) => index === 1 ? stream.response : waitResponse());
  const manual = { role: "user" as const, text: "사례는 작은 카페라고 가정해줘." };
  h.update({ conversation: buildLiveConversation([manual]), interim: "기회비용 사례를 알려줘." });
  await h.advance(600);
  stream.send({ decision: "answer" });
  for (const text of ["카페를", "카페를 운영할 때", "카페를 운영할 때 포기한 임금입니다."]) {
    stream.send({ delta: text });
    h.update({ conversation: buildLiveConversation([manual, { role: "assistant", text, pending: true, kind: "live-assist" }]) });
    await h.advance(200);
  }
  stream.send({ done: true }); stream.end();
  h.update({ conversation: buildLiveConversation([manual, { role: "assistant", text: "완성된 자동 답변", kind: "live-assist" }]) });
  await h.advance(10_000);
  assert.equal(h.calls.length, 1);
  h.update({ materialRevision: "context-changed-after-answer" });
  await h.advance(10_000);
  assert.equal(h.calls.length, 1, "context alone must not replay an already answered turn");
  h.update({ interim: "이어서 매몰비용도" });
  await h.advance(600);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].body.conversation, [{ role: "user", content: manual.text }]);
  h.update({ conversation: buildLiveConversation([manual, { role: "assistant", text: "완성된 자동 답변", kind: "live-assist" }]) });
  await h.advance(60_000);
  assert.equal(h.calls.length, 2, "round-tripping the own answer cannot invalidate a later WAIT either");
  h.controller.dispose();
});

test("manual questions defer automatic calls and preserve speech and completed context accumulated while pending", async () => {
  const h = harness();
  h.update({ interim: "자동으로 확인할 질문입니다." });
  await h.advance(300);
  h.update({ manualQuestionPending: true });
  await h.advance(5_000);
  assert.equal(h.calls.length, 0, "a manual question takes priority over a scheduled request");
  h.update({ interim: "수동 답변을 기다리는 동안 나온 최신 질문입니다.", conversation: [{ role: "user", content: "나는 개발 경력 3년이야." }] });
  await h.advance(5_000);
  assert.equal(h.calls.length, 0);
  const completed = [{ role: "user" as const, content: "나는 개발 경력 3년이야." }, { role: "assistant" as const, content: "그 경력을 기준으로 예시를 들게요." }];
  h.update({ manualQuestionPending: false, conversation: completed });
  await h.advance(600);
  assert.equal(h.calls.length, 1);
  assert.match(String(h.calls[0].body.transcript), /최신 질문/);
  assert.deepEqual(h.calls[0].body.conversation, completed);
  h.update({ manualQuestionPending: true, conversation: [...completed, { role: "user", content: "이직을 준비 중이야." }] });
  await h.advance(5_000);
  assert.equal(h.calls.length, 1);
  h.update({ manualQuestionPending: false });
  await h.advance(0);
  assert.equal(h.calls.length, 2, "ending manual work also releases a deferred WAIT context change without new speech");
  await h.advance(60_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("manual priority preserves an active automatic stream and defers its next speech request", async () => {
  const stream = controlledStream();
  const h = harness((_call, index) => index === 1 ? stream.response : waitResponse());
  h.update({ interim: "처음 자동으로 답변할 질문입니다." });
  await h.advance(600);
  stream.send({ decision: "answer" }); stream.send({ delta: "이미 보여 준 답변" });
  await flush();
  h.update({ manualQuestionPending: true, interim: "다음 발화를 처리해 주세요." });
  assert.equal(h.calls[0].signal.aborted, false);
  stream.send({ delta: "의 나머지" }); stream.send({ done: true }); stream.end();
  await h.advance(5_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().answers[0].text, "이미 보여 준 답변의 나머지");
  assert.equal(h.controller.getSnapshot().answers[0].pending, false);
  h.update({ manualQuestionPending: false });
  await h.advance(0);
  assert.equal(h.calls.length, 2);
  assert.match(String(h.calls[1].body.transcript), /다음 발화/);
  h.controller.dispose();
});

test("session changes and reenabling consume context baselines without leaking an old WAIT", async () => {
  const h = harness();
  h.update({ interim: "이전 세션 질문입니다.", conversation: [{ role: "user", content: "OLD SESSION CONTEXT" }] });
  await h.advance(600);
  h.update({ conversation: [{ role: "user", content: "OLD QUEUED CONTEXT" }], materialRevision: "old-pdf" });
  h.update({ sessionId: "session-b", segments: [{ text: "새 세션 기본 발화" }], interim: "", conversation: [], materialRevision: "" });
  h.update({ conversation: [{ role: "user", content: "새 세션의 문맥" }] });
  await h.advance(10_000);
  assert.equal(h.calls.length, 1);
  h.update({ interim: "이제 새 질문을 할게요." });
  await h.advance(600);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].body.lectureSessionId, "session-b");
  assert.doesNotMatch(JSON.stringify(h.calls[1].body), /OLD/);
  h.update({ enabled: false, materialRevision: "new-pdf" });
  h.update({ enabled: true });
  h.update({ conversation: [{ role: "user", content: "꺼진 동안 바뀐 문맥" }] });
  await h.advance(10_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("enabling consumes the existing transcript baseline and only new speech schedules a request", async () => {
  const h = harness();
  await h.advance(5_000);
  assert.equal(h.calls.length, 0);
  h.update({ interim: "현재가치는 미래 현금흐름을 할인한 금액입니다." });
  await h.advance(599);
  assert.equal(h.calls.length, 0);
  await h.advance(1);
  assert.equal(h.calls.length, 1);
  assert.match(String(h.calls[0].body.transcript), /현재가치/);
  await h.advance(10_000);
  assert.equal(h.calls.length, 1, "unchanged text must never be polled");
  h.controller.dispose();
});

test("short complete Korean and English questions do not wait for another sentence", async () => {
  for (const question of ["왜요?", "왜?", "예시는?", "Why?", "Why"]) {
    const h = harness();
    h.update({ interim: question });
    await h.advance(600);
    assert.equal(h.calls.length, 1, question);
    h.controller.dispose();
  }
});

test("short requests in different languages reach the server without a question mark", async () => {
  for (const request of ["설명해줘.", "Explain.", "Explica.", "説明して。"]) {
    const h = harness(() => answerResponse("A response to the short request."));
    h.update({ interim: request });
    await h.advance(600);
    assert.equal(h.calls.length, 1, request);
    assert.ok(String(h.calls[0].body.transcript).endsWith(request));
    assert.equal(h.controller.getSnapshot().answers.length, 1, request);
    h.update({ segments: [{ text: "이미 들은 수업 내용입니다." }, { text: request }], interim: "" });
    await h.advance(60_000);
    assert.equal(h.calls.length, 1, "finalization and silence must not poll unchanged text");
    h.controller.dispose();
  }
});

test("a short completion after an interim WAIT is reconsidered without repeating the question", async () => {
  const h = harness((_call, index) => index === 1 ? waitResponse() : answerResponse("현재가치는 미래 금액을 오늘의 가치로 바꾼 금액입니다."));
  h.update({ interim: "현재가치가 무엇인지" });
  await h.advance(600);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().answers.length, 0);
  h.update({ interim: "현재가치가 무엇인지 설명해줘." });
  await h.advance(1_499);
  assert.equal(h.calls.length, 1, "the existing request cadence still applies");
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.match(String(h.calls[1].body.transcript), /현재가치가 무엇인지 설명해줘\.$/u);
  assert.equal(h.controller.getSnapshot().answers.length, 1);
  h.update({ segments: [{ text: "이미 들은 수업 내용입니다." }, { text: "현재가치가 무엇인지 설명해줘." }], interim: "" });
  await h.advance(60_000);
  assert.equal(h.calls.length, 2, "the answered final transcript must not be polled");
  h.controller.dispose();
});

test("finalization, punctuation and a briefly duplicated interim do not trigger duplicate work", async () => {
  const h = harness();
  const speech = "기회비용은 포기한 대안의 가치입니다";
  h.update({ interim: speech });
  await h.advance(600);
  h.update({ segments: [{ text: "이미 들은 수업 내용입니다." }, { text: speech + "." }], interim: speech });
  await h.advance(3_000);
  h.update({ interim: "" });
  await h.advance(3_000);
  assert.equal(h.calls.length, 1);
  h.update({ interim: "다음으로 매몰비용을 생각해 봅시다." });
  await h.advance(600);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("active generation queues only the latest transcript and respects start cadence", async () => {
  const stream = controlledStream();
  const h = harness((_call, index) => index === 1 ? stream.response : waitResponse());
  h.update({ interim: "처음 들은 새로운 개념을 설명합니다." });
  await h.advance(600);
  stream.send({ decision: "answer" }); stream.send({ delta: "설명 중" });
  await flush();
  h.update({ interim: "중간에 들어온 다른 새로운 발화입니다." });
  await h.advance(300);
  h.update({ interim: "가장 최신 발화만 다음 요청에 들어갑니다." });
  await h.advance(400);
  assert.equal(h.calls.length, 1);
  stream.send({ done: true }); stream.end();
  await h.advance(799);
  assert.equal(h.calls.length, 1, "a second request cannot start within 1500ms of the first");
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.match(String(h.calls[1].body.transcript), /가장 최신 발화/);
  assert.doesNotMatch(String(h.calls[1].body.transcript), /중간에 들어온/);
  await h.advance(5_000);
  assert.equal(h.calls.length, 2);
  h.controller.dispose();
});

test("continuous interim updates cannot postpone meaningful work indefinitely", async () => {
  const h = harness();
  for (let index = 0; index < 26; index++) {
    h.update({ interim: "이 문장은 계속 이어지는 설명입니다 " + "새로운 단어 ".repeat(index + 1) });
    await h.advance(100);
  }
  assert.equal(h.calls.length, 1);
  h.controller.dispose();
});

test("turning off and switching sessions aborts and rejects late old responses", async () => {
  let resolve!: (response: Response) => void;
  const h = harness(() => new Promise<Response>((done) => { resolve = done; }));
  h.update({ interim: "처음 요청하는 새로운 발화입니다." });
  await h.advance(600);
  h.update({ enabled: false });
  assert.equal(h.calls[0].signal.aborted, true);
  h.update({ sessionId: "session-b", enabled: true, segments: [{ text: "다른 수업에서 이미 저장한 말입니다." }], interim: "" });
  resolve(answerResponse("OLD SESSION MUST NOT LAND"));
  await h.advance(10_000);
  assert.deepEqual(h.controller.getSnapshot().answers, []);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.controller.dispose();
});

test("pause stops new calls while an already streaming answer can finish", async () => {
  const stream = controlledStream();
  const h = harness(() => stream.response);
  h.update({ interim: "지금 답변할 수 있는 새 발화입니다." });
  await h.advance(600);
  stream.send({ decision: "answer" }); stream.send({ delta: "계속 설명합니다." });
  await flush();
  h.update({ status: "paused" });
  assert.equal(h.calls[0].signal.aborted, false);
  stream.send({ done: true }); stream.end();
  await h.advance(5_000);
  assert.equal(h.calls.length, 1);
  assert.equal(h.controller.getSnapshot().answers[0].pending, false);
  assert.equal(h.controller.getSnapshot().phase, "off");
  h.controller.dispose();
});

test("429 honors Retry-After even when fresher speech arrives during backoff", async () => {
  const h = harness((_call, index) => index === 1
    ? new Response('{"error":"Slow down"}', { status: 429, headers: { "Retry-After": "10" } }) : waitResponse());
  h.update({ interim: "처음 요청하려는 새 발화입니다." });
  await h.advance(600);
  await h.advance(2_000);
  h.update({ interim: "백오프 중에 바뀐 가장 최신 내용입니다." });
  await h.advance(7_999);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  assert.match(String(h.calls[1].body.transcript), /가장 최신 내용/);
  h.controller.dispose();
});

test("permanent failures require retry and new speech alone cannot restart requests", async () => {
  for (const status of [401, 402, 403]) {
    const h = harness((_call, index) => index === 1 ? new Response('{"error":"Access unavailable"}', { status }) : waitResponse());
    h.update({ interim: "접근 권한을 확인할 새로운 말입니다." });
    await h.advance(600);
    h.update({ interim: "계속 새로운 말이 들어와도 재시도하지 않습니다." });
    await h.advance(30_000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.controller.getSnapshot().phase, "error");
    h.controller.retry();
    await h.advance(0);
    assert.equal(h.calls.length, 2);
    h.controller.dispose();
  }
});

test("transient failures back off and stop unchanged-text requests after three automatic retries", async () => {
  const h = harness(() => { throw new TypeError("Network unavailable"); });
  h.update({ interim: "네트워크 오류를 확인할 새 발화입니다." });
  await h.advance(60_000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.controller.getSnapshot().phase, "error");
  await h.advance(60_000);
  assert.equal(h.calls.length, 4);
  h.controller.dispose();
});

test("new speech recovers from a partial transient error without overwriting the old card", async () => {
  const stream = controlledStream();
  const h = harness((_call, index) => index === 1 ? stream.response : answerResponse("새 주제의 완성된 답변"));
  h.update({ interim: "첫 번째 주제에 대한 발화입니다." });
  await h.advance(600);
  stream.send({ decision: "answer" }); stream.send({ delta: "이전의 미완성 답변" }); stream.send({ error: "Temporary provider failure" });
  await h.advance(2_000);
  const oldId = h.controller.getSnapshot().answers[0].id;
  h.update({ interim: "완전히 새로운 주제에 대해 물어봅니다." });
  await h.advance(600);
  const answers = h.controller.getSnapshot().answers;
  assert.equal(h.calls.length, 2);
  assert.equal(answers.length, 2);
  assert.equal(answers[0].id, oldId);
  assert.equal(answers[0].text, "이전의 미완성 답변");
  assert.notEqual(answers[1].id, oldId);
  assert.equal(answers[1].text, "새 주제의 완성된 답변");
  assert.deepEqual(h.calls[1].body.previousAnswers, []);
  h.controller.dispose();
});

test("toggling off then on clears transient blocking without replaying the old transcript", async () => {
  const h = harness((_call, index) => index <= 4 ? Promise.reject(new Error("Offline")) : waitResponse());
  h.update({ interim: "처음부터 새롭게 들은 수업 내용입니다." });
  await h.advance(20_000);
  assert.equal(h.controller.getSnapshot().phase, "error");
  h.update({ enabled: false });
  h.update({ enabled: true });
  await h.advance(5_000);
  assert.equal(h.calls.length, 4);
  assert.equal(h.controller.getSnapshot().phase, "listening");
  h.update({ interim: "모드를 다시 켠 뒤 새로운 발화입니다." });
  await h.advance(600);
  assert.equal(h.calls.length, 5);
  h.controller.dispose();
});

test("a partial stream failure is explicitly retried into the same card", async () => {
  const stream = controlledStream();
  const h = harness((_call, index) => index === 1 ? stream.response : answerResponse("완성된 실시간 답변입니다."));
  h.update({ interim: "실시간 답변을 생성할 새 내용입니다." });
  await h.advance(600);
  stream.send({ decision: "answer" }); stream.send({ delta: "미완성 답변" }); stream.send({ error: "Provider interrupted" });
  await h.advance(30_000);
  const before = h.controller.getSnapshot().answers[0];
  assert.equal(before.pending, false);
  assert.equal(h.calls.length, 1, "partial answers must not be duplicated by automatic retries");
  h.controller.retry();
  await h.advance(0);
  const after = h.controller.getSnapshot().answers;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before.id);
  assert.equal(after[0].text, "완성된 실시간 답변입니다.");
  assert.deepEqual(h.calls[1].body.previousAnswers, [], "a failed fragment is not successful answer history");
  h.controller.dispose();
});

test("answers and history stay bounded and every answer carries its session", async () => {
  const h = harness(() => answerResponse("답변 ".repeat(600)));
  for (let index = 0; index < 22; index++) {
    h.update({ interim: `새로운 주제 ${index}에 대해 충분히 설명하고 있습니다.` });
    await h.advance(2_000);
  }
  const answers = h.controller.getSnapshot().answers;
  assert.equal(answers.length, 20);
  assert.ok(answers.every((answer) => answer.sessionId === "session-a" && answer.id.startsWith("live-assist:") && !answer.pending));
  const previous = h.calls.at(-1)!.body.previousAnswers as Array<{ prompt: string; answer: string }>;
  assert.equal(previous.length, 6);
  assert.ok(previous.every((answer) => answer.prompt.length <= 500 && answer.answer.length <= 1_500));
  h.update({ enabled: false });
  assert.equal(h.controller.getSnapshot().answers.length, 20);
  h.controller.dispose();
});

test("transcript windows remove rollover overlap and novel speech survives a sliding context", () => {
  assert.equal(buildLiveTranscript([{ text: "먼저 마무리한 문장입니다." }], "먼저 마무리한 문장입니다. 다음 발화입니다."), "먼저 마무리한 문장입니다.\n다음 발화입니다.");
  const text = buildLiveTranscript(Array.from({ length: 100 }, (_, index) => ({ text: `${index}번 문장입니다. `.repeat(20) })), "가장 최근의 발화");
  assert.ok(text.length <= 6_000);
  assert.ok(text.endsWith("가장 최근의 발화"));
  assert.equal(novelSpeech("오래된부분새로운기회비용", "새로운기회비용그리고매몰비용"), "그리고매몰비용");
  assert.equal(novelSpeech("이미 완성한 문장입니다", "이미 완성한 문장입니다."), "");
  assert.notEqual(speechKey("금리는 3%"), speechKey("금리는 3"), "math symbols remain meaningful");
});

test("NDJSON handles every UTF-8 byte boundary, CRLF and an unterminated final line", async () => {
  const bytes = encoder.encode('\r\n{"decision":"answer"}\r\n{"delta":"한글 답변 🧠"}\n{"done":true}');
  const events: unknown[] = [];
  await readLiveAssistStream(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), (event) => events.push(event));
  assert.deepEqual(events, [{ decision: "answer" }, { delta: "한글 답변 🧠" }, { done: true }]);
});

test("NDJSON rejects malformed, truncated and error streams", async () => {
  for (const text of ['{"decision":"answer"}\n{"delta":"partial"}', '{bad json}\n', '{"error":"Unavailable"}\n']) {
    await assert.rejects(readLiveAssistStream(new Response(text).body!, () => {}));
  }
  await readLiveAssistStream(waitResponse().body!, () => {});
});

test("Retry-After supports dates, seconds and bounded invalid fallbacks", () => {
  assert.equal(parseRetryAfter("10", 0), 10_000);
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:00:10 GMT", 0), 10_000);
  assert.equal(parseRetryAfter("0", 0), 1_000);
  assert.equal(parseRetryAfter(null, 0), 3_000);
  assert.equal(parseRetryAfter("9999999999999999", 0), 3_600_000);
});
