import { homedir } from "node:os";
import { join } from "node:path";
import { Api, CliError, configuration, discover, expand, fail, withApi, type Environment, type Target } from "./client.js";
import { isConnected, linkedConfig, linkedEnvironments, type LinkedEnvironment } from "./connect.js";

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
      const linked = await linkedEnvironments(connect, undefined, signal), names = connectNames(linked);
      for (const e of linked) entries[Object.hasOwn(entries, names.get(e.environmentId)!) ? `connect-${e.environmentId}` : names.get(e.environmentId)!] = linkedConfig(e, connect);
    } catch (error) { errors.push(safeError("connect", error)); }
  }
  return { entries, errors, connectAuthenticated, localTarget };
}
/** Names come from Connect labels alone, so every machine on the account derives the same name for a host. */
export function connectNames(linked: LinkedEnvironment[]) {
  const slug = (label: string) => label.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const counts = new Map<string, number>();
  for (const e of linked) counts.set(slug(e.label), (counts.get(slug(e.label)) ?? 0) + 1);
  return new Map(linked.map(e => {
    const name = slug(e.label);
    return [e.environmentId, name && counts.get(name) === 1 && name !== "local" && name !== "all" && !name.startsWith("connect-") ? name : `connect-${e.environmentId}`];
  }));
}
/** The recipient resolves this name through Connect; the connect-ID form needs no label lookup. */
export async function replyEnvironment(options: Common, sender: string, recipient: string, signal?: AbortSignal) {
  if (sender === recipient) return "local";
  try {
    const configured = await loadConfig(options);
    const connect = { ...configured.connect, home: configured.environments.local?.home ?? configured.connect?.home };
    // A reply address only shortens the prompt, so a Connect failure must not block delivery.
    if (await isConnected(connect)) return connectNames(await linkedEnvironments(connect, undefined, signal)).get(sender) ?? `connect-${sender}`;
  } catch { /* Fall back to the ID form. */ }
  return `connect-${sender}`;
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
  let name = parsed.name, config = configured.environments[name];
  const connect = { ...configured.connect, home: configured.environments.local?.home ?? configured.connect?.home };
  if (!config && name !== "local" && (name.startsWith("connect-") || await isConnected(connect))) {
    const linked = await linkedEnvironments(connect, undefined, signal), names = connectNames(linked);
    const found = linked.find(e => name === `connect-${e.environmentId}` || name === names.get(e.environmentId));
    if (found) {
      config = linkedConfig(found, connect);
      // Print the canonical name even when the caller used the connect-ID form.
      const alias = names.get(found.environmentId)!;
      name = configured.environments[alias] ? `connect-${found.environmentId}` : alias;
    }
  }
  if (!config && name !== "local") fail("ENVIRONMENT_NOT_FOUND", "Unknown environment. Run environments first.");
  config = { ...config, ...(options.home ? { home: expand(options.home) } : {}) };
  if (options.home && config.url) fail("INVALID_ARGUMENT", "--home cannot override a URL environment.");
  const target = await discover(name, config, signal);
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
