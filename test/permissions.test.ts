import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createCli } from "../src/cli.js";
import { fixture } from "./fixture.js";

const modes = ["approval-required", "auto-accept-edits", "auto", "full-access"];
const cli = createCli();
async function start(config: string, options: Record<string, unknown> = {}) {
  return (await cli.fetch(new Request("http://cli/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, project: "p1", checkout: "current", prompt: "Review", dryRun: true, ...options }),
  }))).json() as Promise<any>;
}
function expectMode(result: any, mode: string) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.command.runtimeMode, mode);
  assert.equal(result.data.command.bootstrap.createThread.runtimeMode, mode);
}

test("start inherits each machine default and each project override, refreshing settings per call", async t => {
  const f = await fixture(t);
  for (const machine of modes) {
    f.settings.defaultRuntimeMode = machine;
    for (const overrides of [undefined, {}, { p1: {} }, { other: { defaultRuntimeMode: "auto" } }]) {
      f.settings.projectSettingsOverrides = overrides;
      expectMode(await start(f.configPath), machine);
    }
    for (const project of modes) {
      f.settings.projectSettingsOverrides = { p1: { defaultRuntimeMode: project } };
      expectMode(await start(f.configPath, { checkout: "worktree", branch: "main" }), project);
    }
  }
  assert.equal(f.commands.length, 0);
});

test("fully explicit settings bypass inheritance, and invalid permissions never dispatch", async t => {
  const f = await fixture(t);
  f.control.reject = true;
  for (const permission of modes) expectMode(await start(f.configPath, { permission, provider: "codex-work", model: "explicit" }), permission);
  assert.equal(f.rpcMethods.includes("server.getSettings"), false);
  for (const permission of ["", "invalid", null]) assert.equal((await start(f.configPath, { permission })).ok, false);
  assert.equal(f.commands.length, 0);
});

test("missing, malformed, or unreadable inherited permissions fail before dispatch", async t => {
  const f = await fixture(t);
  for (const settings of [
    {}, { defaultRuntimeMode: null }, { defaultRuntimeMode: "unknown" },
    { defaultRuntimeMode: "auto", projectSettingsOverrides: [] },
    { defaultRuntimeMode: "auto", projectSettingsOverrides: { p1: null } },
    { defaultRuntimeMode: "auto", projectSettingsOverrides: { p1: { defaultRuntimeMode: null } } },
    { defaultRuntimeMode: "auto", projectSettingsOverrides: { p1: { defaultRuntimeMode: "unknown" } } },
  ]) {
    delete f.settings.defaultRuntimeMode;
    delete f.settings.projectSettingsOverrides;
    Object.assign(f.settings, settings);
    const result = await start(f.configPath, { dryRun: false });
    assert.equal(result.ok, false, JSON.stringify(settings));
    assert.equal(result.error.code, "PERMISSION_REQUIRED");
    assert.match(result.error.message, /--permission/);
  }
  f.control.reject = true;
  assert.equal((await start(f.configPath, { dryRun: false })).ok, false);
  assert.equal(f.commands.length, 0);
});

test("remote starts use destination settings and project IDs, including explicit overrides and real dispatch", async t => {
  const local = await fixture(t, undefined, "local-env");
  const remote = await fixture(t, undefined, "remote-env");
  local.settings.defaultRuntimeMode = "approval-required";
  local.settings.projectSettingsOverrides = { p1: { defaultRuntimeMode: "full-access" } };
  remote.settings.defaultRuntimeMode = "auto";
  const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret";
  t.after(() => { delete process.env[key]; });
  await writeFile(local.configPath, JSON.stringify({ environments: {
    local: { home: local.dir, command: local.target.config.command },
    remote: { url: remote.target.origin, tokenEnv: key },
    alternate: { home: remote.dir, command: remote.target.config.command },
  } }));
  expectMode(await start(local.configPath), "full-access");
  expectMode(await start(local.configPath, { env: "remote" }), "auto");
  remote.settings.projectSettingsOverrides = { p1: { defaultRuntimeMode: "auto-accept-edits" } };
  for (const env of ["remote", "alternate"]) {
    expectMode(await start(local.configPath, { env, checkout: "worktree", branch: "main" }), "auto-accept-edits");
    expectMode(await start(local.configPath, { env, permission: "approval-required" }), "approval-required");
  }
  expectMode(await start(local.configPath, { home: remote.dir }), "auto-accept-edits");
  const result = await start(local.configPath, { env: "remote", dryRun: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(local.commands.length, 0);
  assert.equal(remote.commands.length, 1);
  assert.equal(remote.commands[0]?.runtimeMode, "auto-accept-edits");
  assert.equal(remote.commands[0]?.bootstrap.createThread.runtimeMode, "auto-accept-edits");
});
