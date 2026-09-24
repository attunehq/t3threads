import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runPostinstall({
  root = dirname(dirname(fileURLToPath(import.meta.url))),
  env = process.env,
  run = spawnSync,
  report = console.error,
} = {}) {
  // Published packages have no checkout. Never install contributor skills there.
  if (env.CI || env.T3THREADS_SKIP_POSTINSTALL || !existsSync(join(root, ".git"))) return;
  const result = run(process.execPath, [join(root, "scripts/skills-update.mjs"), "--cached"], {
    cwd: root, env, stdio: "inherit",
  });
  if (result.status !== 0) {
    report("Skills installation failed; run npm run skills:update to retry.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runPostinstall();
}
