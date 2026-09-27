import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { across, connectNames, environments, replyEnvironment, targetFor } from "../src/environments.js";
import { catalog } from "../src/threads.js";
import { createCli } from "../src/cli.js";
import { fixture } from "./fixture.js";

test("federation distinguishes identical thread IDs, deduplicates one server, and reports offline environments", async t => {
  const one = await fixture(t, undefined, "one"), two = await fixture(t, undefined, "two");
  process.env.T3THREADS_TEST_REMOTE = "test-secret"; t.after(() => { delete process.env.T3THREADS_TEST_REMOTE; });
  const previous = process.env.T3THREADS_STATE_DIR; process.env.T3THREADS_STATE_DIR = one.dir + "/state";
  t.after(() => { if (previous) process.env.T3THREADS_STATE_DIR = previous; else delete process.env.T3THREADS_STATE_DIR; });
  const config = JSON.parse(await (await import("node:fs/promises")).readFile(one.configPath, "utf8"));
  config.environments.remote = { url: two.target.origin, tokenEnv: "T3THREADS_TEST_REMOTE" };
  config.environments.alias = { url: one.target.origin, tokenEnv: "T3THREADS_TEST_REMOTE" };
  config.environments.offline = { url: "http://127.0.0.1:1", tokenEnv: "T3THREADS_TEST_REMOTE" };
  await writeFile(one.configPath, JSON.stringify(config));
  const result = await across({ env: "all", config: one.configPath }, async (api, target) => ({ environment: target.name, refs: (await catalog(api)).threads.map(t => `${target.name}:${t.id}`) }));
  assert.equal(result.complete, false);
  assert.deepEqual(result.results.flatMap(r => r.refs).sort(), ["local:t1", "remote:t1"]);
  assert.equal(result.errors[0]?.environment, "offline");
});

