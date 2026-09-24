import { resolve, relative, isAbsolute } from "node:path";
import { Api, fail, object, run } from "./client.js";

export type Model = { instanceId: string; model: string; options?: unknown };
export const permissionModes = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type PermissionMode = typeof permissionModes[number];
export type Project = { id: string; title: string; workspaceRoot: string; defaultModelSelection: Model | null; deletedAt?: string | null };
export type Thread = {
  id: string; projectId: string; title: string; updatedAt: string; archivedAt?: string | null; deletedAt?: string | null; settledAt?: string | null;
  modelSelection: Model; runtimeMode: string; interactionMode: string; branch: string | null; worktreePath: string | null;
  latestTurn?: { state: string } | null; session?: { status: string; activeTurnId: string | null; lastError: string | null } | null;
  messages?: { id: string; role: string; text: string; createdAt: string; attachments?: unknown[] }[];
};
export type Snapshot = { thread: Thread; snapshotSequence: number; page?: { beforeCursor: string | null; hasMore: boolean } };

export async function catalog(api: Api, archived = false): Promise<{ projects: Project[]; threads: Thread[] }> {
  const data = object(await api.request(archived ? "/api/orchestration/snapshot" : "/api/orchestration/shell"));
  if (!Array.isArray(data.projects) || !Array.isArray(data.threads)) fail("INVALID_RESPONSE", "T3 returned an incompatible thread catalog.");
  const hasStrings = (value: unknown, fields: string[]) => fields.every(key => typeof object(value)[key] === "string");
  if (data.projects.some((p: unknown) => !hasStrings(p, ["id", "title", "workspaceRoot"])) || data.threads.some((t: unknown) => !hasStrings(t, ["id", "projectId", "title", "updatedAt"]))) fail("INVALID_RESPONSE", "T3 returned an incompatible thread catalog.");
  return { projects: (data.projects as Project[]).filter(p => !p.deletedAt), threads: (data.threads as Thread[]).filter(t => !t.deletedAt && (archived || !t.archivedAt)) };
}

export function selectProject(projects: Project[], query: string): Project {
  const exact = projects.filter(p => p.id === query || p.title === query || p.workspaceRoot === query);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) fail("AMBIGUOUS_PROJECT", "Multiple projects match. Use the project ID.");
  const path = resolve(query);
  const nested = projects.filter(p => { const rel = relative(p.workspaceRoot, path); return !rel || (!rel.startsWith("..") && !isAbsolute(rel)); }).sort((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
  if (nested.length && (query.startsWith("/") || query.startsWith("."))) return nested[0]!;
  return fail("PROJECT_NOT_FOUND", "Project not found. Use projects to find its ID or workspace path; add new projects in T3 first.");
}

export function summary(thread: Thread) {
  const { id, projectId, title, updatedAt, archivedAt, modelSelection, runtimeMode, interactionMode, branch, worktreePath, latestTurn, session } = thread;
  return { id, projectId, title, updatedAt, archivedAt, modelSelection, runtimeMode, interactionMode, branch, worktreePath, latestTurn, session };
}

export async function readThread(api: Api, id: string, turns = 20, before?: string): Promise<Snapshot> {
  const query = new URLSearchParams({ turnLimit: String(turns) });
  if (before) query.set("beforeCursor", before);
  const result = object(await api.request(`/api/orchestration/threads/${encodeURIComponent(id)}?${query}`));
  const thread = object(result.thread);
  if (thread.id !== id || !Array.isArray(thread.messages)) fail("INVALID_RESPONSE", "T3 returned an incompatible thread snapshot.");
  if (result.page) {
    const page = object(result.page);
    if (typeof page.hasMore !== "boolean" || (page.hasMore && (typeof page.beforeCursor !== "string" || !page.beforeCursor))) fail("INVALID_RESPONSE", "T3 returned invalid pagination metadata.");
  }
  for (const raw of thread.messages) {
    const message = object(raw);
    if (["id", "role", "text", "createdAt"].some(key => typeof message[key] !== "string")) fail("INVALID_RESPONSE", "T3 returned an incompatible message.");
  }
  return result as Snapshot;
}

export async function* pages(api: Api, id: string, turns = 20): AsyncGenerator<Snapshot> {
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const snapshot = await readThread(api, id, turns, cursor);
    yield snapshot;
    if (!snapshot.page?.hasMore) return;
    cursor = snapshot.page.beforeCursor!;
    if (seen.has(cursor)) fail("INVALID_RESPONSE", "T3 repeated a history cursor; pagination stopped.");
    seen.add(cursor);
  } while (cursor);
}

