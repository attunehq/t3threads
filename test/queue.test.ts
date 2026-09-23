import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile } from "node:fs/promises";
import { cancelMessage, enqueue, queueDelivery, tickQueue, type QueuedMessage } from "../src/queue.js";
import { State } from "../src/state.js";
import { sendCommand } from "../src/threads.js";
import { CliError } from "../src/client.js";
import { fixture, thread } from "./fixture.js";

const input = (config: string, text = "Continue", ref = "local:t1") => ({
  ref, environmentId: "test-env", options: { config }, command: sendCommand(thread, text),
});

test("queue survives restart, waits for idle, and preserves recipient settings at delivery", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const queued = enqueue(input(f.configPath), state);
  f.stored.get("t1")!.session = { status: "starting", activeTurnId: null, lastError: null };
  await tickQueue(state, queueDelivery(), 1000);
  assert.equal(f.commands.length, 0);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "pending");
  f.stored.get("t1")!.session = null;
  f.stored.get("t1")!.interactionMode = "default";
  f.stored.get("t1")!.modelSelection = { instanceId: "codex-work", model: "changed-model" };
  await tickQueue(new State(state.directory), queueDelivery(), 6000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.equal(f.commands.length, 1);
  assert.equal(f.commands[0]!.commandId, queued.command.commandId);
  assert.equal(f.commands[0]!.interactionMode, "default");
  assert.equal(f.commands[0]!.modelSelection.model, "changed-model");
  await tickQueue(state, queueDelivery(), 12000);
  assert.equal(f.commands.length, 1);
});

test("FIFO includes environment aliases and waiting heads without blocking other recipients", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const first = enqueue(input(f.configPath, "first"), state);
  const second = enqueue(input(f.configPath, "second", "alias:t1"), state);
  const third = enqueue({ ...input(f.configPath), ref: "local:t2", command: sendCommand({ ...thread, id: "t2" }, "third") }, state);
  const seen: string[] = [];
  const deliver = async (message: QueuedMessage) => { seen.push(message.id); return message.id === first.id ? "busy" as const : "accepted" as const; };
  await tickQueue(state, deliver, 1000);
  assert.deepEqual(seen, [first.id, third.id]);
  await tickQueue(state, deliver, 2000);
  assert.deepEqual(seen, [first.id, third.id], "the second message cannot overtake a head waiting for its next check");
  cancelMessage(first.id, state);
  await tickQueue(state, deliver, 3000);
  assert.equal(seen.at(-1), second.id);
});

test("lost receipt recovery recognizes an accepted message without dispatching twice", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const queued = enqueue(input(f.configPath), state);
  f.control.loseReceipt = true;
  f.control.startRunning = true;
  await tickQueue(state, queueDelivery(), 1000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "dispatching");
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.error?.code, "DISPATCH_UNKNOWN");
  await tickQueue(new State(state.directory), queueDelivery(), 6000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.equal(f.commands.length, 1);
});

test("recovery outside the recent history window reuses the frozen command and receipt", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const queued = enqueue(input(f.configPath), state);
  f.control.loseReceipt = true;
  await tickQueue(state, queueDelivery(), 1000);
  const frozen = state.get<QueuedMessage>("message", queued.id)!.command;
  f.stored.get("t1")!.messages = [];
  f.stored.get("t1")!.modelSelection = { instanceId: "changed", model: "changed" };
  f.control.loseReceipt = false;
  await tickQueue(new State(state.directory), queueDelivery(), 6000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.deepEqual(state.get<QueuedMessage>("message", queued.id)?.command, frozen);
  assert.equal(f.commands.length, 1, "T3 deduplicates the persisted command ID");
});

test("cancel before dispatch wins the claim; dispatching messages cannot be recalled", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const queued = enqueue(input(f.configPath), state);
  let sent = false;
  await tickQueue(state, async (message, claim) => {
    cancelMessage(message.id, state);
    if (!claim(message.command)) return "cancelled";
    sent = true; return "accepted";
  });
  assert.equal(sent, false);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "cancelled");
  const another = enqueue(input(f.configPath), state);
  await tickQueue(state, async (message, claim) => {
    assert.equal(claim(message.command), true);
    assert.throws(() => cancelMessage(message.id, state), { code: "DELIVERY_STARTED" });
    throw new CliError("DISPATCH_UNKNOWN", "lost receipt");
  });
  assert.equal(state.get<QueuedMessage>("message", another.id)?.status, "dispatching");
  assert.throws(() => cancelMessage("missing", state), { code: "MESSAGE_NOT_FOUND" });
});

