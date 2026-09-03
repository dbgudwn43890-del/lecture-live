import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

// --- Supabase stub: enough of the query builder for the paths this route
// exercises (credit rpc, transcript_segments pagination, lecture_questions
// insert). Modeled on app/api/billing/webhook/route.test.ts's Call ledger.
let authUser: { id: string } | null = { id: USER_ID };
let transcriptRows: Array<{ session_id: string; client_id: string; start_ms: number; end_ms: number; text: string }> = [];
let insertedQuestions: Array<Record<string, unknown>> = [];
let rangeCalls: Array<{ table: string; from: number; to: number }> = [];
let canAsk = true;
let conceptRows: Array<{ name: string; definition: string; evidence_ms: number | null; related: string[] }> = [];

function queryBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  const builder = {
    select() { return builder; },
    eq(column: string, value: unknown) { filters[column] = value; return builder; },
    order() { return builder; },
    // fetchRecentQuestions·fetchConceptCards가 쓰는 종단.
    limit() {
      return Promise.resolve({ data: table === "lecture_concepts" ? conceptRows : [], error: null });
    },
    range(from: number, to: number) {
      rangeCalls.push({ table, from, to });
      if (table !== "transcript_segments") return Promise.resolve({ data: [], error: null });
      const rows = transcriptRows.filter((row) => row.session_id === filters.session_id);
      return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
    },
    insert(payload: unknown) {
      if (table === "lecture_questions") insertedQuestions.push(payload as Record<string, unknown>);
      return Promise.resolve({ data: null, error: null });
    },
  };
  return builder;
}

const supabaseStub = {
  auth: { getUser: async () => ({ data: { user: authUser } }) },
  rpc: async (name: string) => {
    if (name === "can_ask_with_credits") return { data: canAsk, error: null };
    return { data: null, error: null };
  },
  from: (table: string) => queryBuilder(table),
};

mock.module(pathToFileURL("app/lib/supabase/server.ts").href, {
  namedExports: { createClient: async () => supabaseStub },
});
mock.module(pathToFileURL("app/lib/supabase/admin.ts").href, {
  namedExports: { createAdminClient: () => null },
});

// --- OpenAI stub: the route imports the "openai" package for its default
// (platform-key) answer path and drives it with `stream: true`.
let openAiEvents: unknown[] = [];
let openAiShouldThrow = false;
const openAiCreateCalls: Array<Record<string, unknown>> = [];

class FakeOpenAI {
  constructor(_options: unknown) {}
  beta = {
    responses: {
      create: async (params: Record<string, unknown>) => {
        openAiCreateCalls.push(params);
        if (openAiShouldThrow) throw Object.assign(new Error("boom"), { status: 500 });
        return openAiEvents;
      },
    },
  };
  embeddings = { create: async () => ({ data: [{ embedding: [] }] }) };
}

mock.module("openai", { defaultExport: FakeOpenAI });

// The route imports its siblings the way a bundler resolves them — no file
// extension. Node needs one, so retry with the extensions the repo uses.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); } catch { /* try the next one */ }
      }
      throw error;
    }
  },
});

process.env.OPENAI_API_KEY = "sk-test";

const { POST } = await import("./route.ts");

test.beforeEach(() => {
  authUser = { id: USER_ID };
  transcriptRows = [];
  insertedQuestions = [];
  rangeCalls = [];
  canAsk = true;
  conceptRows = [];
  openAiEvents = [];
  openAiShouldThrow = false;
  openAiCreateCalls.length = 0;
});

function ask(body: Record<string, unknown>) {
  return POST(new Request("https://lecue.test/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

async function readNdjson(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function seedTranscript(sessionId: string, count: number) {
  for (let i = 0; i < count; i += 1) {
    transcriptRows.push({
      session_id: sessionId,
      client_id: `db-${i}`,
      start_ms: i * 1_000,
      end_ms: i * 1_000 + 900,
      text: `segment ${i}`,
    });
  }
}

test("paginates past 1000 stored rows and merges in the unconfirmed tail, sorted by time", async () => {
  seedTranscript(SESSION_ID, 1_200);
  openAiEvents = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { output: [], usage: null } },
  ];

  const response = await ask({
    question: "What did we just cover?",
    questionAtMs: 1_205_000,
    segments: [{ id: "unconfirmed-1", startMs: 1_201_000, endMs: 1_201_500, text: "brand new" }],
    lectureSessionId: SESSION_ID,
  });
  await readNdjson(response);

  const transcriptRangeCalls = rangeCalls.filter((call) => call.table === "transcript_segments");
  assert.equal(transcriptRangeCalls.length, 2, "1200 rows needs two 1000-row pages");

  const input = openAiCreateCalls[0].input as string;
  assert.ok(input.includes("segment 1199"));
  assert.ok(input.includes("brand new"));
  assert.ok(input.indexOf("segment 1199") < input.indexOf("brand new"), "later segments must sort after earlier ones");
});

test("does not re-send a segment the client has already confirmed as duplicate text", async () => {
  seedTranscript(SESSION_ID, 3);
  openAiEvents = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { output: [], usage: null } },
  ];

  const response = await ask({
    question: "Recap?",
    questionAtMs: 5_000,
    // Same id as an already-stored row — the merge must not duplicate it.
    segments: [{ id: "db-1", startMs: 1_000, endMs: 1_900, text: "segment 1" }],
    lectureSessionId: SESSION_ID,
  });
  await readNdjson(response);

  const input = openAiCreateCalls[0].input as string;
  const lines = input.split("\n").filter((line) => line.endsWith("segment 1"));
  assert.equal(lines.length, 1, "the duplicate client id must collapse to a single transcript line");
});

