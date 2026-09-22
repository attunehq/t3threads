import { Cli, Errors, z } from "incur";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Api, CliError, discover, expand, fail, readConfig, withApi, type Environment, type Target } from "./client.js";
import { catalog, dispatch, localBranch, readAll, readThread, search, selectProject, selection, sendCommand, startCommand, summary } from "./threads.js";

const text = z.string().trim().min(1);
const common = {
  env: text.optional().describe("Named environment; defaults to local"),
  home: text.optional().describe("Local T3 home (defaults to T3CODE_HOME or ~/.t3)"),
  config: text.optional().describe("Environment configuration JSON path"),
};
type Common = { env?: string; home?: string; config?: string };
const promptOptions = {
  prompt: z.string().min(1).optional().describe("Self-contained prompt text (use this with MCP)"),
  promptFile: text.optional().describe("Read prompt from a UTF-8 file on this machine"),
  dryRun: z.boolean().default(false).describe("Return the exact command without dispatching it"),
};
const readOnly = { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
const write = { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } };

async function environments(options: Common) {
  const defaultPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "t3threads", "config.json");
  return readConfig(expand(options.config ?? defaultPath), options.config !== undefined);
}
async function targetFor(options: Common, ref?: string, signal?: AbortSignal) {
  const configured = await environments(options);
  let name = options.env ?? "local";
  let id = ref;
  if (ref?.includes(":")) {
    const [refEnv, ...rest] = ref.split(":");
    if (options.env && options.env !== refEnv) fail("ENVIRONMENT_MISMATCH", "The thread reference and --env select different environments.");
    name = refEnv!; id = rest.join(":");
  }
  if (id !== undefined && (!id || /[\s/:?#]/.test(id))) fail("INVALID_ARGUMENT", "Invalid thread ID.");
  if (name !== "local" && !configured[name]) fail("ENVIRONMENT_NOT_FOUND", "Unknown environment. Run environments or configure it first.");
  if (options.home && name !== "local") fail("INVALID_ARGUMENT", "--home only applies to the local environment.");
  const config: Environment = { ...configured[name], ...(options.home ? { home: expand(options.home) } : {}) };
  if (options.home && config.url) fail("INVALID_ARGUMENT", "--home cannot override a URL environment.");
  return { target: await discover(name, config, signal), id };
}
function context(target: Target) {
  return { environment: target.name, environmentId: target.descriptor.environmentId, serverVersion: target.descriptor.serverVersion };
}
async function promptFrom(options: { prompt?: string; promptFile?: string }) {
  if ((options.prompt !== undefined) === (options.promptFile !== undefined)) fail("PROMPT_REQUIRED", "Supply exactly one of --prompt or --prompt-file.");
  let prompt = options.prompt;
  if (options.promptFile) {
    try { prompt = await readFile(expand(options.promptFile), "utf8"); }
    catch { fail("PROMPT_UNREADABLE", "Cannot read the prompt file."); }
  }
  if (!prompt?.trim()) fail("PROMPT_REQUIRED", "The prompt must not be empty.");
  return prompt;
}
function requirePost(request?: Request) {
  if (request && request.method !== "POST") fail("METHOD_NOT_ALLOWED", "Start and send require POST over HTTP.");
}

/** The same command definitions drive CLI, stdio MCP, and the Fetch API. */
export function createCli(options: { signal?: AbortSignal } = {}) {
  const signalFor = (request?: Request) => {
    const signals = [options.signal, request?.signal].filter((s): s is AbortSignal => s !== undefined);
    return signals.length ? AbortSignal.any(signals) : undefined;
  };
  const withTarget = async <T>(o: Common, request: Request | undefined, fn: (api: Api, target: Target, id?: string) => Promise<T>, ref?: string) => {
    const signal = signalFor(request);
    const { target, id } = await targetFor(o, ref, signal);
    return withApi(target, api => fn(api, target, id), signal);
  };

  const cli = Cli.create("t3threads", {
    version: "0.1.0",
    description: "Read, search, and start T3 Code threads without a fork.",
    update: false,
    mcp: { tools: { discovery: "direct" }, instructions: "Read/search existing T3 conversations for context. Start/send launch agent work and require user authorization. A new thread does not inherit this conversation. Accepted means dispatched, not completed; read its status and replies. Never blindly retry a dispatch with an unknown outcome." },
  });
  cli.use(async (_c, next) => {
    try { await next(); }
    catch (error) {
      if (error instanceof Errors.IncurError) throw error;
      if (error instanceof CliError) {
        const details = error.details as { threadId?: string; commandId?: string } | undefined;
        throw new Errors.IncurError({ code: error.code, message: error.message + (details?.threadId ? ` Thread: ${details.threadId}. Command: ${details.commandId}.` : ""), retryable: false });
      }
      throw new Errors.IncurError({ code: "INTERNAL_ERROR", message: "Operation failed. Check configuration and T3 availability.", retryable: false });
    }
  });
  return cli
    .command("environments", {
      description: "List configured environment names.", mcp: readOnly,
      options: z.object({ config: common.config }),
      async run(c) { return { environments: [...new Set(["local", ...Object.keys(await environments(c.options))])] }; },
    })
    .command("doctor", {
      description: "Check server version, reachability, and authenticated access.", mcp: readOnly,
      options: z.object(common),
      run: c => withTarget(c.options, c.request, async (api, target) => {
        const data = await catalog(api);
        return { ...context(target), origin: target.origin, authenticated: true, projects: data.projects.length, threads: data.threads.length };
      }),
    })
    .command("projects", {
      description: "List T3 projects, workspace paths, and saved model selections.", mcp: readOnly,
      options: z.object(common),
      run: c => withTarget(c.options, c.request, async (api, target) => ({ ...context(target), projects: (await catalog(api)).projects })),
    })
    .command("list", {
      description: "List threads, newest first, optionally filtered to a project.", mcp: readOnly,
      options: z.object({ ...common, project: text.optional().describe("Project ID, exact title, or workspace path"), archived: z.boolean().default(false).describe("Include archived threads") }),
      run: c => withTarget(c.options, c.request, async (api, target) => {
        const data = await catalog(api, c.options.archived);
        const project = c.options.project ? selectProject(data.projects, expandProject(c.options.project)) : undefined;
        const threads = data.threads.filter(t => !project || t.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { ...context(target), threads: threads.map(t => ({ ref: `${target.name}:${t.id}`, ...summary(t) })) };
      }),
    })
    .command("read", {
      description: "Read a conversation and status. Defaults to the latest 20 user turns.", mcp: readOnly,
      args: z.object({ thread: text.describe("Thread ID or environment:thread-ID") }),
      options: z.object({ ...common, turns: z.coerce.number().int().positive().default(20), before: text.optional().describe("Older-page cursor from a previous read"), all: z.boolean().default(false).describe("Read all message history, paging internally") }),
      async run(c) {
        if (c.options.all && c.options.before) fail("INVALID_ARGUMENT", "--all cannot be combined with --before.");
        return withTarget(c.options, c.request, async (api, target, id) => {
          const data = c.options.all ? await readAll(api, id!, c.options.turns) : await readThread(api, id!, c.options.turns, c.options.before);
          return { ...context(target), ref: `${target.name}:${id}`, ...summary(data.thread), messages: data.thread.messages, page: data.page ?? { hasMore: false, beforeCursor: null }, snapshotSequence: data.snapshotSequence };
        }, c.args.thread);
      },
    })
    .command("search", {
      description: "Search project thread titles and all message history. Does not search attachments or tool activities.", mcp: readOnly,
      args: z.object({ query: text.describe("Case-insensitive literal text") }),
      options: z.object({ ...common, project: text.describe("Project ID, exact title, or workspace path"), limit: z.coerce.number().int().positive().default(20).describe("Maximum matches; complete=false indicates early termination"), archived: z.boolean().default(false) }),
      run: c => withTarget(c.options, c.request, async (api, target) => {
        const data = await catalog(api, c.options.archived);
        const project = selectProject(data.projects, expandProject(c.options.project));
        const threads = data.threads.filter(t => t.projectId === project.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        return { ...context(target), projectId: project.id, query: c.args.query, ...(await search(api, threads, c.args.query, c.options.limit)) };
      }),
    })
    .command("start", {
      description: "Start an agent task in a new T3 thread. Only use for authorized work; not idempotent.", mcp: write,
      options: z.object({ ...common, ...promptOptions,
        project: text.describe("Existing project ID, exact title, or workspace path"),
        checkout: z.enum(["worktree", "current"]).describe("Separate worktree or the project's current checkout"),
        title: text.optional(), provider: text.optional().describe("Configured provider instance ID; requires --model"), model: text.optional(),
        permission: z.enum(["approval-required", "auto-accept-edits", "auto", "full-access"]).default("approval-required"),
        mode: z.enum(["default", "plan"]).default("default"), branch: text.optional().describe("Base branch (required for a remote worktree)"),
        fromOrigin: z.boolean().default(false).describe("Resolve the worktree base from origin"), skipSetup: z.boolean().default(false).describe("Skip the worktree setup script"),
      }),
      async run(c) {
        requirePost(c.request);
        const prompt = await promptFrom(c.options);
        const worktree = c.options.checkout === "worktree";
        if (!worktree && (c.options.fromOrigin || c.options.skipSetup)) fail("INVALID_ARGUMENT", "--from-origin and --skip-setup require --checkout worktree.");
        return withTarget(c.options, c.request, async (api, target) => {
          const project = selectProject((await catalog(api)).projects, expandProject(c.options.project));
          if (worktree && target.descriptor.capabilities?.requiredWorktreeBootstrap !== true) fail("UNSUPPORTED_SERVER", "This server cannot guarantee worktree creation. Update T3 first.");
          const branch = c.options.branch ?? (target.home ? await localBranch(project) : null);
          const command = startCommand(project, { prompt, title: c.options.title, model: selection(project, c.options.provider, c.options.model), permission: c.options.permission, mode: c.options.mode, worktree, branch, startFromOrigin: c.options.fromOrigin, setup: !c.options.skipSetup });
          return { ...context(target), ref: `${target.name}:${command.threadId}`, ...(c.options.dryRun ? { dryRun: true, command } : await dispatch(api, command)) };
        });
      },
    })
    .command("send", {
      description: "Send an authorized follow-up to an idle T3 thread, preserving its settings. Not idempotent.", mcp: write,
      args: z.object({ thread: text.describe("Thread ID or environment:thread-ID") }),
      options: z.object({ ...common, ...promptOptions }),
      async run(c) {
        requirePost(c.request);
        const prompt = await promptFrom(c.options);
        return withTarget(c.options, c.request, async (api, target, id) => {
          const command = sendCommand((await readThread(api, id!, 1)).thread, prompt);
          return { ...context(target), ref: `${target.name}:${id}`, ...(c.options.dryRun ? { dryRun: true, command } : await dispatch(api, command)) };
        }, c.args.thread);
      },
    });
}
function expandProject(query: string) { return query.startsWith("~/") ? expand(query) : query; }

export const cli = createCli();
