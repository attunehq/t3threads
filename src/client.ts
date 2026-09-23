import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export class CliError extends Error {
  constructor(public code: string, message: string, public details?: unknown) { super(message); }
}
export function fail(code: string, message: string, details?: unknown): never {
  throw new CliError(code, message, details);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_RESPONSE", "Expected a JSON object.");
  return value as Record<string, unknown>;
}
export const expand = (path: string) => resolve(path.replace(/^~(?=\/|$)/, homedir()));
export const exists = (path: string) => access(path).then(() => true, () => false);
const exec = promisify(execFile);

export type ConnectConfig = { relayUrl?: string; issuerUrl?: string; jwtTemplate?: string; home?: string };
export type Configuration = { environments: Record<string, Environment>; connect?: ConnectConfig };
export type Environment = { home?: string; command?: string[]; url?: string; tokenEnv?: string; connectId?: string; connect?: ConnectConfig; label?: string };
export type Descriptor = { environmentId: string; serverVersion: string; orchestrationProtocolVersion?: number; capabilities?: Record<string, unknown> };
export type Target = { name: string; home?: string; origin: string; descriptor: Descriptor; config: Environment };

export async function run(command: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  try {
    const { stdout, stderr } = await exec(command[0]!, command.slice(1), { ...options, timeout: 30_000, encoding: "utf8", windowsHide: true });
    return { stdout, stderr, status: 0 };
  } catch { return { stdout: "", stderr: "", status: 1 }; }
}

export async function configuration(path: string, explicit = false): Promise<Configuration> {
  if (!await exists(path)) {
    if (explicit) fail("CONFIG_NOT_FOUND", "The specified configuration file does not exist.");
    return { environments: {} };
  }
  let data;
  try { data = object(JSON.parse(await readFile(path, "utf8"))); }
  catch { return fail("INVALID_CONFIG", "Configuration must be a JSON object with an environments map."); }
  const environments = object(data.environments ?? {});
  if (data.connect !== undefined) {
    const connect = object(data.connect);
    if (Object.keys(connect).some(k => !["relayUrl", "issuerUrl", "jwtTemplate", "home"].includes(k)) || Object.values(connect).some(v => typeof v !== "string" || !v.trim())) fail("INVALID_CONFIG", "Invalid Connect configuration.");
    for (const key of ["relayUrl", "issuerUrl"]) if (typeof connect[key] === "string") originOnly(connect[key]);
  }
  for (const [name, raw] of Object.entries(environments)) {
    const e = object(raw);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) fail("INVALID_CONFIG", "Environment names must contain only letters, numbers, underscores, or hyphens.");
    if (Object.keys(e).some(k => !["home", "command", "url", "tokenEnv"].includes(k))) fail("INVALID_CONFIG", `Unknown configuration key in ${name}.`);
    if (["home", "url", "tokenEnv"].some(k => e[k] !== undefined && (typeof e[k] !== "string" || !e[k].trim()))) fail("INVALID_CONFIG", `Invalid configuration in ${name}.`);
    if (e.command !== undefined && (!Array.isArray(e.command) || !e.command.length || e.command.some((x: unknown) => typeof x !== "string" || !x))) fail("INVALID_CONFIG", `command in ${name} must be an argument array.`);
    if (e.url ? !e.tokenEnv || e.home || e.command : e.tokenEnv) fail("INVALID_CONFIG", `Use either home/command or url/tokenEnv in ${name}.`);
  }
  return { environments: environments as Record<string, Environment>, ...(data.connect ? { connect: data.connect as ConnectConfig } : {}) };
}
export async function readConfig(path: string, explicit = false) { return (await configuration(path, explicit)).environments; }

export function originOnly(raw: string) {
  let u: URL;
  try { u = new URL(raw); } catch { return fail("INVALID_URL", "Environment URL is invalid."); }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== "/") fail("INVALID_URL", "Environment URL must be an HTTP(S) origin without credentials, a path, or query parameters.");
  if (u.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) fail("INVALID_URL", "Use HTTPS for remote environments, or a loopback SSH tunnel.");
  return u.origin;
}

