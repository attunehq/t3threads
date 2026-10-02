import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "incur";
import { expand, fail, object, withApi, type Target } from "./client.js";
import { across, loadConfig, safeError, type Common } from "./environments.js";
import { catalog, permissionSelection, selection, type PermissionMode, type Project } from "./threads.js";

const grouping = z.enum(["repository", "repository_path", "separate"]);
const preferencesSchema = z.object({
  loadBalancingEnabled: z.boolean().default(false),
  loadBalancingWeights: z.record(z.string(), z.number().int().min(0).max(100)).default({}),
  sidebarProjectGroupingMode: grouping.default("repository"),
  sidebarProjectGroupingOverrides: z.record(z.string(), grouping).default({}),
});
type Preferences = z.infer<typeof preferencesSchema>;
type StartOptions = Common & { pinEnv?: boolean; checkout: "worktree" | "current"; provider?: string; model?: string; permission?: PermissionMode };

export async function routingPreferences(options: Common): Promise<Preferences> {
  const config = await loadConfig(options);
  const home = expand(options.home ?? config.environments.local?.home ?? process.env.T3CODE_HOME ?? "~/.t3");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(home, "userdata/client-settings.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return preferencesSchema.parse({});
    return fail("CLIENT_SETTINGS_UNREADABLE", "Cannot read T3's local desktop Auto balance preferences. Fix client-settings.json or use --pin-env.");
  }
  const parsed = preferencesSchema.safeParse(raw);
  if (!parsed.success) fail("INVALID_CLIENT_SETTINGS", "T3's desktop Auto balance preferences are invalid. Fix them in T3 or use --pin-env.");
  return parsed.data;
}

function normalizedPath(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/, "") || "/";
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
}

// T3 groups shared projects by repository identity, optionally including their path within it.
export function sharedProjectKey(project: Project, environmentId: string, settings: Preferences): string | null {
  const root = normalizedPath(project.workspaceRoot);
  const mode = settings.sidebarProjectGroupingOverrides[`${environmentId}:${root}`] ?? settings.sidebarProjectGroupingMode;
  const identity = project.repositoryIdentity;
  if (mode === "separate" || typeof identity?.canonicalKey !== "string" || !identity.canonicalKey) return null;
  if (mode === "repository" || typeof identity.rootPath !== "string") return identity.canonicalKey;
  const repositoryRoot = normalizedPath(identity.rootPath);
  const prefix = `${repositoryRoot}${repositoryRoot.includes("\\") ? "\\" : "/"}`;
  const relative = root.startsWith(prefix) ? root.slice(prefix.length).replaceAll("\\", "/") : "";
  return relative ? `${identity.canonicalKey}::${relative}` : identity.canonicalKey;
}

// Match T3's weighted free-CPU/free-memory score and its overload/freshness thresholds.
export function resourceScore(value: unknown, weight: number, receivedAt: number, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isFinite(weight) || weight <= 0 ||
      !Number.isFinite(receivedAt) || now - receivedAt > 15_000 || receivedAt > now + 5_000) return 0;
  const { cpuUtilization, cpuCount, availableMemoryBytes, totalMemoryBytes } = value as Record<string, unknown>;
  if ([cpuUtilization, cpuCount, availableMemoryBytes, totalMemoryBytes].some(n => typeof n !== "number" || !Number.isFinite(n))) return 0;
  const cpu = cpuUtilization as number, cores = cpuCount as number, available = availableMemoryBytes as number, total = totalMemoryBytes as number;
  if (cpu < 0 || cpu >= 0.95 || cores <= 0 || total <= 0 || available > total || available / total <= 0.05) return 0;
  return weight * cores * (1 - cpu) * (available / total);
}

