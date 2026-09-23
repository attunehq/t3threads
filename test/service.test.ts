import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, cp, mkdir, readFile, rm, symlink, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { service, servicePlist, type ServiceOptions } from "../src/service.js";
import { exists, run } from "../src/client.js";
import { State } from "../src/state.js";
import { enqueue, type QueuedMessage } from "../src/queue.js";
import { sendCommand } from "../src/threads.js";
import { runtimeUpdateCheck } from "../src/runtime-update.js";
import { fixture, thread } from "./fixture.js";

test("LaunchAgent installs, updates, reports state, and uninstalls without deleting queued work", async t => {
  const f = await fixture(t), calls: string[][] = [];
  let loaded = false;
  const options: ServiceOptions = {
    platform: "darwin", home: f.dir, uid: 501, node: "/tools/Node & Runtime/node",
    script: join(f.dir, "worker.js"), stateDirectory: join(f.dir, "state"),
    environment: { PATH: "/tools & bin", T3CODE_HOME: "/home/Grace Hopper/.t3", XDG_CONFIG_HOME: "/config", SECRET_TOKEN: "never-copy-this", OPENAI_API_KEY: "never-copy-this-either" },
    async run(command) {
      calls.push(command);
      if (command[1] === "print") return { status: loaded ? 0 : 113, stdout: loaded ? "\tstate = running\n\tpid = 1234\n" : "", stderr: "" };
      if (command[1] === "bootstrap") loaded = true;
      if (command[1] === "bootout") loaded = false;
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  await writeFile(options.script, "");
  assert.equal((await service("status", options)).installed, false);
  const installed = await service("install", options);
  assert.equal(installed.running, true);
  assert.equal(installed.pid, 1234);
  assert.equal(installed.loaded, true);
  const plist = await readFile(installed.path, "utf8");
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /--persistent/);
  assert.match(plist, /Node &amp; Runtime/);
  assert.match(plist, /<array><string>[^<]*T3 Threads<\/string>/);
  assert.match(plist, /Grace Hopper/);
  assert.ok(!plist.includes("SECRET_TOKEN") && !plist.includes("OPENAI_API_KEY") && !plist.includes("never-copy"));
  if (process.platform !== "win32") assert.equal((await stat(installed.path)).mode & 0o777, 0o600);
  if (process.platform !== "win32") {
    const launcher = join(options.stateDirectory, "service", "T3 Threads");
    assert.equal((await stat(launcher)).mode & 0o777, 0o700);
    const args = ["Ada Lovelace", "a;b", '"quoted"'];
    const launched = await run([launcher, process.execPath, "-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args]);
    assert.equal(launched.status, 0);
    assert.deepEqual(JSON.parse(launched.stdout), args, "the launcher must preserve arguments without shell expansion");
  }
  if (process.platform === "darwin") assert.equal((await run(["/usr/bin/plutil", "-lint", installed.path])).status, 0);
  await service("install", options);
  await service("start", options);
  assert.equal(calls.filter(c => c[1] === "bootout").length, 0, "unchanged installs and starts preserve the running worker");
  options.environment.PATH = "/new/bin";
  await service("install", options);
  assert.equal(calls.filter(c => c[1] === "bootout").length, 1);
  assert.deepEqual(calls.find(c => c[1] === "bootout"), ["/bin/launchctl", "bootout", "--wait", "gui/501/com.attune.t3threads"]);
  assert.equal(calls.filter(c => c[1] === "bootstrap").length, 2);
  const savedDefinition = await readFile(installed.path, "utf8");
  const otherOptions = { ...options, stateDirectory: join(f.dir, "other-state"), environment: {} };
  await service("restart", otherOptions);
  assert.equal(calls.filter(c => c[1] === "bootout").length, 2);
  assert.equal(await readFile(installed.path, "utf8"), savedDefinition, "restart preserves the installed configuration");
  loaded = false;
  await service("start", otherOptions);
  assert.equal(loaded, true);
  assert.equal(await readFile(installed.path, "utf8"), savedDefinition);
  const state = new State(options.stateDirectory);
  state.put("message", "preserved", { status: "pending" });
  const removed = await service("uninstall", options);
  assert.equal(removed.installed, false);
  assert.equal(removed.loaded, false);
  assert.equal(removed.running, false);
  assert.equal(await exists(join(options.stateDirectory, "service", "T3 Threads")), false);
  assert.ok(state.get("message", "preserved"));
  await service("uninstall", options);
});

test("service rejects unsupported platforms and missing builds and surfaces launchctl failures", async t => {
  const f = await fixture(t);
  const options: ServiceOptions = {
    platform: "darwin", home: f.dir, uid: 501, node: process.execPath,
    script: join(f.dir, "missing.js"), stateDirectory: join(f.dir, "state"), environment: {},
    async run() { return { status: 1, stdout: "", stderr: "" }; },
  };
  await assert.rejects(service("install", { ...options, platform: "linux" }), { code: "UNSUPPORTED_PLATFORM" });
  await assert.rejects(service("install", options), { code: "SERVICE_BUILD_REQUIRED" });
  await assert.rejects(service("start", options), { code: "SERVICE_NOT_INSTALLED" });
  await assert.rejects(service("restart", options), { code: "SERVICE_NOT_INSTALLED" });
  assert.equal(await exists(join(f.dir, "Library")), false);
  await writeFile(options.script, "");
  await assert.rejects(service("install", options), { code: "SERVICE_FAILED" });
  const status = await service("status", options);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, false);
  assert.match(servicePlist(options), /\/usr\/local\/bin:/);
});

test("package replacement detection covers same-version upgrades and waits for stable, readable files", async t => {
  const f = await fixture(t), root = join(f.dir, "runtime"), dir = join(root, "dist");
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, "package.json"), '{"version":"0.2.0"}');
  const script = join(dir, "worker.js"), dependency = join(dir, "queue.js");
  await writeFile(script, "// worker");
  await writeFile(dependency, "// original queue");
  const changed = await runtimeUpdateCheck(script);
  assert.equal(await changed(0), false);
  await writeFile(dependency, "// upgraded queue");
  assert.equal(await changed(1000), false, "checks are spaced out");
  assert.equal(await changed(5000), false, "one observation does not establish a settled update");
  await rm(script);
  assert.equal(await changed(10000), false, "a temporarily missing entry point must not trigger a restart");
  await writeFile(script, "// worker");
  assert.equal(await changed(15000), false);
  assert.equal(await changed(20000), true);
  const unchanged = await runtimeUpdateCheck(script);
  await writeFile(dependency, "// upgraded queue");
  assert.equal(await unchanged(0), false);
  assert.equal(await unchanged(5000), false, "reinstalling identical code does not restart the worker");
  await writeFile(join(root, "package.json"), '{"version":"0.3.0"}');
  assert.equal(await unchanged(10000), false);
  assert.equal(await unchanged(15000), true);
});

