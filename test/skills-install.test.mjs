import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runPostinstall } from "../scripts/postinstall.mjs";
import { installPack, updateSkills } from "../scripts/skills-update.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "t3threads-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const skillPath = ".agents/skills/ship-it/SKILL.md";
const args = ["--yes", "--package=skills@1.5.22", "--", "skills", "add", "jssblck/agents", "-s", "ship-it"];

async function writePack(root, content, name = "ship-it") {
  await mkdir(join(root, ".agents/skills", name), { recursive: true });
  await writeFile(join(root, ".agents/skills", name, "SKILL.md"), content);
  await writeFile(join(root, "skills-lock.json"), JSON.stringify({
    version: 1, skills: { [name]: { source: "fixture", content } },
  }));
}

test("selects only CLI contributor packs and protects tracked skills before downloads", async () => {
  const calls = [];
  await updateSkills(["skills/t3threads/SKILL.md"], async args => { calls.push(args); return 0; });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.flatMap(args => args.filter((_, i) => args[i - 1] === "-s")), [
    "babysit", "code-craft", "gh-stack", "merge-open-prs", "resolve-pr-conflicts",
    "ship-it", "tag-release", "testing-craft", "typesafe-ai",
  ]);
  for (const path of [".agents/skills/ship-it/SKILL.md", ".claude/skills/ship-it"]) {
    await assert.rejects(updateSkills([path], async () => assert.fail("must not install")), /repository-owned/);
  }
  await assert.rejects(updateSkills([], async () => 1), /jssblck\/agents, typesafe-ai\/skills/);
});

test("postinstall supports worktrees, skips CI and packages, and reports failures without throwing", async t => {
  const root = await fixture(t);
  const calls = [];
  const reports = [];
  const options = { root, env: {}, run: (...args) => { calls.push(args); return { status: 1 }; }, report: message => reports.push(message) };
  runPostinstall(options);
  assert.equal(calls.length, 0);
  await writeFile(join(root, ".git"), "gitdir: /unused/worktree\n");
  for (const env of [{ CI: "true" }, { T3THREADS_SKIP_POSTINSTALL: "1" }]) runPostinstall({ ...options, env });
  assert.equal(calls.length, 0);
  runPostinstall(options);
  assert.deepEqual(calls[0].slice(0, 2), [process.execPath, [join(root, "scripts/skills-update.mjs"), "--cached"]]);
  assert.match(reports[0], /npm run skills:update/);
  runPostinstall({ ...options, run: () => ({ status: 0 }) });
  assert.equal(reports.length, 1);
});

test("published hook is a no-op even when installed inside another Git repository", async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  const installed = join(root, "node_modules/t3threads/scripts");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "postinstall.mjs"), await readFile(resolve("scripts/postinstall.mjs")));
  const output = execFileSync(process.execPath, [join(installed, "postinstall.mjs")], {
    cwd: root, env: { ...process.env, CI: "", T3THREADS_SKIP_POSTINSTALL: "" }, encoding: "utf8",
  });
  assert.equal(output, "");
});

test("worktrees reuse complete cached packs, with isolated copies and working Claude links", async t => {
  const root = await fixture(t);
  let downloads = 0;
  const options = {
    cacheRoot: join(root, "cache"), refresh: false,
    run: async (_, cwd) => { downloads++; await writePack(cwd, "upstream"); return 0; },
  };
  const grace = join(root, "grace");
  const ada = join(root, "ada");
  await installPack(args, { ...options, repoRoot: grace });
  await writeFile(join(grace, skillPath), "local edit");
  await installPack(args, { ...options, repoRoot: ada });
  assert.equal(downloads, 1);
  assert.equal(await readFile(join(grace, skillPath), "utf8"), "local edit");
  assert.equal(await readFile(join(ada, ".claude/skills/ship-it/SKILL.md"), "utf8"), "upstream");
  await installPack(args, { ...options, repoRoot: ada });
  assert.equal(downloads, 1);
  assert.equal(await readFile(join(ada, skillPath), "utf8"), "upstream");
});

test("refresh publishes complete snapshots and retains the prior cache after failure", async t => {
  const root = await fixture(t);
  const options = { cacheRoot: join(root, "cache"), repoRoot: join(root, "grace"), refresh: true };
  for (const content of ["old", "new"]) {
    await installPack(args, { ...options, run: async (_, cwd) => { await writePack(cwd, content); return 0; } });
  }
  const before = await readdir(options.cacheRoot);
  assert.equal(await installPack(args, { ...options, run: async (_, cwd) => { await writePack(cwd, "partial"); return 1; } }), 1);
  await assert.rejects(installPack(args, { ...options, run: async () => 0 }), /ENOENT/);
  assert.deepEqual(await readdir(options.cacheRoot), before);
  await installPack(args, { ...options, refresh: false, run: async () => assert.fail("must use cache") });
  assert.equal(await readFile(join(options.repoRoot, skillPath), "utf8"), "new");
});

test("concurrent packs preserve both skills and lock entries", async t => {
  const root = await fixture(t);
  await Promise.all(["ship-it", "typesafe-ai"].map(name => installPack(["-s", name], {
    cacheRoot: join(root, "cache"), repoRoot: join(root, "grace"), refresh: false,
    run: async (_, cwd) => { await writePack(cwd, name, name); return 0; },
  })));
  const lock = JSON.parse(await readFile(join(root, "grace/skills-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.skills), ["ship-it", "typesafe-ai"]);
});

test("unselected upstream skills cannot overwrite local skills", async t => {
  const root = await fixture(t);
  const repoRoot = join(root, "grace");
  await writePack(repoRoot, "local", "unselected");
  await installPack(args, {
    cacheRoot: join(root, "cache"), repoRoot, refresh: false,
    run: async (_, cwd) => {
      await writePack(cwd, "unwanted", "unselected");
      await writePack(cwd, "selected");
      return 0;
    },
  });
  assert.equal(await readFile(join(repoRoot, ".agents/skills/unselected/SKILL.md"), "utf8"), "local");
  const lock = JSON.parse(await readFile(join(repoRoot, "skills-lock.json"), "utf8"));
  assert.equal(lock.skills.unselected.content, "local");
  assert.equal(lock.skills["ship-it"].content, "selected");
});

test("installer version, source, and selection changes invalidate the cache", async t => {
  const root = await fixture(t);
  let downloads = 0;
  const options = {
    cacheRoot: join(root, "cache"), repoRoot: join(root, "grace"), refresh: false,
    run: async (_, cwd) => {
      downloads++;
      await writePack(cwd, "upstream");
      await writePack(cwd, "testing", "testing-craft");
      return 0;
    },
  };
  for (const selection of [args, args.map(arg => arg.replace("1.5.22", "1.5.23")), args.map(arg => arg.replace("jssblck/agents", "another/pack")), [...args, "-s", "testing-craft"]]) {
    await installPack(selection, options);
  }
  assert.equal(downloads, 4);
});
