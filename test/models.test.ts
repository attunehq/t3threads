import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { createCli } from "../src/cli.js";
import { type Model } from "../src/threads.js";
import { fixture } from "./fixture.js";

const machine: Model = { instanceId: "codex-work", model: "machine-model", options: [{ id: "reasoningEffort", value: "high" }, { id: "serviceTier", value: "default" }] };
const project: Model = { instanceId: "claude-work", model: "project-model", options: [{ id: "effort", value: "max" }] };
const cli = createCli();
async function start(config: string, options: Record<string, unknown> = {}) {
  return (await cli.fetch(new Request("http://cli/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, project: "p1", checkout: "current", prompt: "Review", dryRun: true, ...options }),
  }))).json() as Promise<any>;
}
function expectModel(result: any, model: Model) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.data.command.modelSelection, model);
  assert.deepEqual(result.data.command.bootstrap.createThread.modelSelection, model);
}

test("start inherits machine and project models with all options from one settings snapshot", async t => {
  const f = await fixture(t);
  f.projects[0]!.defaultModelSelection = null;
  f.settings.defaultModelSelection = machine;
  expectModel(await start(f.configPath), machine);
  assert.deepEqual(f.rpcMethods, ["server.getSettings"]);
  f.settings.providerInstances = { "codex-work": { driver: "codex", enabled: true }, "claude-work": { driver: "claudeAgent", enabled: true } };
  f.settings.projectSettingsOverrides = { p1: { defaultModelSelection: project } };
  expectModel(await start(f.configPath, { checkout: "worktree", branch: "main" }), project);
  f.settings.projectSettingsOverrides = {};
  expectModel(await start(f.configPath), machine);
  assert.equal(f.commands.length, 0);
});

test("folded settings ignore stale catalog models; pre-fold settings honor legacy models below current overrides", async t => {
  const f = await fixture(t);
  const legacy = f.projects[0]!.defaultModelSelection!;
  f.settings.defaultModelSelection = machine;
  expectModel(await start(f.configPath), machine);
  for (const folded of [false, undefined]) {
    f.settings.projectSettingsFolded = folded;
    expectModel(await start(f.configPath), legacy);
    f.settings.projectSettingsOverrides = { p1: { defaultModelSelection: machine } };
    expectModel(await start(f.configPath), machine);
    f.settings.projectSettingsOverrides = {};
  }
});

test("disabled or missing project providers defer to machine model; unusable machine providers fail", async t => {
  const f = await fixture(t);
  f.settings.defaultModelSelection = machine;
  f.settings.projectSettingsOverrides = { p1: { defaultModelSelection: project } };
  for (const provider of [undefined, { enabled: false }, { enabled: true, config: { enabled: false } }, { enabled: false, config: { enabled: true } }]) {
    f.settings.providerInstances = { "codex-work": { enabled: true }, "claude-work": provider };
    expectModel(await start(f.configPath), machine);
  }
  f.settings.providerInstances = { "codex-work": { enabled: false } };
  const result = await start(f.configPath, { dryRun: false });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MODEL_DISABLED");
  assert.equal(f.commands.length, 0);
});

test("explicit model selection bypasses inheritance; model-only changes keep provider and avoid stale options", async t => {
  const f = await fixture(t);
  f.settings.defaultModelSelection = machine;
  expectModel(await start(f.configPath, { model: machine.model }), machine);
  expectModel(await start(f.configPath, { model: "other-model" }), { instanceId: machine.instanceId, model: "other-model" });
  f.control.reject = true;
  f.rpcMethods.length = 0;
  expectModel(await start(f.configPath, { provider: "explicit-provider", model: "explicit-model", permission: "auto" }), { instanceId: "explicit-provider", model: "explicit-model" });
  assert.equal(f.rpcMethods.length, 0);
  const invalid = await start(f.configPath, { provider: "explicit-provider", dryRun: false });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, "MODEL_REQUIRED");
  assert.equal(f.commands.length, 0);
});

test("provider enablement follows envelope, config, driver defaults, and legacy provider settings", async t => {
  const f = await fixture(t);
  f.settings.defaultModelSelection = machine;
  f.settings.projectSettingsOverrides = { p1: { defaultModelSelection: project } };
  for (const [provider, enabled] of [
    [{ driver: "claudeAgent" }, true],
    [{ driver: "cursor" }, false],
    [{ driver: "cursor", config: { enabled: true } }, true],
    [{ driver: "custom-driver" }, true],
    [{ driver: "custom-driver", config: "opaque" }, true],
    [{ driver: "cursor", config: { enabled: "invalid" } }, false],
  ] as const) {
    f.settings.providerInstances = { "codex-work": { enabled: true }, "claude-work": provider };
    expectModel(await start(f.configPath), enabled ? project : machine);
  }
  f.settings.providerInstances = {};
  f.settings.providers = { "codex-work": { enabled: true }, "claude-work": { enabled: true } };
  expectModel(await start(f.configPath), project);
});

test("missing, cleared, and malformed models fail before dispatch instead of resurrecting stale defaults", async t => {
  const f = await fixture(t);
  for (const value of [undefined, null, {}, { instanceId: "codex-work", model: "" }, { instanceId: " ", model: "test" }, "invalid"]) {
    f.settings.defaultModelSelection = value;
    const result = await start(f.configPath, { dryRun: false });
    assert.equal(result.ok, false, String(JSON.stringify(value)));
    assert.equal(result.error.code, "MODEL_REQUIRED");
  }
  f.settings.defaultModelSelection = machine;
  for (const value of [null, {}, "invalid"]) {
    f.settings.projectSettingsOverrides = { p1: { defaultModelSelection: value } };
    const result = await start(f.configPath, { dryRun: false });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "MODEL_REQUIRED");
  }
  assert.equal(f.commands.length, 0);
});

test("remote model and permissions come from the destination, and resolved options survive dispatch", async t => {
  const local = await fixture(t, undefined, "local-env");
  const remote = await fixture(t, undefined, "remote-env");
  local.settings.defaultModelSelection = machine;
  remote.settings.defaultModelSelection = project;
  remote.settings.defaultRuntimeMode = "auto";
  remote.settings.providerInstances = { "claude-work": { driver: "claudeAgent", enabled: true } };
  const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret";
  t.after(() => { delete process.env[key]; });
  await writeFile(local.configPath, JSON.stringify({ environments: {
    local: { home: local.dir, command: local.target.config.command },
    remote: { url: remote.target.origin, tokenEnv: key },
    alternate: { home: remote.dir, command: remote.target.config.command },
  } }));
  for (const options of [{ env: "remote" }, { env: "alternate" }, { home: remote.dir }]) {
    expectModel(await start(local.configPath, options), project);
  }
  assert.equal(local.rpcMethods.length, 0);
  const result = await start(local.configPath, { env: "remote", dryRun: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(remote.commands[0]?.modelSelection, project);
  assert.deepEqual(remote.commands[0]?.bootstrap.createThread.modelSelection, project);
  assert.equal(remote.commands[0]?.runtimeMode, "auto");
  assert.equal(local.commands.length, 0);
});
