import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import type { TestContext } from "node:test";
import { WebSocketServer } from "ws";
import { Api, type Target } from "../src/client.js";
import { startCommand, type Project, type Thread } from "../src/threads.js";

export const project: Project = { id: "p1", title: "Grace Hopper", workspaceRoot: "/work/grace", defaultModelSelection: { instanceId: "codex-work", model: "saved-model", options: [{ id: "reasoningEffort", value: "high" }] } };
export const thread: Thread = { id: "t1", projectId: "p1", title: "Earlier design", updatedAt: "2026-09-22T00:00:00Z", modelSelection: project.defaultModelSelection!, runtimeMode: "approval-required", interactionMode: "plan", branch: "main", worktreePath: null, session: null, latestTurn: null };
export const message = (id: string, text: string) => ({ id, role: "assistant", text, createdAt: `2026-09-${id.padStart(2, "0")}T00:00:00Z` });
export const descriptor = { environmentId: "test-env", serverVersion: "0.0.43-test", orchestrationProtocolVersion: 1, capabilities: { requiredWorktreeBootstrap: true, threadSettlement: true } };
export const json = (res: ServerResponse, value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };

export async function fixture(t: TestContext, handler?: (req: IncomingMessage, res: ServerResponse) => boolean | undefined, environmentId = "test-env") {
  const environmentDescriptor = { ...descriptor, environmentId };
  const dir = await mkdtemp(join(tmpdir(), "t3threads-test-"));
  const authLog = join(dir, "auth.jsonl"), authCli = join(dir, "auth.mjs");
  await writeFile(authCli, `import {appendFileSync} from 'node:fs';const args=process.argv.slice(2);if(args[0]==='--version')console.log('t3 v0.0.43-test');else {appendFileSync(${JSON.stringify(authLog)},JSON.stringify(args)+'\\n');if(args.includes('issue'))console.log(JSON.stringify({sessionId:'test-session',token:'test-secret'}));}`);
  const commands: ReturnType<typeof startCommand>[] = [];
  const projects = [structuredClone(project)];
  const settings: Record<string, unknown> = { defaultModelSelection: project.defaultModelSelection, projectSettingsFolded: true, defaultRuntimeMode: "approval-required", projectSettingsOverrides: {}, textGenerationModelSelection: project.defaultModelSelection, providerInstances: { "codex-work": { driver: "codex", enabled: true, config: {} } } };
  const rpcMethods: string[] = [];
  const stored = new Map<string, Thread>([[thread.id, structuredClone(thread)]]);
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/.well-known/t3/environment") return json(res, environmentDescriptor);
    if (req.headers.authorization !== "Bearer test-secret") return json(res, { secret: "test-secret" }, 401);
    if (handler?.(req, res)) return;
    if (url.pathname === "/api/auth/websocket-ticket") return json(res, { ticket: "one-time-ticket" });
    if (["/api/orchestration/shell", "/api/orchestration/snapshot"].includes(url.pathname)) return json(res, { projects, threads: [...stored.values()] });
    if (url.pathname.startsWith("/api/orchestration/threads/")) {
      const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
      const value = stored.get(id);
      return value ? json(res, { snapshotSequence: 1, thread: { ...value, messages: value.messages ?? [message("1", "hello")] }, page: { hasMore: false, beforeCursor: null } }) : json(res, {}, 404);
    }
    // HTTP dispatch deliberately fails: bootstrap exists only on the RPC path.
    json(res, {}, 404);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url!, "http://localhost").searchParams.get("wsTicket") !== "one-time-ticket") return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws));
  });
  const control = { reject: false, disconnect: false, loseReceipt: false, startRunning: false, pinged: false };
  wss.on("connection", ws => {
    ws.send(JSON.stringify({ _tag: "Ping" }));
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw));
      if (frame._tag === "Pong") { control.pinged = true; return; }
      rpcMethods.push(frame.tag);
      if (control.disconnect) return ws.close();
      if (control.reject) return ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Failure", cause: [{ error: { message: "test-secret" } }] } }));
      if (frame.tag === "server.getSettings") return ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: settings } }));
      if (frame.tag !== "orchestration.dispatchCommand") throw Error("Wrong RPC method");
      const command = frame.payload as ReturnType<typeof startCommand>;
      const prior = commands.findIndex(c => c.commandId === command.commandId);
      if (prior >= 0) return ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: prior + 1 } } }));
      commands.push(command);
      if (command.type !== "thread.turn.start") {
        const value = stored.get(command.threadId)!;
        if (command.type === "thread.archive") value.archivedAt = "today";
        if (command.type === "thread.unarchive") value.archivedAt = null;
        if (command.type === "thread.settle") value.settledAt = "today";
        if (command.type === "thread.meta.update") value.title = (command as unknown as { title: string }).title;
        if (command.type === "thread.turn.interrupt") { value.latestTurn = { state: "interrupted" }; value.session = null; }
        return ws.send(JSON.stringify({ _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: commands.length } } }));
      }
      const value: Thread = command.bootstrap?.createThread ? { ...thread, ...command.bootstrap.createThread, id: command.threadId, messages: [] } : stored.get(command.threadId)!;
      value.messages = [...(value.messages ?? []), { id: command.message.messageId, role: command.message.role, text: command.message.text, createdAt: command.createdAt }];
      if (control.startRunning) value.latestTurn = { state: "running" };
      stored.set(value.id, value);
      if (control.loseReceipt) return ws.close();
      ws.send(JSON.stringify([{ _tag: "Exit", requestId: "unrelated", exit: { _tag: "Success", value: {} } }, { _tag: "Exit", requestId: frame.id, exit: { _tag: "Success", value: { sequence: commands.length } } }]));
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw Error("No port");
  const origin = `http://127.0.0.1:${address.port}`;
  await mkdir(join(dir, "userdata"));
  await writeFile(join(dir, "userdata/server-runtime.json"), JSON.stringify({ origin }));
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ environments: { local: { home: dir, command: [process.execPath, authCli] } } }));
  const target: Target = { name: "local", home: dir, origin, descriptor: environmentDescriptor, config: { command: [process.execPath, authCli] } };
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, authLog, configPath, target, api: new Api(target, "test-secret"), commands, stored, control, settings, rpcMethods, projects,
    async authActions() { return (await readFile(authLog, "utf8")).trim().split("\n").map(line => (JSON.parse(line) as string[])[2]); },
  };
}