export async function discover(name: string, config: Environment, signal?: AbortSignal): Promise<Target> {
  const home = config.url ? undefined : expand(config.home ?? process.env.T3CODE_HOME ?? "~/.t3");
  let origin: unknown = config.url;
  if (home) {
    try { origin = object(JSON.parse(await readFile(join(home, "userdata/server-runtime.json"), "utf8"))).origin; }
    catch { return fail("SERVER_NOT_RUNNING", "Cannot read T3's runtime descriptor. Start T3 Code, or select the correct --home."); }
  }
  if (typeof origin !== "string") fail("INVALID_RUNTIME", "T3's runtime descriptor has no origin.");
  origin = originOnly(origin);
  let response: Response;
  try { response = await fetch(`${origin}/.well-known/t3/environment`, { redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) }); }
  catch { return fail("SERVER_UNREACHABLE", "Cannot reach the selected T3 server."); }
  if (!response.ok) fail("SERVER_UNREACHABLE", `T3 descriptor returned HTTP ${response.status}.`);
  const descriptor = object(await response.json());
  const legacy = descriptor.orchestrationProtocolVersion === undefined && typeof descriptor.serverVersion === "string" && /^0\.0\.(42|43)(-|$)/.test(descriptor.serverVersion);
  if ((!legacy && descriptor.orchestrationProtocolVersion !== 1) || typeof descriptor.environmentId !== "string" || typeof descriptor.serverVersion !== "string") fail("UNSUPPORTED_SERVER", "This CLI requires T3 orchestration protocol 1 or the known 0.0.42/43 legacy descriptor.");
  if (descriptor.capabilities !== undefined) object(descriptor.capabilities);
  return { name, home, origin: origin as string, descriptor: descriptor as Descriptor, config };
}

