import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { mergeListedSession, patchListedSession } from "./classroom-session-list.ts";
import type { SessionSummary } from "../classroom/use-lecture-recorder.ts";

const original: SessionSummary = { id: "session", classroom_id: "a", title: "Before", status: "recording", started_at: "2026-09-11T00:00:00Z", ended_at: null, duration_seconds: 0, recorded_ms: 0, question_count: 3 };
function initial() { return { classrooms: [{ id: "a", sessions: [{ ...original }] }, { id: "b", sessions: [] as SessionSummary[] }], unassignedSessions: [] as SessionSummary[] }; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => { resolve = accept; }); return { promise, resolve }; }

test("a delayed rename preserves the completed status and duration supplied by onSessionSaved", async () => {
  let lists = initial();
  const renamed = deferred<void>();
  const pending = renamed.promise.then(() => { lists = patchListedSession(lists, original.id, { title: "Renamed" }); });
  lists = mergeListedSession(lists, { ...original, status: "completed", duration_seconds: 60, recorded_ms: 60000 });
  renamed.resolve(); await pending;
  assert.deepEqual(lists.classrooms[0].sessions[0], { ...original, title: "Renamed", status: "completed", duration_seconds: 60, recorded_ms: 60000 });
});

test("a delayed move preserves latest saved fields and question count while moving the row once", async () => {
  let lists = initial();
  const moved = deferred<void>();
  const pending = moved.promise.then(() => { lists = patchListedSession(lists, original.id, { classroom_id: "b" }); });
  const { question_count: _count, ...saved } = { ...original, status: "completed" as const, recorded_ms: 60000, duration_seconds: 60 };
  lists = mergeListedSession(lists, saved);
  moved.resolve(); await pending;
  assert.equal(lists.classrooms[0].sessions.length, 0);
  assert.deepEqual(lists.classrooms[1].sessions, [{ ...saved, classroom_id: "b", question_count: 3 }]);
  assert.equal(lists.unassignedSessions.length, 0);
});

test("move to unassigned retains current title and does not resurrect a deleted row", () => {
  let lists = patchListedSession(initial(), original.id, { title: "Current" });
  lists = patchListedSession(lists, original.id, { classroom_id: null });
  assert.equal(lists.classrooms.flatMap(group => group.sessions).length, 0);
  assert.equal(lists.unassignedSessions[0].title, "Current");
  const deleted = { ...lists, unassignedSessions: [] };
  assert.equal(patchListedSession(deleted, original.id, { title: "Late" }), deleted);
});

// Exercise the actual workspace loader, including its catch path, without a
// synthetic React/Next/browser environment or copying the implementation.
function loader() {
  const source = readFileSync(new URL("../classroom/workspace-client.tsx", import.meta.url), "utf8");
  const start = source.indexOf("  async function loadClassrooms(");
  const code = stripTypeScriptTypes(source.slice(start, source.indexOf("  async function createClassroom(", start)));
  const revision = { current: 0 }, requestId = { current: 0 };
  const requests: Array<ReturnType<typeof deferred<Response>>> = [];
  const errors: string[] = [], results: unknown[] = [];
  const load = new Function("fetch", "locale", "classroomRevisionRef", "classroomLoadRef", "setClassroomLists", "setProfile", "setActiveClassroomId", "initialRouteRef", "openSession", "setError", "isEnglish", `${code};return loadClassrooms`)(
    () => { const request = deferred<Response>(); requests.push(request); return request.promise; }, "en", revision, requestId,
    (value: unknown) => results.push(value), () => {}, () => {}, { current: true }, () => {}, (value: string) => errors.push(value), true,
  ) as () => Promise<void>;
  return { load, requests, revision, errors, results };
}

test("a stale classroom GET failure cannot replace the notice after a successful local mutation", async () => {
  const f = loader();
  const pending = f.load();
  f.revision.current++;
  f.requests[0].resolve(Response.json({ error: "Outdated failure" }, { status: 503 }));
  await pending;
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.results, []);
});

test("a later classroom GET wins and an older failure remains invisible", async () => {
  const f = loader();
  const older = f.load(), newer = f.load();
  f.requests[1].resolve(Response.json({ classrooms: [{ id: "fresh", sessions: [] }], unassignedSessions: [] }));
  await newer;
  f.requests[0].resolve(Response.json({ error: "Stale" }, { status: 503 }));
  await older;
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.results, [{ classrooms: [{ id: "fresh", sessions: [] }], unassignedSessions: [] }]);
});

test("the current classroom GET failure still reports its error", async () => {
  const f = loader();
  const pending = f.load();
  f.requests[0].resolve(Response.json({ error: "Current failure" }, { status: 503 }));
  await pending;
  assert.deepEqual(f.errors, ["Current failure"]);
});
