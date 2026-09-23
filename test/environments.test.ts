import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { across } from "../src/environments.js";
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
  const get = await cli.fetch(new Request(`http://cli/manage/t1?config=${encodeURIComponent(f.configPath)}&action=archive`));
  assert.equal((await get.json() as { ok: boolean }).ok, false);
});
