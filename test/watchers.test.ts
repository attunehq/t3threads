import { test } from "node:test";
import assert from "node:assert/strict";
import { addWatch, cancelWatch, deterministic, tick, runtime, type Observation, type Watch, type WatchRuntime } from "../src/watchers.js";
import { State } from "../src/state.js";
import { sendCommand } from "../src/threads.js";
import { fixture, thread } from "./fixture.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

test("all-completed requires successful finished turns, not idle, failed, missing, or running threads", () => {
  const done: Observation = { ref: "local:t1", thread: { ...thread, latestTurn: { state: "completed" } } };
  const condition = { kind: "all-completed" as const };
  assert.equal(deterministic(condition, [done], ""), true);
  for (const state of ["running", "error", "interrupted"]) assert.equal(deterministic(condition, [{ ...done, thread: { ...thread, latestTurn: { state } } }], ""), false);
  assert.equal(deterministic(condition, [{ ...done, thread }], ""), false);
  assert.equal(deterministic(condition, [], ""), false);
  assert.equal(deterministic(condition, [{ ...done, thread: { ...done.thread, session: { status: "running", activeTurnId: "turn", lastError: null } } }], ""), false);
});

test("watch survives restarts, treats unavailable threads as unknown, queues for a busy caller, and fires once", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  let offline = false, callerBusy = true, deliveries = 0;
  const rt: WatchRuntime = {
    async observe(ref) { if (offline && ref === "remote:t2") throw Error("offline"); return { ref, thread: { ...thread, latestTurn: { state: "completed" } } }; },
    async evaluate(observations, watch) { return { matches: deterministic(watch.condition, observations, watch.baseline) }; },
    async deliver(watch, save) { if (callerBusy) return "busy"; deliveries++; save(sendCommand(thread, "notification")); return "delivered"; },
  };
  const w = await addWatch({ refs: ["local:t1", "remote:t2"], caller: "local:caller", condition: { kind: "all-completed" }, options: {}, modelEnv: "local", intervalSeconds: 5, expiresInHours: 1 }, state, rt);
  offline = true;
  await tick(state, rt, 1000);
  assert.equal(state.get<Watch>("watch", w.id)?.status, "active");
  assert.equal(state.get<Watch>("watch", w.id)?.errors?.length, 1);
  offline = false;
  await tick(new State(state.directory), rt, 7000);
  assert.equal(state.get<Watch>("watch", w.id)?.status, "pending");
  callerBusy = false;
  await tick(new State(state.directory), rt, 13000);
  assert.equal(state.get<Watch>("watch", w.id)?.status, "delivered");
  await tick(state, rt, 19000); assert.equal(deliveries, 1);
});

test("pending notification persists its command ID before a lost receipt; retries reuse it", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const ids: string[] = [];
  const rt: WatchRuntime = {
    async observe(ref) { return { ref, thread }; },
    async evaluate() { return { matches: true }; },
    async deliver(watch, save) { const command = watch.command ?? sendCommand(thread, "notify"); save(command); ids.push(command.commandId); if (ids.length === 1) throw Error("lost response"); return "delivered"; },
  };
  const w = await addWatch({ refs: ["local:t1"], caller: "local:caller", condition: { kind: "all-idle" }, options: {}, modelEnv: "local", intervalSeconds: 5, expiresInHours: 1 }, state, rt);
  await tick(state, rt, 1000); assert.equal(state.get<Watch>("watch", w.id)?.status, "pending");
  await tick(new State(state.directory), rt, 7000); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

test("cancel during evaluation prevents notification; expiry and self-watch are explicit", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  let id = "", deliveries = 0;
  const rt: WatchRuntime = { async observe(ref) { return { ref, thread }; }, async evaluate() { cancelWatch(id, state); return { matches: true }; }, async deliver() { deliveries++; return "delivered"; } };
  const input = { refs: ["local:t1"], caller: "local:caller", condition: { kind: "all-idle" as const }, options: {}, modelEnv: "local", intervalSeconds: 5, expiresInHours: 1 };
  id = (await addWatch(input, state, rt)).id;
  await tick(state, rt); assert.equal(deliveries, 0); assert.equal(state.get<Watch>("watch", id)?.status, "cancelled");
  await assert.rejects(addWatch({ ...input, caller: "local:t1" }, state, rt), { code: "INVALID_ARGUMENT" });
  const expired = await addWatch(input, state, rt);
  await tick(state, rt, expired.expiresAt + 1); assert.equal(state.get<Watch>("watch", expired.id)?.status, "expired");
});

test("real watcher runtime reads T3 and dispatches a wake-up preserving caller settings", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state"), rt = runtime();
  f.stored.get("t1")!.latestTurn = { state: "completed" };
  f.stored.set("t2", { ...thread, id: "t2", latestTurn: { state: "completed" } });
  f.stored.set("caller", { ...thread, id: "caller", messages: [] });
  const watch = await addWatch({ refs: ["local:t1", "local:t2"], caller: "local:caller", condition: { kind: "all-completed" }, options: { config: f.configPath }, modelEnv: "local", intervalSeconds: 5, expiresInHours: 1 }, state, rt);
  await tick(state, rt);
  assert.equal(state.get<Watch>("watch", watch.id)?.status, "delivered");
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]!.threadId, "caller");
  assert.deepEqual(f.commands[0]!.modelSelection, thread.modelSelection);
  assert.ok(f.commands[0]!.message.text.includes(watch.id));
  assert.deepEqual(await f.authActions(), ["issue", "revoke", "issue", "revoke", "issue", "revoke", "issue", "revoke"], "one auth session per machine for each batch, plus caller checks/delivery");
});

test("a CLI-created watcher outlives its caller process and emits an event", { timeout: 15_000 }, async t => {
  const f = await fixture(t), state = new State(f.dir + "/worker-state");
  t.after(async () => {
    const lease = state.get<{ pid: number }>("worker", "lease");
    if (lease) { try { process.kill(lease.pid, "SIGTERM"); } catch {} await delay(200); }
  });
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "src/bin.ts", "watch", "--config", f.configPath, "--threads", "local:t1", "--events-only", "--condition", "changed", "--interval-seconds", "5", "--json"], { env: { ...process.env, T3THREADS_STATE_DIR: state.directory } });
  const created = JSON.parse(stdout) as Watch;
  assert.equal(created.status, "active");
  f.stored.get("t1")!.updatedAt = "2030-01-01T00:00:00Z";
  const deadline = Date.now() + 10_000;
  while (state.get<Watch>("watch", created.id)?.status === "active" && Date.now() < deadline) await delay(50);
  assert.equal(state.get<Watch>("watch", created.id)?.status, "triggered");
});
