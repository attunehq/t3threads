import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tarball = resolve(process.argv[2] ?? `${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`);
const directory = mkdtempSync(join(tmpdir(), "t3threads-package-"));
const prefix = join(directory, "global");
const env = { ...process.env, T3THREADS_STATE_DIR: join(directory, "state") };
const options = { cwd: directory, env, encoding: "utf8", timeout: 60_000 };
const npm = args => execFileSync(process.execPath, [process.env.npm_execpath, ...args], options);

try {
  npm(["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const root = npm(["root", "--global", "--prefix", prefix]).trim();
  const installed = join(root, pkg.name);
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  const windows = process.platform === "win32";
  const shim = windows ? join(prefix, "t3threads.cmd") : join(prefix, "bin", "t3threads");
  const help = windows
    ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${shim}" --help"`], options)
    : execFileSync(shim, ["--help"], options);
  assert.match(help, /t3threads/);
  assert.match(help, /overview/);

  const child = spawn(process.execPath, [join(installed, manifest.bin.t3threads), "--mcp"], {
    cwd: directory, env, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  try {
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error(`Installed MCP server timed out: ${stderr}`)), 10_000);
      const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
      child.once("error", error => finish(error));
      child.once("exit", code => finish(Error(`Installed MCP server exited (${code}): ${stderr}`)));
      lines.on("line", line => {
        try {
          const message = JSON.parse(line);
          if (message.id === 1) finish(null, message);
        } catch (error) { finish(error); }
      });
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-test", version: "1" } },
    }) + "\n");
    assert.equal((await response).result?.serverInfo?.name, "t3threads");
  } finally {
    lines.close();
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await closed; } finally { clearTimeout(timer); }
  }
  console.log(`Installed ${pkg.name}@${pkg.version}: global CLI and stdio MCP passed.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
