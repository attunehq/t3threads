import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { createCli } from "../src/cli.js";
import { State } from "../src/state.js";
import { tickQueue, type QueuedMessage } from "../src/queue.js";
import { fixture, thread } from "./fixture.js";
import type { TestContext } from "node:test";

async function setup(t: TestContext) {
  const f = await fixture(t), cli = createCli(), state = new State(f.dir + "/state");
  const previous = process.env.T3THREADS_STATE_DIR;
  process.env.T3THREADS_STATE_DIR = state.directory;
  t.after(() => { if (previous === undefined) delete process.env.T3THREADS_STATE_DIR; else process.env.T3THREADS_STATE_DIR = previous; });
  state.put("worker", "lease", { owner: "test", pid: process.pid });
  const send = async (options: object) => (await cli.fetch(new Request("http://cli/send/t1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: f.configPath, prompt: "Continue with the approved scope.", ...options }),
  }))).json() as Promise<any>;
  return { ...f, state, send };
}

test("send defaults to direct steering for both caller types on idle and busy threads", async t => {
  const f = await setup(t);
  for (const caller of [{ caller: "local:t1" }, { externalCaller: "jessbot" }]) {
    for (const latestTurn of [null, { state: "running" }]) {
      f.stored.get("t1")!.latestTurn = latestTurn;
      for (const options of [{}, { steer: true }]) {
        const before = f.commands.length;
        const preview = await f.send({ ...caller, ...options, dryRun: true });
        assert.equal(preview.data.delivery, "steer");
        assert.equal(f.commands.length, before);
        const result = await f.send({ ...caller, ...options });
        assert.equal(result.data.status, "accepted");
        assert.equal(result.data.queueId, undefined);
        assert.equal(f.commands.length, before + 1, "dispatch completes before returning");
        const command = f.commands.at(-1)!;
        assert.equal(command.message.text, preview.data.command.message.text);
        assert.deepEqual(command.modelSelection, thread.modelSelection);
        assert.equal(command.runtimeMode, thread.runtimeMode);
        assert.equal(command.interactionMode, thread.interactionMode);
        assert.equal(f.state.list("message").length, 0);
      }
    }
  }
});

test("enqueue is explicit, previews busy recipients, and waits for idle for both caller types", async t => {
  const f = await setup(t);
  for (const caller of [{ caller: "local:t1" }, { externalCaller: "jessbot" }]) {
    f.stored.get("t1")!.latestTurn = { state: "running" };
    const before = f.commands.length;
    const preview = await f.send({ ...caller, enqueue: true, dryRun: true });
    assert.equal(preview.data.delivery, "idle");
    assert.equal(f.commands.length, before);
    assert.equal((await f.send({ ...caller, steer: true, enqueue: true })).error.code, "INVALID_ARGUMENT");
    assert.equal((await f.send({ ...caller, steer: false })).error.code, "THREAD_BUSY");
    const result = await f.send({ ...caller, enqueue: true });
    assert.equal(result.data.status, "queued");
    assert.equal(f.commands.length, before);
    await tickQueue(f.state, undefined, 1000);
    assert.equal(f.commands.length, before);
    assert.equal(f.state.get<QueuedMessage>("message", result.data.queueId)?.status, "pending");
    f.stored.get("t1")!.latestTurn = { state: "completed" };
    await tickQueue(f.state, undefined, 6000);
    assert.equal(f.commands.length, before + 1);
    assert.equal(f.state.get<QueuedMessage>("message", result.data.queueId)?.status, "accepted");
  }
});

test("direct sends report failures and uncertain receipts without silently queueing or retrying", async t => {
  const f = await setup(t);
  for (const caller of [{ caller: "local:t1" }, { externalCaller: "jessbot" }]) {
    await writeFile(f.dir + "/userdata/server-runtime.json", JSON.stringify({ origin: "http://127.0.0.1:1" }));
    assert.equal((await f.send(caller)).error.code, "SERVER_UNREACHABLE");
    await writeFile(f.dir + "/userdata/server-runtime.json", JSON.stringify({ origin: f.target.origin }));
    for (const field of ["archivedAt", "deletedAt"] as const) {
      f.stored.get("t1")![field] = "today";
      assert.equal((await f.send(caller)).error.code, "THREAD_INACTIVE");
      f.stored.get("t1")![field] = null;
    }
    f.control.reject = true;
    assert.equal((await f.send(caller)).error.code, "RPC_REJECTED");
    f.control.reject = false;
    f.control.loseReceipt = true;
    const unknown = await f.send(caller);
    assert.equal(unknown.error.code, "DISPATCH_UNKNOWN");
    assert.ok(unknown.error.message.includes(f.commands.at(-1)!.commandId));
    assert.ok(unknown.error.message.includes("Thread: t1"));
    f.control.loseReceipt = false;
    const before = f.commands.length;
    assert.equal(f.state.list("message").length, 0);
    await tickQueue(f.state);
    assert.equal(f.commands.length, before);
  }
});

test("CLI send dispatches by default without starting a delivery worker", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  f.stored.get("t1")!.latestTurn = { state: "running" };
  const result = JSON.parse((await promisify(execFile)(process.execPath,
    ["--import", "tsx", "src/bin.ts", "send", "t1", "--config", f.configPath, "--caller", "local:t1", "--prompt", "Continue.", "--json"],
    { env: { ...process.env, T3THREADS_STATE_DIR: state.directory } })).stdout);
  assert.equal(result.status, "accepted");
  assert.equal(f.commands.length, 1);
  assert.equal(state.list("message").length, 0);
  assert.equal(state.get("worker", "lease"), undefined);
});
