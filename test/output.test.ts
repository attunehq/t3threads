import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createCli } from "../src/cli.js";
import { State } from "../src/state.js";
import { enqueueSend } from "../src/queue.js";
import { sendCommand } from "../src/threads.js";
import { addWatch, tick, type Watch, type WatchRuntime } from "../src/watchers.js";
import { fixture, json, message, thread } from "./fixture.js";

const cli = createCli();
async function read(path: string, options: Record<string, string | boolean> = {}, method = "GET") {
  if (Object.values(options).some(value => typeof value === "boolean")) method = "POST";
  const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
  const result = await (await cli.fetch(new Request(`http://cli/${path}?${query}`, method === "GET" ? {} : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(options) }))).json() as { ok: boolean; data: any };
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
}

test("compact reads preserve text, roles, attachments notice and pagination; details preserves raw metadata", async t => {
  const recent = { ...message("3", "Full text.\n".repeat(2000)), role: "user", attachments: [{ name: "design.png", type: "image", id: "attachment-id" }], turnId: "turn-id", streaming: false };
  const middle = { ...message("2", ""), role: "system", attachments: [] };
  const older = message("1", "Earlier decision");
  const f = await fixture(t, (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (!url.pathname.includes("/threads/")) return;
    const before = url.searchParams.get("beforeCursor");
    if (before) assert.equal(before, "opaque/+cursor");
    json(res, { snapshotSequence: 7, thread: { ...thread, messages: before ? [older, middle] : [middle, recent] }, page: { hasMore: !before, beforeCursor: before ? null : "opaque/+cursor" } });
    return true;
  });
  const options = { config: f.configPath };
  const compact = await read("read/t1", options);
  assert.deepEqual(compact.messages, [{ role: "system", text: "" }, { role: "user", text: recent.text, attachmentCount: 1 }]);
  assert.deepEqual(compact.page, { hasMore: true, beforeCursor: "opaque/+cursor" });
  assert.equal(compact.ref, "local:t1");
  assert.equal(compact.status, "idle");
  for (const field of ["id", "modelSelection", "session", "snapshotSequence"]) assert.equal(Object.hasOwn(compact, field), false);
  const detailed = await read("read/t1", { ...options, details: true });
  assert.deepEqual(detailed.messages, [middle, recent]);
  assert.deepEqual(detailed.modelSelection, thread.modelSelection);
  assert.equal(detailed.snapshotSequence, 7);
  assert.deepEqual(detailed.page, compact.page);
  const previous = await read("read/t1", { ...options, before: compact.page.beforeCursor });
  assert.deepEqual(previous.messages, [{ role: older.role, text: older.text }, { role: "system", text: "" }]);
  for (const details of [false, true]) {
    const all = await read("read/t1", { ...options, all: true, details }, "POST");
    assert.deepEqual(all.messages.map((m: { text: string }) => m.text), [older.text, middle.text, recent.text]);
    assert.deepEqual(all.page, { hasMore: false, beforeCursor: null });
  }
  const invalid = await (await cli.fetch(new Request("http://cli/read/t1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...options, all: true, before: "cursor" }) }))).json() as { ok: boolean; error: { code: string } };
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "INVALID_ARGUMENT");
  assert.deepEqual((await read("read/t1", { ...options, details: false })).messages, compact.messages);
});

test("compact discovery keeps worktree identity, attention flags and errors; details restores settings", async t => {
  const f = await fixture(t);
  Object.assign(f.stored.get("t1")!, { worktreePath: "/work/grace/review", hasPendingApprovals: true, hasPendingUserInput: false, hasActionableProposedPlan: true, backgroundLiveness: "monitoring", settledAt: "yesterday", session: { status: "error", activeTurnId: null, lastError: "Provider unavailable" } });
  const options = { config: f.configPath };
  const compact = await read("list", options);
  assert.equal(compact.complete, true);
  assert.deepEqual(compact.errors, []);
  const row = compact.results[0].threads[0];
  assert.equal(row.ref, "local:t1");
  assert.equal(row.project, "Grace Hopper");
  assert.equal(Object.hasOwn(row, "projectId"), false);
  assert.equal(row.worktreePath, "/work/grace/review");
  assert.equal(row.status, "error");
  assert.equal(row.error, "Provider unavailable");
  assert.equal(row.hasPendingApprovals, true);
  assert.equal(row.hasPendingUserInput, false);
  assert.equal(row.hasActionableProposedPlan, true);
  assert.equal(row.backgroundLiveness, "monitoring");
  assert.equal(row.settledAt, "yesterday");
  assert.equal(row.modelSelection, undefined);
  const detailed = (await read("list", { ...options, details: true })).results[0].threads[0];
  assert.deepEqual(detailed.modelSelection, thread.modelSelection);
  assert.equal(detailed.projectId, "p1");
  assert.equal(detailed.session.lastError, row.error);
  const overview = (await read("overview", { ...options, env: "local", includeSettled: true })).results[0].threads[0];
  assert.equal(overview.project, "Grace Hopper");
  assert.equal(Object.hasOwn(overview, "projectId"), false);
  assert.equal((await read("projects", options)).results[0].projects[0].defaultModelSelection, undefined);
  assert.deepEqual((await read("projects", { ...options, details: true })).results[0].projects, f.projects);
});

test("compact reads distinguish partial messages without adding flags to finished messages", async t => {
  const f = await fixture(t);
  const partial = { ...message("3", "I am checking"), streaming: true };
  f.stored.get("t1")!.messages = [message("1", "Task"), { ...message("2", "Earlier reply"), streaming: false }, partial];
  const compact = await read("read/t1", { config: f.configPath });
  assert.deepEqual(compact.messages, [
    { role: "assistant", text: "Task" },
    { role: "assistant", text: "Earlier reply" },
    { role: "assistant", text: partial.text, streaming: true },
  ]);
  const detailed = await read("read/t1", { config: f.configPath, details: true });
  assert.equal(detailed.messages[1].streaming, false);
  assert.deepEqual(detailed.messages[2], partial);
});

test("events-only watchers expose fired decisions without per-thread evidence", async t => {
  const f = await fixture(t);
  const prior = process.env.T3THREADS_STATE_DIR;
  process.env.T3THREADS_STATE_DIR = f.dir + "/state";
  t.after(() => { if (prior === undefined) delete process.env.T3THREADS_STATE_DIR; else process.env.T3THREADS_STATE_DIR = prior; });
  const state = new State();
  const decision = { matches: true, reason: "The review is complete", probability: 0.96 };
  const rt: WatchRuntime = {
    async observe(ref) { return { ref, thread }; },
    async evaluate() { return decision; },
    async deliver() { assert.fail("An events-only watcher must not send a notification"); },
  };
  const watch = await addWatch({ refs: ["local:t1"], condition: { kind: "jev", prompt: "Is the review complete?", threshold: 0.9 }, options: {}, modelEnv: "local", intervalSeconds: 5, expiresInHours: 1 }, state, rt);
  const active = (await read("watchers", { id: watch.id })).watchers[0];
  assert.equal(active.status, "active");
  assert.equal(Object.hasOwn(active, "decision"), false);
  await tick(state, rt);
  const triggered = (await read("watchers", { id: watch.id })).watchers[0];
  assert.equal(triggered.status, "triggered");
  assert.ok(triggered.firedAt);
  assert.deepEqual(triggered.decision, decision);
  assert.equal(Object.hasOwn(triggered, "evidence"), false);
  const full = (await read("watchers", { id: watch.id, details: true })).watchers[0];
  assert.deepEqual(full.evidence.decision, decision);
  assert.equal(full.evidence.threads[0].ref, "local:t1");
});

test("queue and watcher inspection omits stored payloads by default and retrieves one full record on demand", async t => {
  const f = await fixture(t);
  const prior = process.env.T3THREADS_STATE_DIR;
  process.env.T3THREADS_STATE_DIR = f.dir + "/state";
  t.after(() => { if (prior === undefined) delete process.env.T3THREADS_STATE_DIR; else process.env.T3THREADS_STATE_DIR = prior; });
  const state = new State();
  const first = enqueueSend({ ref: "local:t1", options: { config: f.configPath }, request: { caller: "local:grace", prompt: "Keep the entire prompt.\n".repeat(100), steer: false } }, state);
  const second = enqueueSend({ ref: "local:t2", options: {}, request: { externalCaller: "jessbot", prompt: "Another prompt", steer: true } }, state);
  const failed = { ...second, error: { environment: "local", code: "THREAD_INACTIVE", message: "Restore this thread." }, status: "failed" as const };
  state.put("message", failed.id, failed);
  const accepted = { ...first, command: sendCommand(thread, first.request!.prompt), status: "accepted" as const, acceptedAt: "today" };
  state.put("message", first.id, accepted);
  const rows = (await read("queued")).messages;
  assert.deepEqual(rows.map((r: { id: string }) => r.id), [first.id, second.id]);
  assert.equal(rows[0].caller, "local:grace");
  assert.equal(rows[0].acceptedAt, "today");
  assert.equal(rows[1].externalCaller, "jessbot");
  assert.equal(rows[1].delivery, "steer");
  assert.deepEqual(rows[1].error, failed.error);
  for (const row of rows) for (const field of ["request", "command", "options", "nextCheck", "messageId"]) assert.equal(Object.hasOwn(row, field), false);
  assert.deepEqual((await read("queued", { id: first.id, details: true })).messages, [JSON.parse(JSON.stringify(accepted))]);
  assert.deepEqual((await read("queued", { id: "unknown" })).messages, []);
  const pending = enqueueSend({ ref: "local:t1", options: {}, request: { caller: "local:grace", prompt: "Cancel me", steer: false } }, state);
  const cancelled = await (await cli.fetch(new Request(`http://cli/unqueue/${pending.id}`, { method: "POST" }))).json() as { data: any };
  assert.equal(cancelled.data.status, "cancelled");
  assert.equal(cancelled.data.request, undefined);
  assert.equal(state.get<typeof pending>("message", pending.id)?.request?.prompt, "Cancel me");

  const watch: Watch = { id: "watch-grace", refs: ["local:t1"], caller: "local:grace", condition: { kind: "all-completed" }, options: { config: f.configPath }, modelEnv: "local", status: "pending", createdAt: "today", expiresAt: 1000, intervalSeconds: 30, nextCheck: 0, baseline: "fingerprint", evidence: { matches: true, reason: "Detailed evidence" }, errors: [failed.error], command: accepted.command };
  state.put("watch", watch.id, watch);
  state.put("watch", "another", { ...watch, id: "another", caller: "local:ada" });
  const watches = (await read("watchers", { caller: watch.caller!, id: watch.id })).watchers;
  assert.equal(watches.length, 1);
  assert.deepEqual(watches[0].condition, watch.condition);
  assert.deepEqual(watches[0].errors, watch.errors);
  for (const field of ["evidence", "options", "baseline", "command"]) assert.equal(Object.hasOwn(watches[0], field), false);
  const full = (await read("watchers", { id: watch.id, details: true })).watchers[0];
  assert.deepEqual(full.evidence, watch.evidence);
  assert.equal(full.notificationCommandId, watch.command?.commandId);
  assert.deepEqual(full.options, watch.options);
  assert.deepEqual((await read("watchers", { caller: "local:ada", id: watch.id })).watchers, []);
  const stopped = await (await cli.fetch(new Request(`http://cli/unwatch/${watch.id}`, { method: "POST" }))).json() as { data: any };
  assert.equal(stopped.data.status, "cancelled");
  assert.equal(stopped.data.evidence, undefined);
  assert.deepEqual(state.get<Watch>("watch", watch.id)?.evidence, watch.evidence);
});

test("CLI JSON uses compact fields unless details is requested", async t => {
  const f = await fixture(t);
  for (const details of [false, true]) {
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/bin.ts", "read", "t1", "--config", f.configPath, "--json", ...(details ? ["--details"] : [])], { env: { ...process.env, T3THREADS_STATE_DIR: f.dir + "/state" } });
    const result = JSON.parse(stdout);
    assert.equal(result.messages[0].text, "hello");
    assert.equal(Object.hasOwn(result.messages[0], "id"), details);
    assert.equal(Object.hasOwn(result, "modelSelection"), details);
  }
});
