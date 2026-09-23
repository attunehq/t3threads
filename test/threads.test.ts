import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Api, discover, exists, withApi } from "../src/client.js";
import { catalog, readAll, readThread, search, selectProject, selection, sendCommand, dispatch, startCommand } from "../src/threads.js";
import { createCli } from "../src/cli.js";
import { fixture, json, message, project, thread } from "./fixture.js";

test("history pagination finds old messages and deduplicates page overlap", async t => {
  const f = await fixture(t, (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (!url.pathname.includes("/threads/")) return;
    const older = url.searchParams.has("beforeCursor");
    json(res, { snapshotSequence: 2, thread: { ...thread, messages: older ? [message("1", "billing decision: annual"), message("2", "middle")] : [message("2", "middle"), message("3", "recent")] }, page: { hasMore: !older, beforeCursor: older ? null : "opaque/+cursor" } }); return true;
  });
  const result = await readAll(f.api, "t1");
  assert.deepEqual(result.thread.messages?.map(m => m.id), ["1", "2", "3"]);
  const found = await search(f.api, [thread], "billing decision", 20);
  assert.equal(found.matches[0]?.messageId, "1"); assert.equal(found.complete, true);
});

test("archived threads are opt-in and deleted threads stay excluded", async t => {
  const f = await fixture(t);
  f.stored.set("archived", { ...thread, id: "archived", archivedAt: "yesterday" });
  f.stored.set("deleted", { ...thread, id: "deleted", deletedAt: "yesterday" });
  assert.deepEqual((await catalog(f.api)).threads.map(t => t.id), ["t1"]);
  assert.deepEqual((await catalog(f.api, true)).threads.map(t => t.id), ["t1", "archived"]);
});

test("search reports truncation and malformed pagination stops", async t => {
  const f = await fixture(t, (req, res) => { if (!req.url!.includes("/threads/")) return; json(res, { snapshotSequence: 2, thread: { ...thread, messages: [message("1", "match")] }, page: { hasMore: true, beforeCursor: "same" } }); return true; });
  assert.equal((await search(f.api, [thread], "match", 1)).complete, false);
  await assert.rejects(readAll(f.api, "t1"), { code: "INVALID_RESPONSE" });
});

test("incompatible message and thread responses fail explicitly", async t => {
  const f = await fixture(t, (_req, res) => { json(res, { thread: { ...thread, id: "wrong", messages: [] } }); return true; });
  await assert.rejects(readThread(f.api, "t1"), { code: "INVALID_RESPONSE" });
});

test("project/model selection rejects ambiguity and preserves provider options", () => {
  assert.throws(() => selectProject([project, { ...project, id: "p2" }], project.title), /Multiple projects/);
  assert.equal(selectProject([project], "/work/grace/src").id, "p1");
  assert.throws(() => selectProject([project], "/work/graceful"), /Project not found/);
  assert.throws(() => selection(project, "another-provider"), /--model/);
  assert.deepEqual(selection(project), project.defaultModelSelection);
  assert.deepEqual(selection(project, undefined, "other-model"), { instanceId: "codex-work", model: "other-model" });
  assert.throws(() => selection({ ...project, defaultModelSelection: null }), /no default model/);
});

test("busy or archived threads cannot be resumed implicitly", () => {
  assert.throws(() => sendCommand({ ...thread, latestTurn: { state: "running" } }, "Go"), /running/);
  assert.throws(() => sendCommand({ ...thread, archivedAt: "yesterday" }, "Go"), /Restore/);
});

test("temporary sessions are revoked after success and failure", async t => {
  const f = await fixture(t, (_req, res) => { json(res, { secret: "test-secret" }, 500); return true; });
  await withApi(f.target, async () => "ok");
  await assert.rejects(withApi(f.target, api => api.request("/failure")), { code: "HTTP_ERROR", message: "T3 returned HTTP 500." });
  assert.deepEqual(await f.authActions(), ["issue", "revoke", "issue", "revoke"]);
});

test("version mismatch fails before issuing credentials", async t => {
  const f = await fixture(t);
  await assert.rejects(withApi({ ...f.target, descriptor: { ...f.target.descriptor, serverVersion: "different" } }, async () => null), { code: "MATCHING_CLI_REQUIRED" });
  assert.equal(await exists(f.authLog), false);
});

test("RPC uses tickets, handles batched frames, and keeps dispatch errors actionable", async t => {
  const f = await fixture(t);
  const command = startCommand(project, { prompt: "Review", model: project.defaultModelSelection!, permission: "approval-required", mode: "plan", worktree: true, branch: "main", startFromOrigin: false, setup: true });
  assert.equal((await dispatch(f.api, command)).status, "accepted");
  assert.equal(f.commands[0]?.bootstrap.prepareWorktree?.requireWorktree, true);
  assert.equal(f.commands[0]?.bootstrap.prepareWorktree?.branch, `t3threads/${command.threadId}`);
  assert.notEqual(f.commands[0]?.bootstrap.prepareWorktree?.branch, "main");
  assert.deepEqual(f.commands[0]?.modelSelection, project.defaultModelSelection);
  f.control.reject = true;
  await assert.rejects(dispatch(f.api, command), error => {
    assert.equal((error as { code: string }).code, "RPC_REJECTED");
    assert.equal((error as { details: { threadId: string } }).details.threadId, command.threadId);
    assert.ok(!String(error).includes("test-secret")); return true;
  });
  f.control.reject = false; f.control.disconnect = true;
  await assert.rejects(dispatch(f.api, command), { code: "DISPATCH_UNKNOWN" });
});