export async function readAll(api: Api, id: string, turns = 20) {
  let first: Snapshot | undefined;
  const messages = new Map<string, NonNullable<Thread["messages"]>[number]>();
  for await (const snapshot of pages(api, id, turns)) {
    first ??= snapshot;
    for (const message of snapshot.thread.messages!) if (!messages.has(message.id)) messages.set(message.id, message);
  }
  return { ...first!, thread: { ...first!.thread, messages: [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) }, page: { hasMore: false, beforeCursor: null } };
}

export async function search(api: Api, threads: Thread[], query: string, limit: number) {
  const matches: { threadId: string; title: string; messageId?: string; role?: string; excerpt: string }[] = [];
  let scannedThreads = 0;
  const needle = query.toLocaleLowerCase();
  const excerpt = (text: string, index: number) => text.slice(Math.max(0, index - 120), index + query.length + 240);
  for (const thread of threads) {
    const titleIndex = thread.title.toLocaleLowerCase().indexOf(needle);
    if (titleIndex >= 0) matches.push({ threadId: thread.id, title: thread.title, excerpt: thread.title });
    if (matches.length >= limit) return { matches, complete: false, scannedThreads, totalThreads: threads.length };
    const seen = new Set<string>();
    for await (const snapshot of pages(api, thread.id)) {
      for (const message of snapshot.thread.messages!) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        const index = message.text.toLocaleLowerCase().indexOf(needle);
        if (index >= 0) matches.push({ threadId: thread.id, title: thread.title, messageId: message.id, role: message.role, excerpt: excerpt(message.text, index) });
        if (matches.length >= limit) return { matches, complete: false, scannedThreads, totalThreads: threads.length };
      }
    }
    scannedThreads++;
  }
  return { matches, complete: true, scannedThreads, totalThreads: threads.length };
}

function modelValue(value: unknown): Model {
  const saved = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if ([saved.instanceId, saved.model].some(value => typeof value !== "string" || !value.trim())) {
    fail("MODEL_REQUIRED", "T3 has no default model usable for this project. Set it in T3, or supply --provider and --model.");
  }
  return saved as Model;
}

function modelProviderEnabled(settings: Record<string, unknown>, instanceId: string) {
  const instances = object(settings.providerInstances ?? {});
  if (!Object.hasOwn(instances, instanceId)) return object(object(settings.providers ?? {})[instanceId] ?? {}).enabled === true;
  const provider = object(instances[instanceId]);
  const config = provider.config && typeof provider.config === "object" && !Array.isArray(provider.config) ? provider.config as Record<string, unknown> : {};
  const configEnabled = typeof config.enabled === "boolean" ? config.enabled : undefined;
  if (provider.enabled === false || configEnabled === false) return false;
  // T3's resolveProviderInstanceEnabled uses these driver defaults when both flags are absent.
  return provider.enabled ?? configEnabled ?? !["cursor", "grok", "opencode", "antigravity"].includes(String(provider.driver));
}

export function selection(project: Project, provider?: string, model?: string, settings?: Record<string, unknown>): Model {
  if (provider && !model) fail("MODEL_REQUIRED", "Pass --model when overriding --provider.");
  if (provider && model) return { instanceId: provider, model };
  let value: unknown = project.defaultModelSelection;
  if (settings) {
    const overrides = projectOverrides(settings, project.id, "MODEL_REQUIRED");
    // A completed fold makes the settings map authoritative, including resets.
    const projectValue = Object.hasOwn(overrides, "defaultModelSelection") ? overrides.defaultModelSelection
      : settings.projectSettingsFolded !== true && project.defaultModelSelection != null ? project.defaultModelSelection : undefined;
    value = settings.defaultModelSelection;
    if (projectValue !== undefined) {
      const candidate = modelValue(projectValue);
      if (modelProviderEnabled(settings, candidate.instanceId)) value = candidate;
    }
  }
  const saved = modelValue(value);
  if (settings && !modelProviderEnabled(settings, saved.instanceId)) fail("MODEL_DISABLED", "T3's default model provider is disabled or unavailable. Set an enabled default in T3, or supply --provider and --model.");
  return model && model !== saved.model ? { instanceId: saved.instanceId, model } : saved;
}

function projectOverrides(settings: Record<string, unknown>, projectId: string, code: string): Record<string, unknown> {
  const record = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, "T3 returned invalid project settings. Fix the settings or pass --permission, --provider and --model explicitly.");
    return value as Record<string, unknown>;
  };
  const overrides = settings.projectSettingsOverrides === undefined ? {} : record(settings.projectSettingsOverrides);
  return Object.hasOwn(overrides, projectId) ? record(overrides[projectId]) : {};
}