test("offline recipients retry, while inactive, missing, rejected, or changed recipients fail visibly", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const queued = enqueue(input(f.configPath), state);
  await tickQueue(state, async () => { throw new CliError("SERVER_UNREACHABLE", "offline"); }, 1000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "pending");
  f.stored.get("t1")!.archivedAt = "today";
  await tickQueue(state, queueDelivery(), 6000);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "failed");
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.error?.code, "THREAD_INACTIVE");
  f.stored.get("t1")!.archivedAt = null;
  const changed = enqueue({ ...input(f.configPath), environmentId: "old-env" }, state);
  await tickQueue(state);
  assert.equal(state.get<QueuedMessage>("message", changed.id)?.error?.code, "ENVIRONMENT_MISMATCH");
  const rejected = enqueue(input(f.configPath), state);
  f.control.reject = true;
  await tickQueue(state);
  assert.equal(state.get<QueuedMessage>("message", rejected.id)?.status, "failed");
  assert.equal(state.get<QueuedMessage>("message", rejected.id)?.error?.code, "RPC_REJECTED");
  f.control.reject = false;
  const missing = enqueue(input(f.configPath), state);
  f.stored.delete("t1");
  await tickQueue(state);
  assert.equal(state.get<QueuedMessage>("message", missing.id)?.status, "failed");
  assert.equal(f.commands.length, 0);
});

test("queued delivery resolves a remote recipient independently of the local worker", async t => {
  const local = await fixture(t), remote = await fixture(t, undefined, "remote-env");
  const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret"; t.after(() => { delete process.env[key]; });
  await writeFile(local.configPath, JSON.stringify({ environments: {
    local: { home: local.dir, command: local.target.config.command }, remote: { url: remote.target.origin, tokenEnv: key },
  } }));
  const state = new State(local.dir + "/state");
  const queued = enqueue({ ...input(local.configPath, "Continue", "remote:t1"), environmentId: "remote-env" }, state);
  await tickQueue(state);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.equal(local.commands.length, 0);
  assert.equal(remote.commands.length, 1);
});

test("CLI enqueue outlives the sending process, exposes status, and supports cancellation and dry run", { timeout: 20_000 }, async t => {
  let state: State | undefined;
  t.after(async () => {
    const pid = state?.get<{ pid: number }>("worker", "lease")?.pid;
    if (!pid) return;
    try { process.kill(pid, "SIGTERM"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    const deadline = Date.now() + 5000;
    while (state?.get("worker", "lease") && Date.now() < deadline) await delay(50);
    assert.equal(state?.get("worker", "lease"), undefined);
  });
  const f = await fixture(t);
  state = new State(f.dir + "/worker-state");
  f.stored.get("t1")!.latestTurn = { state: "running" };
  f.control.startRunning = true;
  const cli = async (...args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
    ["--import", "tsx", "src/bin.ts", ...args, "--json"],
    { env: { ...process.env, T3THREADS_STATE_DIR: state!.directory } })).stdout);
  const args = ["send", "t1", "--config", f.configPath, "--caller", "local:t1", "--prompt", "1Password is available. Continue.", "--enqueue"];
  await cli(...args, "--dry-run");
  assert.equal(state.list("message").length, 0);
  assert.equal(state.get("worker", "lease"), undefined);
  const first = await cli(...args), second = await cli(...args);
  assert.equal(first.status, "queued");
  assert.equal(f.commands.length, 0);
  assert.equal((await cli("unqueue", second.queueId)).status, "cancelled");
  assert.equal((await cli("queued")).messages.length, 2);
  f.stored.get("t1")!.latestTurn = { state: "completed" };
  const deadline = Date.now() + 12000;
  while (state.get<QueuedMessage>("message", first.queueId)?.status !== "accepted" && Date.now() < deadline) await delay(50);
  assert.equal(state.get<QueuedMessage>("message", first.queueId)?.status, "accepted");
  assert.equal(f.commands.length, 1);
  assert.match(f.commands[0]!.message.text, /Sender thread: local:t1/);
  assert.match(f.commands[0]!.message.text, /1Password is available. Continue./);
});
