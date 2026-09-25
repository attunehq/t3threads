import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { invocation, CliError } from "../src/client.js";
import { nativeClientToken, nativeRelayToken } from "../src/native-auth.js";
import { State } from "../src/state.js";
import { enqueueSend, tickQueue, type QueuedMessage } from "../src/queue.js";
import { fixture } from "./fixture.js";
import { createCli } from "../src/cli.js";

test("managed runtime is discovered despite stale desktop/PATH and custom commands remain authoritative", async t => {
  const f = await fixture(t);
  const directory = join(f.dir, "runtime/versions", f.target.descriptor.serverVersion);
  await mkdir(directory, { recursive: true });
  const binary = join(directory, process.platform === "win32" ? "t3.exe" : "t3");
  if (process.platform === "win32") return t.skip("POSIX executable fixture; runtime discovery uses t3.exe on Windows");
  await writeFile(binary, `#!${process.execPath}\nconsole.log('t3 v${f.target.descriptor.serverVersion}');`, { mode: 0o700 });
  const found = await invocation({ ...f.target, config: {} });
  assert.deepEqual(found.command, [binary]);
  await assert.rejects(invocation({ ...f.target, config: { command: [process.execPath, "--version"] } }), { code: "MATCHING_CLI_REQUIRED" });
  await writeFile(binary, `#!${process.execPath}\nconsole.log('t3 vwrong');`, { mode: 0o700 });
  await assert.rejects(invocation({ ...f.target, config: {} }), { code: "MATCHING_CLI_REQUIRED" });
});

test("cached native sign-in survives process restarts and a locked Keychain but not account changes or sign-out", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const path = f.dir + "/userdata/clerk-tokens.json";
  const original = JSON.stringify({ __clerk_client_jwt: "enc:encrypted-ada" });
  await writeFile(path, original);
  let unlocks = 0;
  assert.equal(await nativeClientToken({ home: f.dir }, state, async () => { unlocks++; return "ada-client"; }), "ada-client");
  const locked = async () => { unlocks++; throw new CliError("NATIVE_AUTH_LOCKED", "locked"); };
  assert.equal(await nativeClientToken({ home: f.dir }, new State(state.directory), locked), "ada-client");
  assert.equal(unlocks, 1);
  assert.equal(await readFile(path, "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal((await stat(state.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(state.directory + "/state.sqlite")).mode & 0o777, 0o600);
  }
  await writeFile(path, JSON.stringify({ __clerk_client_jwt: "enc:encrypted-grace" }));
  await assert.rejects(nativeClientToken({ home: f.dir }, state, locked), { code: "NATIVE_AUTH_LOCKED" });
  assert.equal(state.list("native-client").length, 0);
  assert.equal(await nativeClientToken({ home: f.dir }, state, async () => "grace-client"), "grace-client");
  await writeFile(path, "{}");
  await assert.rejects(nativeClientToken({ home: f.dir }, state, locked), { code: "T3_SIGN_IN_REQUIRED" });
  assert.equal(state.list("native-client").length, 0);
});

test("fresh relay tokens can be minted from a cached encrypted sign-in without unlocking again", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  await writeFile(f.dir + "/userdata/clerk-tokens.json", JSON.stringify({ __clerk_client_jwt: "enc:encrypted-ada" }));
  await nativeClientToken({ home: f.dir }, state, async () => "ada-client");
  const fetch = globalThis.fetch;
  let tokens = 0;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith(f.target.origin)) return fetch(url, init);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer ada-client");
    if (url.includes("/tokens/")) return Response.json({ jwt: `renewed-${++tokens}` });
    return Response.json({ response: { last_active_session_id: "ada", sessions: [{ id: "ada", status: "active" }] } });
  });
  const locked = async () => { throw new CliError("NATIVE_AUTH_LOCKED", "fixture Keychain is locked"); };
  assert.equal(await nativeRelayToken({ home: f.dir }, undefined, new State(state.directory), locked), "renewed-1");
  assert.equal(await nativeRelayToken({ home: f.dir }, undefined, new State(state.directory), locked), "renewed-2");
});