test("a transcript over the 5000 segment cap drops its oldest lines instead of refusing", async () => {
  // The DB read alone is capped at 5000 (the infinite-loop guard), so the cap
  // is only exceedable once the unconfirmed tail adds a segment on top of it.
  // 예전엔 여기서 413 — 최대 길이 강의는 질문이 영원히 막혔다.
  seedTranscript(SESSION_ID, 5_000);
  openAiEvents = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { output: [], usage: null } },
  ];

  const response = await ask({
    question: "Still answerable?",
    questionAtMs: 5_002_000,
    segments: [{ id: "unconfirmed-over-cap", startMs: 5_001_000, endMs: 5_001_500, text: "one too many" }],
    lectureSessionId: SESSION_ID,
  });
  await readNdjson(response);

  assert.equal(response.status, 200);
  const input = openAiCreateCalls[0].input as string;
  assert.ok(input.includes("one too many"), "the newest tail stays");
  assert.ok(!input.includes("segment 0\n") && !input.includes("segment 0 "), "the oldest line is dropped to fit the cap");
});

test("streams deltas then a cleaned done line, and saves the cleaned answer", async () => {
  openAiEvents = [
    { type: "response.output_text.delta", delta: "**Hello** " },
    { type: "response.output_text.delta", delta: "world (https://example.com)." },
    {
      type: "response.completed",
      response: {
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: "unused",
                annotations: [{ type: "url_citation", title: "Example", url: "https://example.com/a?utm_source=openai" }],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 120,
          input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
          output_tokens: 40,
        },
      },
    },
  ];

  const response = await ask({
    question: "Summarize.",
    questionAtMs: 1_000,
    segments: [],
    lectureSessionId: SESSION_ID,
    classroomId: null,
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /x-ndjson/);

  const lines = await readNdjson(response);
  const deltaLines = lines.filter((line) => "delta" in line);
  const doneLine = lines.find((line) => "done" in line) as { done: { answer: string; sources: Array<{ url: string }> } } | undefined;

  assert.equal(deltaLines.map((line) => line.delta).join(""), "**Hello** world (https://example.com).");
  assert.ok(doneLine, "a done line must close the stream");
  assert.equal(doneLine!.done.answer, "Hello world.");
  assert.deepEqual(doneLine!.done.sources, [{ title: "Example", url: "https://example.com/a" }]);

  assert.equal(insertedQuestions.length, 1);
  assert.equal(insertedQuestions[0].answer, "Hello world.");
  assert.equal(insertedQuestions[0].session_id, SESSION_ID);
});

test("emits an error line and skips the lecture_questions save when the provider fails mid-stream", async () => {
  openAiShouldThrow = true;

  const response = await ask({
    question: "Will this fail?",
    questionAtMs: 1_000,
    segments: [],
    lectureSessionId: SESSION_ID,
  });

  assert.equal(response.status, 200, "headers are already committed once streaming starts");
  const lines = await readNdjson(response);
  assert.equal(lines.length, 1);
  assert.ok(typeof lines[0].error === "string" && lines[0].error.length > 0);
  assert.equal(insertedQuestions.length, 0);
});

test("concept cards from past notes are matched to the question and injected with 1-hop expansion", async () => {
  seedTranscript(SESSION_ID, 3);
  conceptRows = [
    { name: "듀레이션", definition: "채권 현금흐름의 가중평균 회수 기간.", evidence_ms: 1_260_000, related: ["만기수익률"] },
    { name: "만기수익률", definition: "채권을 만기까지 보유할 때의 연 수익률.", evidence_ms: null, related: [] },
    { name: "완전 무관 개념", definition: "질문과 아무 상관 없는 정의.", evidence_ms: null, related: [] },
  ];
  openAiEvents = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { output: [], usage: null } },
  ];

  const response = await ask({
    question: "듀레이션이 정확히 뭐야?",
    questionAtMs: 5_000,
    segments: [],
    lectureSessionId: SESSION_ID,
    classroomId: "33333333-3333-4333-8333-333333333333",
  });
  await readNdjson(response);

  const input = openAiCreateCalls[0].input as string;
  assert.ok(input.includes("이미 정리된 개념"), "the concept block header must be present");
  assert.ok(input.includes("듀레이션: 채권 현금흐름의"), "the matched card is injected");
  assert.ok(input.includes("(00:21)"), "the evidence clock rides along");
  assert.ok(input.includes("만기수익률:"), "the 1-hop related card comes too");
  assert.ok(!input.includes("완전 무관 개념"), "unrelated cards stay out");
});

test("catchup mode narrows the transcript to the last 90 seconds and turns the web search off", async () => {
  // 200초짜리 강의. 복구 요청은 마지막 90초만 보아야 한다.
  seedTranscript(SESSION_ID, 200);
  openAiEvents = [
    { type: "response.output_text.delta", delta: "ok" },
    { type: "response.completed", response: { output: [], usage: null } },
  ];

  const response = await ask({
    mode: "catchup",
    questionAtMs: 200_000,
    lectureSessionId: SESSION_ID,
  });
  await readNdjson(response);

  const call = openAiCreateCalls[0];
  const input = call.input as string;
  assert.ok(input.includes("segment 199"), "the newest speech has to be there");
  assert.ok(!input.includes("segment 100"), "anything older than the window must be dropped");
  assert.deepEqual(call.tools, [], "복구는 강의 안에서 답한다 — 검색 도구를 붙이지 않는다");
  assert.equal(call.tool_choice, "none");
  // 질문을 쓰지 않아도 접수되어야 한다.
  assert.equal(insertedQuestions.length, 1);
});
