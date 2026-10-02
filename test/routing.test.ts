import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createCli } from "../src/cli.js";
import { resourceScore, routingPreferences, sharedProjectKey } from "../src/routing.js";
import { fixture } from "./fixture.js";

const cli = createCli();
async function start(config: string, options: Record<string, unknown> = {}) {
  return (await cli.fetch(new Request("http://cli/start", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ config, project: "p1", checkout: "worktree", branch: "main", prompt: "Review the implementation", ...options }),
  }))).json() as Promise<any>;
}

async function pair(t: TestContext) {
  const local = await fixture(t, undefined, "laptop"), remote = await fixture(t, undefined, "desktop");
  Object.assign(local.projects[0]!, { repositoryIdentity: { canonicalKey: "github.com/grace/compiler", rootPath: "/work/grace" } });
  Object.assign(remote.projects[0]!, { id: "p2", workspaceRoot: "/work/ada", repositoryIdentity: { canonicalKey: "github.com/grace/compiler", rootPath: "/work/ada" } });
  remote.resources.cpuCount = 16;
  remote.settings.defaultModelSelection = { instanceId: "codex-work", model: "desktop-model", options: [{ id: "reasoningEffort", value: "high" }] };
  remote.settings.projectSettingsOverrides = { p2: { defaultRuntimeMode: "auto" } };
  const key = `T3_TEST_${crypto.randomUUID().replaceAll("-", "")}`;
  process.env[key] = "test-secret"; t.after(() => { delete process.env[key]; });
  const config = { environments: { local: { home: local.dir, command: local.target.config.command }, remote: { url: remote.target.origin, tokenEnv: key } } };
  await writeFile(local.configPath, JSON.stringify(config));
  const settingsPath = `${local.dir}/userdata/client-settings.json`;
  const preferences = { loadBalancingEnabled: true, loadBalancingWeights: { laptop: 50, desktop: 100 } };
  await writeFile(settingsPath, JSON.stringify(preferences));
  return { local, remote, config, settingsPath, preferences };
}