export function permissionSelection(settings: Record<string, unknown>, projectId: string, override?: PermissionMode): PermissionMode {
  if (override !== undefined) return override;
  const invalid = () => fail("PERMISSION_REQUIRED", "T3 did not return a supported default permission for this project. Set it in T3 or pass --permission explicitly.");
  const project = projectOverrides(settings, projectId, "PERMISSION_REQUIRED");
  // Match T3's resolveProjectSettings on the destination server, not the caller.
  const mode = project.defaultRuntimeMode === undefined ? settings.defaultRuntimeMode : project.defaultRuntimeMode;
  if (!permissionModes.includes(mode as PermissionMode)) return invalid();
  return mode as PermissionMode;
}

export async function startSelections(api: Api, project: Project, options: { provider?: string; model?: string; permission?: PermissionMode }) {
  const explicitModel = options.provider ? selection(project, options.provider, options.model) : undefined;
  const settings = !explicitModel || options.permission === undefined ? object(await api.rpc("server.getSettings", {})) : {};
  const permission = permissionSelection(settings, project.id, options.permission);
  return { permission, model: explicitModel ?? selection(project, undefined, options.model, settings) };
}

export async function localBranch(project: Project) {
  const result = await run(["git", "-C", project.workspaceRoot, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function startCommand(project: Project, options: { prompt: string; title?: string; model: Model; permission: string; mode: string; worktree: boolean; branch: string | null; startFromOrigin: boolean; setup: boolean }) {
  if (options.worktree && !options.branch) fail("BRANCH_REQUIRED", "Worktree creation requires a base branch. Use --branch for a remote environment or detached checkout.");
  const createdAt = new Date().toISOString();
  const title = options.title ?? options.prompt.trim().split("\n")[0]!.slice(0, 100);
  const threadId = crypto.randomUUID();
  return {
    type: "thread.turn.start", commandId: crypto.randomUUID(), threadId,
    message: { messageId: crypto.randomUUID(), role: "user", text: options.prompt, attachments: [] },
    modelSelection: options.model, runtimeMode: options.permission, interactionMode: options.mode, createdAt,
    bootstrap: {
      createThread: { projectId: project.id, title, modelSelection: options.model, runtimeMode: options.permission, interactionMode: options.mode, branch: options.branch, worktreePath: null, createdAt },
      ...(options.worktree ? { prepareWorktree: { projectCwd: project.workspaceRoot, baseBranch: options.branch, branch: `t3threads/${threadId}`, startFromOrigin: options.startFromOrigin, requireWorktree: true }, runSetupScript: options.setup } : {}),
    },
  };
}

export const busy = (t: Thread) => Boolean(t.session?.activeTurnId || ["starting", "running"].includes(t.session?.status ?? "") || t.latestTurn?.state === "running");

export function sendCommand(thread: Thread, prompt: string, sender?: { ref: string; title: string; environmentId: string; replyRef: string }, delivery: "idle" | "steer" = "idle") {
  if (thread.deletedAt || thread.archivedAt) fail("THREAD_INACTIVE", "Restore this thread in T3 before sending a prompt.");
  // T3 routes thread.turn.start to the running provider as steering input.
  if (delivery === "idle" && busy(thread)) fail("THREAD_BUSY", "The thread is running. Use --steer to send now or --enqueue to wait until it is idle.");
  if (sender) prompt = `[t3threads agent message]
From: agent in T3 thread ${JSON.stringify(sender.title)}
Sender thread: ${sender.ref}
Sender environment ID: ${sender.environmentId}
This message is from another agent, not the user.
To reply, use t3threads send with target ${sender.replyRef} and --caller set to your own T3 thread reference. If the target environment is unavailable, use a configured alias for the sender environment ID.

${prompt}`;
  return { type: "thread.turn.start", commandId: crypto.randomUUID(), threadId: thread.id, message: { messageId: crypto.randomUUID(), role: "user", text: prompt, attachments: [] }, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: new Date().toISOString() };
}

export async function dispatch(api: Api, command: { type: string; threadId: string; commandId: string; [key: string]: unknown }) {
  try {
    // Bootstrap/worktree handling lives in T3's RPC layer, not HTTP dispatch.
    const receipt = object(await api.rpc("orchestration.dispatchCommand", command));
    if (typeof receipt.sequence !== "number") fail("INVALID_RESPONSE", "T3 returned an invalid dispatch receipt. Inspect the thread before retrying.");
    return { threadId: command.threadId, commandId: command.commandId, status: "accepted", sequence: receipt.sequence };
  } catch (error) {
    if (error instanceof Error) Object.assign(error, { details: { ...("details" in error ? object(error.details ?? {}) : {}), threadId: command.threadId, commandId: command.commandId } });
    throw error;
  }
}
