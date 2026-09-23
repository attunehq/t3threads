import { homedir } from "node:os";
import { join } from "node:path";
import { Api, CliError, configuration, discover, expand, fail, withApi, type Environment, type Target } from "./client.js";
import { isConnected, linkedConfig, linkedEnvironments } from "./connect.js";

export type Common = { env?: string; home?: string; config?: string };
export const loadConfig = (options: Common) => configuration(expand(options.config ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "t3threads/config.json")), options.config !== undefined);
export async function environments(options: Common, signal?: AbortSignal) {
  const c = await loadConfig(options);
  const connect = { ...c.connect, home: options.home ?? c.environments.local?.home ?? c.connect?.home };
  const localTarget = await discover("local", { ...c.environments.local, ...(options.home ? { home: options.home } : {}) }, signal);
  const entries: Record<string, Environment> = { local: { ...c.environments.local, ...(options.home ? { home: expand(options.home) } : {}) }, ...c.environments };
  if (options.home) entries.local = { ...entries.local, home: expand(options.home) };
  const errors: { environment: string; code: string; message: string }[] = [];
  const connectAuthenticated = await isConnected(connect);
  if (connectAuthenticated) {
    try {
      for (const e of await linkedEnvironments(connect, undefined, signal)) entries[`connect-${e.environmentId}`] = linkedConfig(e, connect);
    } catch (error) { errors.push(safeError("connect", error)); }
  }
  return { entries, errors, connectAuthenticated, localTarget };
}
export function parseRef(ref: string, environment = "local") {
  const index = ref.indexOf(":");
  const name = index < 0 ? environment : ref.slice(0, index), id = index < 0 ? ref : ref.slice(index + 1);
  if (!name || name === "all" || !id || /[\s/:?#]/.test(id)) fail("INVALID_ARGUMENT", "Use a concrete environment:thread-ID reference.");
  return { name, id };
}
export async function targetFor(options: Common, ref?: string, signal?: AbortSignal) {
  const parsed = ref ? parseRef(ref, options.env) : { name: options.env ?? "local", id: undefined };
  if (ref?.includes(":") && options.env && options.env !== parsed.name) fail("ENVIRONMENT_MISMATCH", "The thread reference and --env select different environments.");
  if (parsed.name === "all") fail("INVALID_ARGUMENT", "This operation needs one environment, not --env all.");
  if (options.home && parsed.name !== "local") fail("INVALID_ARGUMENT", "--home only applies to local.");
  const configured = await loadConfig(options);
  if (parsed.name !== "local") await discover("local", configured.environments.local ?? {}, signal);
  let config = configured.environments[parsed.name];
  if (parsed.name.startsWith("connect-") && !config) {
    const connect = { ...configured.connect, home: configured.environments.local?.home ?? configured.connect?.home };
    const linked = await linkedEnvironments(connect, undefined, signal);
    const found = linked.find(e => `connect-${e.environmentId}` === parsed.name);
    if (found) config = linkedConfig(found, connect);
  }
  if (!config && parsed.name !== "local") fail("ENVIRONMENT_NOT_FOUND", "Unknown environment. Run environments first.");
  config = { ...config, ...(options.home ? { home: expand(options.home) } : {}) };
  if (options.home && config.url) fail("INVALID_ARGUMENT", "--home cannot override a URL environment.");
  const target = await discover(parsed.name, config, signal);
  if (config.connectId && config.connectId !== target.descriptor.environmentId) fail("CONNECT_IDENTITY_MISMATCH", "The discovered server does not match the linked environment.");
  return { target, id: parsed.id };
}
export function safeError(environment: string, error: unknown) {
  return { environment, code: error instanceof CliError ? error.code : "OPERATION_FAILED", message: error instanceof CliError ? error.message : "The operation failed." };
}
export const context = (target: Target) => ({ environment: target.name, environmentId: target.descriptor.environmentId, serverVersion: target.descriptor.serverVersion });

export async function across<T>(options: Common, fn: (api: Api, target: Target) => Promise<T>, signal?: AbortSignal) {
  if (options.env !== "all") {
    const { target } = await targetFor(options, undefined, signal);
    return { results: [await withApi(target, api => fn(api, target), signal)], errors: [], complete: true };
  }
  const found = await environments(options, signal);
  const errors = [...found.errors], results: T[] = [], seen = new Set<string>();
  // Resolve local first so a linked local host is visited once, through loopback.
  const entries = Object.entries(found.entries).filter(([, config]) => config.connectId !== found.localTarget.descriptor.environmentId);
  const resolved = await Promise.allSettled(entries.map(([name, config]) => name === "local" ? Promise.resolve(found.localTarget) : discover(name, config, signal)));
  const targets: Target[] = [];
  resolved.forEach((result, index) => {
    if (result.status === "rejected") { errors.push(safeError(entries[index]![0], result.reason)); return; }
    const target = result.value;
    if (target.config.connectId && target.config.connectId !== target.descriptor.environmentId) { errors.push(safeError(target.name, new CliError("CONNECT_IDENTITY_MISMATCH", "Linked environment identity changed."))); return; }
    if (!seen.has(target.descriptor.environmentId)) { targets.push(target); seen.add(target.descriptor.environmentId); }
  });
  // Bounded fanout keeps a large account from spawning one auth process per host at once.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (next < targets.length) {
      const target = targets[next++]!;
      try { results.push(await withApi(target, api => fn(api, target), signal)); }
      catch (error) { errors.push(safeError(target.name, error)); }
    }
  }));
  return { results, errors, complete: errors.length === 0 };
}
