import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, fail, run } from "./client.js";
import { State, statePath } from "./state.js";

const label = "com.attune.t3threads";
type CommandRunner = typeof run;
export type ServiceOptions = {
  platform: string; home: string; uid: number; node: string; script: string;
  stateDirectory: string; environment: NodeJS.ProcessEnv; run: CommandRunner;
};
const defaults = (): ServiceOptions => ({
  platform: process.platform, home: homedir(), uid: process.getuid?.() ?? -1,
  node: process.execPath, script: fileURLToPath(new URL("./worker.js", import.meta.url)),
  stateDirectory: statePath(), environment: process.env, run,
});
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const launcherPath = (options: ServiceOptions) => join(options.stateDirectory, "service", "T3 Threads");

export function servicePlist(options: ServiceOptions) {
  const environment: Record<string, string> = {
    PATH: options.environment.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    T3THREADS_STATE_DIR: options.stateDirectory,
  };
  // Preserve configuration locations, not shell credentials or unrelated environment variables.
  for (const key of ["T3CODE_HOME", "XDG_CONFIG_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) {
    if (options.environment[key]) environment[key] = options.environment[key]!;
  }
  const log = join(options.stateDirectory, "service.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${[launcherPath(options), options.node, options.script, "--persistent"].map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(options.home)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

export async function service(action: "install" | "start" | "restart" | "status" | "uninstall", options = defaults()) {
  if (options.platform !== "darwin") fail("UNSUPPORTED_PLATFORM", "Service installation currently supports macOS LaunchAgents.");
  const path = join(options.home, "Library", "LaunchAgents", `${label}.plist`);
  const domain = `gui/${options.uid}`, target = `${domain}/${label}`;
  const invoke = (...args: string[]) => options.run(["/bin/launchctl", ...args]);
  const check = async (...args: string[]) => {
    if ((await invoke(...args)).status !== 0) fail("SERVICE_FAILED", `launchctl ${args[0]} failed for ${label}. Inspect t3threads service status and ${path}.`);
  };
  const status = async () => {
    const result = await invoke("print", target);
    return { label, installed: await exists(path), loaded: result.status === 0,
      running: result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout),
      pid: Number(result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null,
      path,
      connection: new State(options.stateDirectory).get("connection-health", "native") ?? null,
    };
  };
  if (action === "status") return status();
  if (action === "start" || action === "restart") {
    const current = await status();
    if (!current.installed) fail("SERVICE_NOT_INSTALLED", "Run t3threads service install first.");
    if (action === "start" && current.loaded) {
      if (!current.running && !current.pid) await check("kickstart", target);
      return status();
    }
    if (current.loaded) await check("bootout", "--wait", target);
    await check("enable", target);
    await check("bootstrap", domain, path);
    return status();
  }
  if (action === "uninstall") {
    if ((await status()).loaded) await check("bootout", "--wait", target);
    await rm(path, { force: true });
    await rm(launcherPath(options), { force: true });
    return status();
  }
  if (!await exists(options.script)) fail("SERVICE_BUILD_REQUIRED", "Install from a built t3threads package. The service needs its compiled worker.js at a permanent path.");
  const definition = servicePlist(options), launcher = '#!/bin/sh\nexec "$@"\n';
  if (await exists(path) && await exists(launcherPath(options)) && await readFile(path, "utf8") === definition && await readFile(launcherPath(options), "utf8") === launcher) {
    return service("start", options);
  }
  await mkdir(dirname(path), { recursive: true });
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(launcherPath(options)), { recursive: true, mode: 0o700 });
  // Login Items attributes a direct Node launch to Node.js Foundation. A named
  // helper identifies this service, and exec preserves launchd's PID and signals.
  await writeFile(launcherPath(options), launcher, { mode: 0o700 });
  await chmod(launcherPath(options), 0o700);
  const log = await open(join(options.stateDirectory, "service.log"), "a", 0o600);
  await log.close();
  await chmod(join(options.stateDirectory, "service.log"), 0o600);
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, definition, { mode: 0o600 });
    // Wait for teardown before replacing the plist and bootstrapping its successor.
    if ((await status()).loaded) await check("bootout", "--wait", target);
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
  await check("enable", target);
  await check("bootstrap", domain, path);
  return status();
}