test("manage uses native mutation commands, requires POST, and validates rename input", async t => {
  const f = await fixture(t), cli = createCli();
  const call = async (action: string, title?: string) => (await (await cli.fetch(new Request("http://cli/manage/t1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config: f.configPath, action, title }) }))).json()) as { ok: boolean };
  assert.equal((await call("rename")).ok, false);
  assert.equal((await call("rename", "Ada Lovelace")).ok, true); assert.equal(f.stored.get("t1")!.title, "Ada Lovelace");
  assert.equal((await call("archive")).ok, true); assert.equal(f.stored.get("t1")!.archivedAt, "today");
  assert.equal((await call("unarchive")).ok, true); assert.equal(f.stored.get("t1")!.archivedAt, null);
  assert.equal((await call("interrupt")).ok, true); assert.equal(f.stored.get("t1")!.latestTurn?.state, "interrupted");
  assert.equal((await call("settle")).ok, true); assert.equal(f.stored.get("t1")!.settledAt, "today");
  assert.equal((await call("settle", "Ada")).ok, false);
  const get = await cli.fetch(new Request(`http://cli/manage/t1?config=${encodeURIComponent(f.configPath)}&action=archive`));
  assert.equal((await get.json() as { ok: boolean }).ok, false);
});

test("settlement previews native commands and refuses unsupported servers", async t => {
  const cli = createCli(), supported = await fixture(t);
  const call = async (config: string, dryRun = false) => (await (await cli.fetch(new Request("http://cli/manage/t1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ config, action: "settle", dryRun }) }))).json()) as { ok: boolean; data: { command: { type: string; threadId: string } } };
  const preview = await call(supported.configPath, true);
  assert.equal(preview.ok, true);
  assert.equal(preview.data.command.type, "thread.settle");
  assert.equal(preview.data.command.threadId, "t1");
  assert.equal(supported.commands.length, 0);
  const unsupported = await fixture(t);
  unsupported.target.descriptor.capabilities = {};
  assert.equal((await call(unsupported.configPath)).ok, false);
  assert.equal(unsupported.commands.length, 0);
});

test("list exposes the shell metadata needed to settle completed investigations", async t => {
  const f = await fixture(t), cli = createCli();
  Object.assign(f.stored.get("t1")!, { settledAt: null, hasPendingApprovals: false, hasPendingUserInput: true, hasActionableProposedPlan: false, backgroundLiveness: "monitoring" });
  const response = await cli.fetch(new Request(`http://cli/list?config=${encodeURIComponent(f.configPath)}`));
  const result = await response.json() as { data: { results: { threads: Record<string, unknown>[] }[] } };
  const thread = result.data.results[0]!.threads[0]!;
  assert.equal(thread.settledAt, undefined);
  assert.equal(thread.hasPendingApprovals, false);
  assert.equal(thread.hasPendingUserInput, true);
  assert.equal(thread.hasActionableProposedPlan, false);
  assert.equal(thread.backgroundLiveness, "monitoring");
});

test("Connect names come from machine labels and fall back to the ID when a label is ambiguous or reserved", () => {
  const e = (environmentId: string, label: string) => ({ environmentId, label, endpoint: { httpBaseUrl: "https://host.test", wsBaseUrl: "wss://host.test" } });
  const names = connectNames([e("a", "Grace’s MacBook Pro"), e("b", "Twin"), e("c", "twin"), e("d", "local"), e("e", "All"), e("f", "connect-a"), e("g", "!!!"), e("h", "-Anna Winlock-")]);
  assert.deepEqual(Object.fromEntries(names), {
    a: "graces-macbook-pro", b: "connect-b", c: "connect-c", d: "connect-d", e: "connect-e", f: "connect-f", g: "connect-g", h: "anna-winlock",
  });
});

test("Connect machines resolve by label or ID, print the label name, and yield to configured names", async t => {
  const ada = await fixture(t, undefined, "ada-env"), grace = await fixture(t, undefined, "grace-env"), shadow = await fixture(t, undefined, "shadow-env");
  process.env.T3THREADS_TEST_REMOTE = "test-secret"; t.after(() => { delete process.env.T3THREADS_TEST_REMOTE; });
  const previous = process.env.T3THREADS_STATE_DIR; process.env.T3THREADS_STATE_DIR = ada.dir + "/state";
  t.after(() => { if (previous) process.env.T3THREADS_STATE_DIR = previous; else delete process.env.T3THREADS_STATE_DIR; });
  await writeFile(ada.dir + "/userdata/clerk-tokens.json", JSON.stringify({ __clerk_client_jwt: "raw:ada-client" }));
  const config = JSON.parse(await readFile(ada.configPath, "utf8"));
  config.environments.remote = { url: grace.target.origin, tokenEnv: "T3THREADS_TEST_REMOTE" };
  await writeFile(ada.configPath, JSON.stringify(config));
  const linked = [["ada-env", "Ada Lovelace", ada], ["grace-env", "Grace's Box", grace], ["shadow-env", "Remote", shadow]] as const;
  const fetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith("http://")) return fetch(url, init);
    if (url.startsWith("https://clerk.t3.codes/v1/client/sessions/")) return Response.json({ jwt: "relay-jwt" });
    if (url.startsWith("https://clerk.t3.codes/v1/client")) return Response.json({ response: { last_active_session_id: "ada", sessions: [{ id: "ada", status: "active" }] } });
    assert.equal(url, "https://relay.t3.codes/v1/environments");
    return Response.json({ environments: linked.map(([environmentId, label, f]) => ({ environmentId, label, endpoint: { httpBaseUrl: f.target.origin, wsBaseUrl: f.target.origin.replace("http", "ws") } })) });
  });
  const options = { config: ada.configPath };
  const listed = await environments(options);
  assert.deepEqual(Object.keys(listed.entries).sort(), ["ada-lovelace", "connect-shadow-env", "graces-box", "local", "remote"]);
  for (const [ref, name, environmentId] of [
    ["graces-box:t1", "graces-box", "grace-env"],
    ["connect-grace-env:t1", "graces-box", "grace-env"],
    ["remote:t1", "remote", "grace-env"],
    ["connect-shadow-env:t1", "connect-shadow-env", "shadow-env"],
  ]) {
    const { target, id } = await targetFor(options, ref);
    assert.deepEqual([target.name, target.descriptor.environmentId, id], [name, environmentId, "t1"], ref);
  }
  await assert.rejects(targetFor(options, "anna-winlock:t1"), { code: "ENVIRONMENT_NOT_FOUND" });
  assert.equal(await replyEnvironment(options, "grace-env", "ada-env"), "graces-box");
  assert.equal(await replyEnvironment(options, "ada-env", "ada-env"), "local");
  assert.equal(await replyEnvironment(options, "unlinked-env", "ada-env"), "connect-unlinked-env");
});