test("a persistent worker exits gracefully after a package update and its successor delivers the existing queue", { timeout: 30_000 }, async t => {
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
    await ended; clearTimeout(timer);
  });
  const f = await fixture(t), root = join(f.dir, "runtime"), state = new State(join(f.dir, "state"));
  await cp("src", join(root, "src"), { recursive: true });
  await cp("package.json", join(root, "package.json"));
  await symlink(join(process.cwd(), "node_modules"), join(root, "node_modules"), "junction");
  f.stored.get("t1")!.latestTurn = { state: "running" };
  const queued = enqueue({ ref: "local:t1", environmentId: "test-env", options: { config: f.configPath }, command: sendCommand(thread, "Continue after upgrade") }, state);
  const start = () => spawn(process.execPath, ["--import", "tsx", join(root, "src", "worker.ts"), "--persistent"], {
    env: { ...process.env, T3THREADS_STATE_DIR: state.directory }, stdio: "ignore",
  });
  child = start();
  const readyDeadline = Date.now() + 5000;
  while (!state.get("worker", "lease") && Date.now() < readyDeadline) await delay(50);
  assert.equal(state.get<{ pid: number }>("worker", "lease")?.pid, child.pid);
  const exited = once(child, "exit");
  await appendFile(join(root, "src", "threads.ts"), "\n// Updated package payload.\n");
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(state.get("worker", "lease"), undefined);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "pending");
  f.stored.get("t1")!.latestTurn = { state: "completed" };
  child = start();
  const deadline = Date.now() + 8000;
  while (state.get<QueuedMessage>("message", queued.id)?.status !== "accepted" && Date.now() < deadline) await delay(50);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.equal(f.commands.length, 1);
});

test("persistent worker stays ready while idle, delivers later enqueues, and handles shutdown leases", { timeout: 15_000 }, async t => {
  let child: ReturnType<typeof spawn> | undefined;
  t.after(async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 3000);
    await ended; clearTimeout(timer);
  });
  const f = await fixture(t), state = new State(join(f.dir, "state"));
  state.put("worker", "lease", { owner: "existing-worker", pid: process.pid });
  child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts", "--persistent"], {
    env: { ...process.env, T3THREADS_STATE_DIR: state.directory }, stdio: "ignore",
  });
  await delay(1200);
  assert.equal(state.get<{ pid: number }>("worker", "lease")?.pid, process.pid, "the service must wait for an existing worker");
  assert.equal(child.exitCode, null);
  state.remove("worker", "lease");
  const deadline = Date.now() + 5000;
  while (!state.get("worker", "lease") && Date.now() < deadline) await delay(50);
  assert.equal(state.get<{ pid: number }>("worker", "lease")?.pid, child.pid);
  await delay(1200);
  assert.equal(child.exitCode, null, "empty queues must not terminate the service");
  const queued = enqueue({ ref: "local:t1", environmentId: "test-env", options: { config: f.configPath }, command: sendCommand(thread, "Continue") }, state);
  const deliveryDeadline = Date.now() + 5000;
  while (state.get<QueuedMessage>("message", queued.id)?.status !== "accepted" && Date.now() < deliveryDeadline) await delay(50);
  assert.equal(state.get<QueuedMessage>("message", queued.id)?.status, "accepted");
  assert.equal(f.commands.length, 1);
  assert.equal(child.exitCode, null);
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  await ended;
  if (process.platform === "win32") {
    // Windows force-terminates on SIGTERM; the next worker must reclaim the stale lease.
    assert.equal(state.get<{ pid: number }>("worker", "lease")?.pid, child.pid);
    child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
      env: { ...process.env, T3THREADS_STATE_DIR: state.directory }, stdio: "ignore",
    });
    await once(child, "exit");
  }
  assert.equal(state.get("worker", "lease"), undefined);
  assert.equal(child.exitCode, 0);
});
