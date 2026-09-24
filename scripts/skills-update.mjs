// Adapted from attunehq/sorted: cache selected contributor packs across worktrees.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKS = [
  {
    source: "jssblck/agents",
    skills: [
      "babysit", "code-craft", "gh-stack", "merge-open-prs",
      "resolve-pr-conflicts", "ship-it", "tag-release", "testing-craft",
    ],
  },
  { source: "typesafe-ai/skills", skills: ["typesafe-ai"] },
];

function packInstallArgs(source, skills) {
  return [
    "--yes", "--package=skills@1.5.22", "--", "skills", "add", source,
    ...skills.flatMap(skill => ["-s", skill]),
    "-a", "claude-code", "-a", "codex", "-y",
  ];
}

export async function updateSkills(trackedPaths, run) {
  for (const { skills } of PACKS) {
    for (const skill of skills) {
      const paths = [`.agents/skills/${skill}`, `.claude/skills/${skill}`];
      if (trackedPaths.some(path => paths.some(base => path === base || path.startsWith(`${base}/`)))) {
        throw new Error(`Refusing to overwrite repository-owned skill: ${skill}`);
      }
    }
  }
  const results = await Promise.allSettled(PACKS.map(({ source, skills }) => run(packInstallArgs(source, skills))));
  const failed = results.flatMap((result, index) => {
    if (result.status === "fulfilled" && result.value === 0) return [];
    const source = PACKS[index].source;
    return [result.status === "rejected" ? `${source}: ${String(result.reason)}` : source];
  });
  if (failed.length > 0) {
    throw new Error(`Skill update failed for ${failed.join(", ")}; inspect the installed files before retrying.`);
  }
}

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { skills: {}, version: 1 };
    throw error;
  }
}

async function importPackInstall(sourceRoot, repoRoot, names) {
  const incoming = await readLock(join(sourceRoot, "skills-lock.json"));
  const current = await readLock(join(repoRoot, "skills-lock.json"));
  await mkdir(join(repoRoot, ".agents/skills"), { recursive: true });
  await mkdir(join(repoRoot, ".claude/skills"), { recursive: true });
  for (const name of names) {
    const destination = join(repoRoot, ".agents/skills", name);
    await rm(destination, { force: true, recursive: true });
    await cp(join(sourceRoot, ".agents/skills", name), destination, { recursive: true });
    const claudeLink = join(repoRoot, ".claude/skills", name);
    await rm(claudeLink, { force: true, recursive: true });
    await symlink(
      process.platform === "win32" ? destination : `../../.agents/skills/${name}`,
      claudeLink,
      process.platform === "win32" ? "junction" : "dir",
    );
    current.skills[name] = incoming.skills[name];
  }
  const skills = Object.fromEntries(Object.entries(current.skills).sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(join(repoRoot, "skills-lock.json"), `${JSON.stringify({
    skills, version: Math.max(current.version, incoming.version),
  }, null, 2)}\n`);
}

function spawnInstaller(args, cwd) {
  return new Promise(resolve => {
    // Invoke npm through Node so Windows does not need a shell for npm.cmd.
    const child = spawn(process.execPath, [process.env.npm_execpath, "exec", ...args], { cwd, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", resolve);
  });
}

// Packs download independently but share a destination lock file.
let importChain = Promise.resolve();
function serializeImport(work) {
  const run = importChain.then(work, work);
  importChain = run.then(() => undefined, () => undefined);
  return run;
}

function selectedSkills(args) {
  return args.filter((_, index) => args[index - 1] === "-s");
}

async function checkPack(root, args) {
  await Promise.all(selectedSkills(args).map(name => access(join(root, ".agents/skills", name, "SKILL.md"))));
  await access(join(root, "skills-lock.json"));
}

async function cachedPack(path, args) {
  try {
    const root = join(dirname(path), (await readFile(path, "utf8")).trim());
    await checkPack(root, args);
    return root;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function installPack(args, { cacheRoot, repoRoot, refresh, run = spawnInstaller }) {
  const key = createHash("sha256").update(JSON.stringify(args)).digest("hex");
  const current = join(cacheRoot, key);
  const cached = refresh ? undefined : await cachedPack(current, args);
  if (cached !== undefined) {
    await serializeImport(() => importPackInstall(cached, repoRoot, selectedSkills(args)));
    return 0;
  }
  await mkdir(cacheRoot, { recursive: true });
  const snapshot = await mkdtemp(`${current}-`);
  const pointer = `${snapshot}.pointer`;
  let published = false;
  try {
    const status = await run(args, snapshot);
    if (status === 0) {
      await checkPack(snapshot, args);
      // Publish a complete snapshot atomically; other worktrees may still be
      // reading the previous snapshot. A text pointer works without symlink rights.
      await writeFile(pointer, basename(snapshot));
      await rename(pointer, current);
      published = true;
      await serializeImport(() => importPackInstall(snapshot, repoRoot, selectedSkills(args)));
    }
    return status;
  } finally {
    await rm(pointer, { force: true });
    if (!published) await rm(snapshot, { force: true, recursive: true });
  }
}

async function main() {
  process.chdir(fileURLToPath(new URL("..", import.meta.url)));
  const tracked = spawnSync("git", ["ls-files", "-z", "--", ".agents/skills", ".claude/skills"], { encoding: "utf8" });
  if (tracked.status !== 0) {
    throw new Error("Could not establish skill ownership; no skills were updated.");
  }
  const common = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
  if (common.status !== 0) {
    throw new Error("Could not find the shared Git directory for the skill cache.");
  }
  await updateSkills(tracked.stdout.split("\0").filter(Boolean), args => installPack(args, {
    cacheRoot: join(common.stdout.trim(), "t3threads-skills-cache", "v1"),
    repoRoot: process.cwd(),
    refresh: !process.argv.includes("--cached"),
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