test("start honors Auto balance with a known source environment and dispatches only to the chosen shared project", async t => {
  const { local, remote, settingsPath } = await pair(t);
  const before = await readFile(settingsPath, "utf8");
  const preview = await start(local.configPath, { env: "local", dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.data.environment, "remote");
  assert.equal(preview.data.command.bootstrap.createThread.projectId, "p2");
  assert.equal(preview.data.command.bootstrap.prepareWorktree.projectCwd, "/work/ada");
  assert.deepEqual(preview.data.command.modelSelection, remote.settings.defaultModelSelection);
  assert.equal(preview.data.command.runtimeMode, "auto");
  assert.equal(local.commands.length + remote.commands.length, 0);
  const result = await start(local.configPath, { env: "local" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.match(result.data.ref, /^remote:/);
  assert.equal(local.commands.length, 0);
  assert.equal(remote.commands.length, 1);
  assert.equal(await readFile(settingsPath, "utf8"), before);
});

test("disabled or absent preferences preserve the selected environment; pinEnv bypasses even unreadable preferences", async t => {
  const { local, remote, settingsPath, preferences } = await pair(t);
  await writeFile(settingsPath, JSON.stringify({ ...preferences, loadBalancingEnabled: false }));
  assert.equal((await start(local.configPath, { dryRun: true })).data.environment, "local");
  assert.equal(remote.rpcMethods.length, 0);
  await rm(settingsPath);
  assert.equal((await start(local.configPath, { dryRun: true })).data.environment, "local");
  await writeFile(settingsPath, JSON.stringify(preferences));
  assert.equal((await start(local.configPath, { dryRun: true })).data.environment, "remote");
  await writeFile(settingsPath, "invalid JSON");
  assert.equal((await start(local.configPath)).error.code, "CLIENT_SETTINGS_UNREADABLE");
  const pinned = await start(local.configPath, { pinEnv: true });
  assert.equal(pinned.ok, true, JSON.stringify(pinned));
  assert.equal(pinned.data.environment, "local");
  assert.equal(local.commands.length, 1);
  assert.equal(remote.commands.length, 0);
});

test("preferences come from the invoking desktop even when env names a remote source", async t => {
  const { local, remote } = await pair(t);
  remote.resources.cpuUtilization = 0.96;
  await writeFile(`${remote.dir}/userdata/client-settings.json`, JSON.stringify({ loadBalancingEnabled: false }));
  const result = await start(local.configPath, { env: "remote", project: "p2", dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.environment, "local");
  assert.equal(result.data.command.bootstrap.createThread.projectId, "p1");
  assert.equal(result.data.routing.sourceEnvironment, "remote");
  assert.deepEqual(result.data.command.modelSelection, local.settings.defaultModelSelection);
});

test("invalid routing preferences fail without dispatch and never include file contents", async t => {
  const { local, remote, settingsPath, preferences } = await pair(t);
  for (const patch of [
    { loadBalancingEnabled: "true" }, { loadBalancingWeights: { laptop: -1 } },
    { loadBalancingWeights: { laptop: 101 } }, { loadBalancingWeights: { laptop: 0.5 } },
    { sidebarProjectGroupingMode: "unknown" }, { sidebarProjectGroupingOverrides: [] },
  ]) {
    await writeFile(settingsPath, JSON.stringify({ ...preferences, ...patch, private: "do-not-print-this" }));
    const result = await start(local.configPath);
    assert.equal(result.error.code, "INVALID_CLIENT_SETTINGS");
    assert.ok(!JSON.stringify(result).includes("do-not-print-this"));
  }
  assert.equal(local.commands.length + remote.commands.length, 0);
});

test("only T3's shared repository group participates, honoring separate and repository-path grouping", async t => {
  const { local, remote, settingsPath, preferences } = await pair(t);
  const settings = await routingPreferences({ config: local.configPath });
  const p = { ...local.projects[0]!, workspaceRoot: "/work/grace/compiler" };
  assert.equal(sharedProjectKey(p, "laptop", settings), "github.com/grace/compiler");
  assert.equal(sharedProjectKey(p, "laptop", { ...settings, sidebarProjectGroupingMode: "repository_path" }), "github.com/grace/compiler::compiler");
  assert.equal(sharedProjectKey(p, "laptop", { ...settings, sidebarProjectGroupingOverrides: { "laptop:/work/grace/compiler": "separate" } }), null);
  assert.equal(sharedProjectKey({ ...p, repositoryIdentity: null }, "laptop", settings), null);
  assert.equal(sharedProjectKey({ ...p, workspaceRoot: "C:\\Work\\Grace\\compiler", repositoryIdentity: { canonicalKey: "repo", rootPath: "c:/work/grace" } }, "windows", { ...settings, sidebarProjectGroupingMode: "repository_path" }), "repo::compiler");

  for (const patch of [
    { sidebarProjectGroupingMode: "separate" },
    { sidebarProjectGroupingOverrides: { "desktop:/work/ada": "separate" } },
  ]) {
    await writeFile(settingsPath, JSON.stringify({ ...preferences, ...patch }));
    assert.equal((await start(local.configPath, { dryRun: true })).data.environment, "local");
  }
  await writeFile(settingsPath, JSON.stringify(preferences));
  Object.assign(remote.projects[0]!, { repositoryIdentity: { canonicalKey: "github.com/ada/unrelated" } });
  assert.equal((await start(local.configPath, { dryRun: true })).data.environment, "local");
  assert.equal(remote.rpcMethods.length, 0);
});

test("Auto balance excludes zero weights, overloaded machines, unavailable providers and unsupported worktrees", async t => {
  const { local, remote, settingsPath, preferences } = await pair(t);
  const localPreview = async () => {
    const result = await start(local.configPath, { dryRun: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.data.environment, "local");
  };
  await writeFile(settingsPath, JSON.stringify({ ...preferences, loadBalancingWeights: { desktop: 0 } }));
  await localPreview();
  assert.equal(remote.rpcMethods.length, 0);
  await writeFile(settingsPath, JSON.stringify(preferences));
  remote.resources.cpuUtilization = 0.95;
  await localPreview();
  remote.resources.cpuUtilization = 0.1;
  remote.resources.availableMemoryBytes = remote.resources.totalMemoryBytes * 0.05;
  await localPreview();
  remote.resources.availableMemoryBytes = 16e9;
  for (const patch of [{ enabled: false }, { installed: false }, { status: "error" }, { auth: { status: "unauthenticated" } }, { availability: "unavailable" }]) {
    const prior = { ...remote.providers[0]! };
    Object.assign(remote.providers[0]!, patch);
    await localPreview();
    Object.assign(remote.providers[0]!, prior);
  }
  remote.target.descriptor.capabilities!.requiredWorktreeBootstrap = false;
  await localPreview();
  assert.equal(local.commands.length + remote.commands.length, 0);
});

test("scoring follows T3's capacity weighting and rejects invalid, stale, or overloaded samples", () => {
  const now = Date.now();
  const resources = { cpuUtilization: 0.5, cpuCount: 8, availableMemoryBytes: 16, totalMemoryBytes: 32 };
  assert.equal(resourceScore(resources, 50, now, now), 100);
  assert.equal(resourceScore({ ...resources, cpuCount: 16 }, 50, now, now), 200);
  assert.equal(resourceScore(resources, 100, now, now), 200);
  for (const patch of [{ cpuUtilization: null }, { cpuUtilization: -1 }, { cpuUtilization: 0.95 }, { cpuUtilization: NaN }, { cpuCount: 0 }, { totalMemoryBytes: 0 }, { availableMemoryBytes: 33 }, { availableMemoryBytes: 1.6 }]) {
    assert.equal(resourceScore({ ...resources, ...patch }, 50, now, now), 0);
  }
  assert.ok(resourceScore({ ...resources, cpuUtilization: 0.949, availableMemoryBytes: 1.61 }, 50, now, now) > 0);
  assert.equal(resourceScore(resources, 0, now, now), 0);
  assert.equal(resourceScore(resources, 50, now - 15_001, now), 0);
  assert.equal(resourceScore(resources, 50, now + 5_001, now), 0);
  assert.equal(resourceScore(resources, 50, now - 15_000, now), 100);
});

test("offline and unreadable machines remain visible; no eligible machine means no dispatch", async t => {
  const { local, remote, config, settingsPath, preferences } = await pair(t);
  remote.rpcFailures.add("server.getHostResources");
  await writeFile(local.configPath, JSON.stringify({ ...config, environments: { ...config.environments, offline: { url: "http://127.0.0.1:1", tokenEnv: config.environments.remote.tokenEnv } } }));
  const preview = await start(local.configPath, { dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.data.environment, "local");
  assert.equal(preview.data.routing.complete, false);
  assert.deepEqual(preview.data.routing.errors.map((e: any) => e.environment).sort(), ["offline", "remote"]);
  await writeFile(settingsPath, JSON.stringify({ ...preferences, loadBalancingWeights: { laptop: 0, desktop: 100 } }));
  const failed = await start(local.configPath);
  assert.equal(failed.error.code, "AUTO_BALANCE_UNAVAILABLE");
  assert.ok(!JSON.stringify(failed).includes("test-secret"));
  assert.equal(local.commands.length + remote.commands.length, 0);
});

test("routed starts keep explicit model and permission overrides and remote worktree branch validation", async t => {
  const { local, remote } = await pair(t);
  const options = [{ id: "reasoningEffort", value: "xhigh" }];
  const preview = await start(local.configPath, { model: "requested-model", modelOptions: options, permission: "full-access", dryRun: true });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.data.environment, "remote");
  assert.deepEqual(preview.data.command.modelSelection, { instanceId: "codex-work", model: "requested-model", options });
  assert.equal(preview.data.command.bootstrap.createThread.runtimeMode, "full-access");
  assert.equal((await start(local.configPath, { provider: "codex-work" })).error.code, "MODEL_REQUIRED");
  assert.equal((await start(local.configPath, { branch: undefined })).error.code, "BRANCH_REQUIRED");
  assert.equal(local.commands.length + remote.commands.length, 0);
});

test("unknown dispatch results identify the chosen environment and never retry on another machine", async t => {
  const { local, remote } = await pair(t);
  remote.control.loseReceipt = true;
  const result = await start(local.configPath);
  assert.equal(result.error.code, "DISPATCH_UNKNOWN");
  assert.ok(result.error.message.includes(`Reference: remote:${remote.commands[0]!.threadId}.`));
  assert.ok(result.error.message.includes(`Command: ${remote.commands[0]!.commandId}.`));
  assert.equal(local.commands.length, 0);
  assert.equal(remote.commands.length, 1);
});