export async function routeStart(options: StartOptions, source: { target: Target; project: Project }, signal?: AbortSignal) {
  if (options.pinEnv) return;
  const preferences = await routingPreferences(options);
  if (!preferences.loadBalancingEnabled) return;
  const key = sharedProjectKey(source.project, source.target.descriptor.environmentId, preferences);
  if (key === null) return;

  const discovered = await across({ ...options, env: "all" }, async (api, target) => ({ target, projects: (await catalog(api)).projects }), signal);
  const errors = [...discovered.errors];
  const candidates = [source];
  for (const { target, projects } of discovered.results) {
    if (target.descriptor.environmentId === source.target.descriptor.environmentId) continue;
    const matches = projects.filter(project => sharedProjectKey(project, target.descriptor.environmentId, preferences) === key);
    if (matches.length > 1) {
      errors.push({ environment: target.name, code: "AMBIGUOUS_PROJECT", message: "Multiple projects share this repository group. Select a project on that machine with --pin-env." });
    } else if (matches.length === 1) candidates.push({ target, project: matches[0]! });
  }
  if (candidates.length === 1 && errors.length === 0) return;

  type Evaluated = typeof source & {
    selections?: { model: ReturnType<typeof selection>; permission: PermissionMode };
    resources?: unknown; receivedAt?: number; weight: number; score: number; excluded?: string;
  };
  const evaluated: Evaluated[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
    while (next < candidates.length) {
      const candidate = candidates[next++]!, { target, project } = candidate;
      const entry: Evaluated = { ...candidate, weight: preferences.loadBalancingWeights[target.descriptor.environmentId] ?? 50, score: 0 };
      evaluated.push(entry);
      if (entry.weight === 0) { entry.excluded = "zero-weight"; continue; }
      if (options.checkout === "worktree" && target.descriptor.capabilities?.requiredWorktreeBootstrap !== true) { entry.excluded = "worktree-unsupported"; continue; }
      try {
        await withApi(target, async api => {
          const config = object(await api.rpc("server.getConfig", {})), settings = object(config.settings);
          const model = selection(project, options.provider, options.model, settings);
          const permission = permissionSelection(settings, project.id, options.permission);
          if (!Array.isArray(config.providers)) fail("INVALID_RESPONSE", "T3 returned no provider availability information.");
          const provider = config.providers.map(object).find(p => p.instanceId === model.instanceId);
          if (!provider || !provider.enabled || !provider.installed || provider.status === "error" || object(provider.auth ?? {}).status === "unauthenticated" || provider.availability === "unavailable") {
            entry.excluded = "provider-unavailable"; return;
          }
          entry.selections = { model, permission };
          entry.resources = await api.rpc("server.getHostResources", {});
          // Receipt time avoids rejecting healthy machines whose clocks differ from this one.
          entry.receivedAt = Date.now();
        }, signal);
      } catch (error) {
        entry.excluded = "unavailable";
        errors.push(safeError(target.name, error));
      }
    }
  }));
  for (const entry of evaluated) {
    if (entry.excluded) continue;
    entry.score = resourceScore(entry.resources, entry.weight, entry.receivedAt ?? 0);
    if (entry.score === 0) entry.excluded = "resources-unavailable-or-busy";
  }
  // Prefer the requested environment on ties; keep the rest deterministic across concurrent reads.
  evaluated.sort((a, b) => b.score - a.score || Number(b.target === source.target) - Number(a.target === source.target) || a.target.name.localeCompare(b.target.name));
  const routing = {
    mode: "auto", sourceEnvironment: source.target.name, complete: errors.length === 0, errors,
    candidates: evaluated.map(({ target, project, weight, score, excluded }) => ({ environment: target.name, projectId: project.id, weight, score, ...(excluded ? { excluded } : {}) })),
  };
  const chosen = evaluated[0];
  if (!chosen?.score || !chosen.selections) {
    const reasons = [...routing.candidates.map(c => `${c.environment}: ${c.excluded}`), ...errors.map(e => `${e.environment}: ${e.code}`)].join("; ");
    fail("AUTO_BALANCE_UNAVAILABLE", `Auto balance found no eligible machine for this project (${reasons}). Check machine load, providers and weights, or use --pin-env to choose the requested machine explicitly.`, routing);
  }
  return { target: chosen.target, project: chosen.project, selections: chosen.selections, routing };
}