test("HTTP redirects never forward the credential", async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { location: "http://127.0.0.1:1/" }); res.end(); return true; });
  await assert.rejects(f.api.request("/redirect"), { code: "REQUEST_FAILED" });
  await assert.rejects(discover("remote", { url: "http://example.com", tokenEnv: "TOKEN" }), { code: "INVALID_URL" });
});

test("Fetch API shares CLI validation and executes start/read/send through RPC", async t => {
  const f = await fixture(t); const cli = createCli();
  const call = async (path: string, options: Record<string, unknown> = {}, method = "POST") => {
    const query = new URLSearchParams({ config: f.configPath });
    if (method === "GET") for (const [key, value] of Object.entries(options)) query.set(key, String(value));
    const response = await cli.fetch(new Request(`http://cli/${path}?${query}`, { method, ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify({ config: f.configPath, ...options }) }) }));
    return response.json() as Promise<{ ok: boolean; data: any; error?: { code: string } }>;
  };
  assert.equal((await call("read/t1", { turns: 0 }, "GET")).ok, false);
  const start = { project: "p1", checkout: "worktree", branch: "main", prompt: "Implement", mode: "plan" };
  assert.equal((await call("start", start, "GET")).ok, false);
  const dry = await call("start", { ...start, dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.data.dryRun, true);
  assert.equal(f.commands.length, 0);
  const result = await call("start", start);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.status, "accepted");
  const id = result.data.threadId;
  const read = await call(`read/${id}`, {}, "GET");
  assert.equal(read.data.messages[0].text, "Implement");
  assert.equal((await call(`send/${id}`, { prompt: "Test it" })).ok, false);
  assert.equal((await call(`send/${id}`, { prompt: "Test it", caller: "all:t1" })).ok, false);
  assert.equal((await call(`send/${id}`, { prompt: "Test it", caller: "local:missing" })).ok, false);
  assert.equal(f.commands.length, 1);
  f.stored.get("t1")!.latestTurn = { state: "running" };
  const promptFile = `${f.dir}/prompt.txt`;
  await writeFile(promptFile, "Test it\nKeep the details.\n");
  const sendOptions = { promptFile, caller: "local:t1" };
  const preview = await call(`send/${id}`, { ...sendOptions, dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(f.commands.length, 1);
  assert.match(preview.data.command.message.text, /agent in T3 thread "Earlier design"/);
  assert.match(preview.data.command.message.text, /Sender thread: local:t1/);
  assert.match(preview.data.command.message.text, /Sender environment ID: test-env/);
  assert.match(preview.data.command.message.text, /from another agent, not the user/);
  assert.match(preview.data.command.message.text, /target local:t1 and --caller/);
  assert.ok(preview.data.command.message.text.endsWith("\n\nTest it\nKeep the details.\n"));
  assert.equal((await call(`send/${id}`, sendOptions)).ok, true);
  assert.equal(f.commands[1]?.message.text, preview.data.command.message.text);
  assert.equal(f.commands[1]?.runtimeMode, "approval-required");
  assert.equal(f.commands[1]?.interactionMode, "plan");
  assert.deepEqual(f.commands[1]?.modelSelection, project.defaultModelSelection);
});

test("send resolves caller independently of recipient environment and provides a cross-machine reply target", async t => {
  const sender = await fixture(t, undefined, "sender-env");
  const recipient = await fixture(t, undefined, "recipient-env");
  sender.stored.get("t1")!.title = "Ada Lovelace's analysis";
  const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret"; t.after(() => { delete process.env[key]; });
  await writeFile(sender.configPath, JSON.stringify({ environments: {
    local: { home: sender.dir, command: sender.target.config.command },
    remote: { url: recipient.target.origin, tokenEnv: key },
  } }));
  const cli = createCli();
  const response = await cli.fetch(new Request("http://cli/send/t1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    config: sender.configPath, env: "remote", caller: "t1", prompt: "Review the analysis.",
  }) }));
  const result = await response.json() as { ok: boolean };
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(sender.commands.length, 0);
  assert.equal(recipient.commands.length, 1);
  const text = recipient.commands[0]!.message.text;
  assert.match(text, /agent in T3 thread "Ada Lovelace's analysis"/);
  assert.match(text, /Sender thread: local:t1/);
  assert.match(text, /Sender environment ID: sender-env/);
  assert.match(text, /target connect-sender-env:t1 and --caller/);
  assert.ok(text.endsWith("\n\nReview the analysis."));
});

test("named remote environments work without spawning the local auth CLI", async t => {
  const f = await fixture(t); const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret"; t.after(() => { delete process.env[key]; });
  await writeFile(f.configPath, JSON.stringify({ environments: { local: { home: f.dir, command: f.target.config.command }, remote: { url: f.target.origin, tokenEnv: key } } }));
  const cli = createCli(); const query = new URLSearchParams({ config: f.configPath });
  const r = await (await cli.fetch(new Request(`http://cli/read/remote:t1?${query}`))).json() as { ok: boolean; data: { environment: string } };
  assert.equal(r.ok, true); assert.equal(r.data.environment, "remote"); assert.equal(await exists(f.authLog), false);
  query.set("env", "local");
  const bad = await (await cli.fetch(new Request(`http://cli/read/remote:t1?${query}`))).json() as { ok: boolean };
  assert.equal(bad.ok, false);
});