export async function invocation(target: Target): Promise<{ command: string[]; env: NodeJS.ProcessEnv }> {
  const candidates: { command: string[]; env: NodeJS.ProcessEnv }[] = [];
  if (target.config.command) candidates.push({ command: target.config.command, env: process.env });
  else {
    if (process.platform === "darwin") {
      for (const name of ["T3 Code (Nightly)", "T3 Code"]) {
        for (const apps of ["/Applications", join(homedir(), "Applications")]) {
          const app = join(apps, `${name}.app`, "Contents");
          const binary = join(app, "MacOS", name);
          if (await exists(binary)) candidates.push({ command: [binary, join(app, "Resources/app.asar/apps/server/dist/bin.mjs")], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
        }
      }
    }
    candidates.push({ command: ["t3"], env: process.env });
  }
  for (const candidate of candidates) {
    const result = await run([...candidate.command, "--version"], { env: candidate.env });
    if (result.status === 0 && result.stdout.trim().replace(/^t3 v?/, "") === target.descriptor.serverVersion) return candidate;
  }
  return fail("MATCHING_CLI_REQUIRED", `No T3 CLI matches server ${target.descriptor.serverVersion}. Install the matching CLI or set the environment's command array. No credentials were issued.`);
}

export class Api {
  constructor(public target: Target, private token: string, private signal?: AbortSignal, private authorization?: (method: string, url: string) => Promise<Record<string, string>>) {}
  async request<T = unknown>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.target.origin}${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { ...(this.authorization ? await this.authorization(body === undefined ? "GET" : "POST", `${this.target.origin}${path}`) : { authorization: `Bearer ${this.token}` }), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(this.signal ? [this.signal] : [])]),
      });
    } catch (error) {
      if (error instanceof CliError) throw error;
      return fail("REQUEST_FAILED", body === undefined ? "T3 request failed or was cancelled." : "Dispatch outcome is unknown. Inspect the thread before retrying; the command may have been accepted.");
    }
    // Do not echo server errors: they can contain prompts, paths, or credentials.
    if (!response.ok) fail("HTTP_ERROR", `T3 returned HTTP ${response.status}.`, { status: response.status });
    try { return await response.json() as T; }
    catch { return fail("INVALID_RESPONSE", "T3 returned invalid JSON."); }
  }

  async rpc(method: string, payload: unknown): Promise<unknown> {
    const ticket = object(await this.request("/api/auth/websocket-ticket", {}));
    if (typeof ticket.ticket !== "string" || !ticket.ticket) fail("INVALID_RESPONSE", "T3 returned an empty WebSocket ticket.");
    const url = new URL("/ws", this.target.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket.ticket);
    const signal = AbortSignal.any([AbortSignal.timeout(120_000), ...(this.signal ? [this.signal] : [])]);
    if (signal.aborted) fail("CANCELLED", "The request was cancelled before dispatch.");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      let sent = false;
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        socket.close();
        if (error) reject(error); else resolve(result);
      };
      const disconnected = () => finish(new CliError(sent ? "DISPATCH_UNKNOWN" : "RPC_CONNECT_FAILED", sent ? "Connection ended before the receipt. Inspect the thread before retrying; the command may have been accepted." : "Could not connect to T3's authenticated WebSocket."));
      const aborted = () => { disconnected(); };
      signal.addEventListener("abort", aborted, { once: true });
      socket.addEventListener("open", () => {
        if (settled) return;
        sent = true;
        socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
      });
      socket.addEventListener("error", disconnected);
      socket.addEventListener("close", disconnected);
      socket.addEventListener("message", event => {
        if (settled) return;
        try {
          const parsed: unknown = JSON.parse(String(event.data));
          for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
            const frame = object(raw);
            if (frame._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
            if (frame._tag === "Defect" || frame._tag === "ClientProtocolError") return finish(new CliError("RPC_ERROR", "T3 reported a protocol error. Inspect the thread and server logs."));
            if (frame._tag !== "Exit" || frame.requestId !== id) continue;
            const exit = object(frame.exit);
            if (exit._tag !== "Success") {
              let message = "T3 rejected the command. Inspect the thread and server logs before retrying.";
              if (Array.isArray(exit.cause)) {
                const failure = exit.cause.find(raw => raw?._tag === "Fail" && typeof raw.error?.message === "string");
                if (failure && this.token) message = failure.error.message.replaceAll(this.token, "[redacted]").replaceAll(ticket.ticket, "[redacted]");
              }
              return finish(new CliError("RPC_REJECTED", message));
            }
            return finish(undefined, exit.value);
          }
        } catch { finish(new CliError("INVALID_RESPONSE", "T3 returned an invalid RPC frame. Inspect the thread before retrying.")); }
      });
    });
  }
}

export async function withApi<T>(target: Target, fn: (api: Api) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (target.config.connectId) {
    const { connectApi } = await import("./connect.js");
    return fn(await connectApi(target, signal));
  }
  if (!target.home) {
    const token = process.env[target.config.tokenEnv!];
    if (!token) fail("TOKEN_REQUIRED", "The configured token environment variable is empty.");
    return fn(new Api(target, token, signal));
  }
  const cli = await invocation(target);
  const issued = await run([...cli.command, "auth", "session", "issue", "--json", "--ttl", "1h", "--label", "t3threads", "--subject", "t3threads", "--base-dir", target.home], { env: cli.env });
  if (issued.status !== 0) fail("AUTH_FAILED", "T3 could not issue a temporary CLI session.");
  let session;
  try { session = object(JSON.parse(issued.stdout)); }
  catch { return fail("AUTH_FAILED", "T3 returned an invalid session response."); }
  if (typeof session.sessionId !== "string" || typeof session.token !== "string") fail("AUTH_FAILED", "T3 returned an incomplete session response.");
  try { return await fn(new Api(target, session.token, signal)); }
  finally {
    const result = await run([...cli.command, "auth", "session", "revoke", session.sessionId, "--base-dir", target.home], { env: cli.env }).catch(() => null);
    if (!result || result.status !== 0) console.error("t3threads: temporary session revocation failed; it expires within one hour. Command output still reflects the operation result.");
  }
}