test("send persists through Fetch before any server is reachable, then delivers after restart with stable IDs", async t => {
  const f = await fixture(t), state = new State(f.dir + "/state");
  const previous = process.env.T3THREADS_STATE_DIR;
  process.env.T3THREADS_STATE_DIR = state.directory;
  t.after(() => { if (previous === undefined) delete process.env.T3THREADS_STATE_DIR; else process.env.T3THREADS_STATE_DIR = previous; });
  state.put("worker", "lease", { owner: "test", pid: process.pid });
  await writeFile(f.dir + "/userdata/server-runtime.json", JSON.stringify({ origin: "http://127.0.0.1:1" }));
  const response = await createCli().fetch(new Request("http://cli/send/local:t1", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: f.configPath, caller: "local:t1", prompt: "Reply when online", steer: true }),
  }));
  const result = await response.json() as { data: { status: string; queueId: string; commandId: string } };
  assert.equal(result.data.status, "queued");
  await tickQueue(state, undefined, 1000);
  assert.equal(state.get<QueuedMessage>("message", result.data.queueId)?.error?.code, "SERVER_UNREACHABLE");
  await writeFile(f.dir + "/userdata/server-runtime.json", JSON.stringify({ origin: f.target.origin }));
  f.stored.get("t1")!.latestTurn = { state: "running" };
  f.control.loseReceipt = true;
  await tickQueue(new State(state.directory), undefined, 6000);
  const dispatched = state.get<QueuedMessage>("message", result.data.queueId)!;
  assert.equal(dispatched.status, "dispatching");
  assert.equal(dispatched.command!.commandId, result.data.commandId);
  assert.match(f.commands[0]!.message.text, /Reply when online/);
  // Recovery cannot depend on re-reading the sender or an idle recipient.
  f.stored.get("t1")!.messages = [];
  f.control.loseReceipt = false;
  await tickQueue(new State(state.directory), undefined, 12000);
  assert.equal(state.get<QueuedMessage>("message", result.data.queueId)?.status, "accepted");
  assert.equal(f.commands.length, 1);
});

test("offline cross-machine message and reply survive separate outboxes and preserve reply addresses", async t => {
  const ada = await fixture(t, undefined, "ada-env"), grace = await fixture(t, undefined, "grace-env");
  const adaState = new State(ada.dir + "/outbox"), graceState = new State(grace.dir + "/outbox");
  const tokenKey = "T3_DURABLE_FIXTURE_TOKEN";
  process.env[tokenKey] = "test-secret";
  t.after(() => { delete process.env[tokenKey]; });
  const config = (home: typeof ada, remote: typeof grace) => ({ environments: {
    local: { home: home.dir, command: home.target.config.command },
    [`connect-${remote.target.descriptor.environmentId}`]: { url: remote.target.origin, tokenEnv: tokenKey },
  } });
  await writeFile(ada.configPath, JSON.stringify({ environments: { ...config(ada, grace).environments, "connect-grace-env": { url: "http://127.0.0.1:1", tokenEnv: tokenKey } } }));
  await writeFile(grace.configPath, JSON.stringify(config(grace, ada)));
  const first = enqueueSend({ ref: "connect-grace-env:t1", options: { config: ada.configPath }, request: { prompt: "Please review", caller: "local:t1", steer: false } }, adaState);
  await tickQueue(adaState, undefined, 1000);
  assert.equal(adaState.get<QueuedMessage>("message", first.id)?.status, "pending");
  await writeFile(ada.configPath, JSON.stringify(config(ada, grace)));
  await tickQueue(new State(adaState.directory), undefined, 6000);
  assert.equal(adaState.get<QueuedMessage>("message", first.id)?.status, "accepted");
  assert.match(grace.commands[0]!.message.text, /target connect-ada-env:t1/);
  const reply = enqueueSend({ ref: "connect-ada-env:t1", options: { config: grace.configPath }, request: { prompt: "Reviewed", caller: "local:t1", steer: true } }, graceState);
  await tickQueue(new State(graceState.directory));
  assert.equal(graceState.get<QueuedMessage>("message", reply.id)?.status, "accepted");
  assert.match(ada.commands[0]!.message.text, /target connect-grace-env:t1/);
});
