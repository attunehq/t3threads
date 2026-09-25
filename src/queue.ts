import { CliError, fail, withApi } from "./client.js";
import { targetFor, safeError, parseRef, type Common } from "./environments.js";
import { busy, dispatch, readThread, sendCommand } from "./threads.js";
import { State } from "./state.js";

export type QueuedMessage = {
  id: string; order: number; ref: string; environmentId?: string; options: Common;
  request?: { prompt: string; caller?: string; externalCaller?: string; steer: boolean };
  threadId: string; commandId: ReturnType<typeof crypto.randomUUID>; messageId: ReturnType<typeof crypto.randomUUID>;
  status: "pending" | "dispatching" | "accepted" | "cancelled" | "failed";
  createdAt: string; nextCheck: number;
  command?: ReturnType<typeof sendCommand>; acceptedAt?: string;
  error?: ReturnType<typeof safeError>;
};
export const pendingMessages = (state: State) => state.list<QueuedMessage>("message")
  .filter(m => m.status === "pending" || m.status === "dispatching")
  .map(m => ({ ...m, threadId: m.threadId ?? m.command!.threadId, commandId: m.commandId ?? m.command!.commandId, messageId: m.messageId ?? m.command!.message.messageId }))
  .sort((a, b) => a.order - b.order);

type PreparedInput = { ref: string; environmentId: string; options: Common; command: ReturnType<typeof sendCommand> };
export function enqueue(input: PreparedInput, state = new State()) {
  return persist({ ...input, threadId: input.command.threadId, commandId: input.command.commandId, messageId: input.command.message.messageId }, state);
}
export function enqueueSend(input: { ref: string; options: Common; request: NonNullable<QueuedMessage["request"]> }, state = new State()) {
  const { name, id } = parseRef(input.ref, input.options.env);
  if (input.ref.includes(":") && input.options.env && name !== input.options.env) fail("ENVIRONMENT_MISMATCH", "The thread reference and --env select different environments.");
  if (input.options.home && name !== "local") fail("INVALID_ARGUMENT", "--home only applies to local.");
  if (input.request.caller) parseRef(input.request.caller);
  return persist({ ...input, ref: `${name}:${id}`, options: { ...input.options, env: undefined }, threadId: id,
    environmentId: name.startsWith("connect-") ? name.slice(8) : undefined,
    commandId: crypto.randomUUID(), messageId: crypto.randomUUID() }, state);
}
function persist(input: Pick<QueuedMessage, "ref" | "environmentId" | "options" | "command" | "request" | "threadId" | "commandId" | "messageId">, state: State) {
  return state.transaction(db => {
    const row = db.prepare("SELECT COALESCE(MAX(json_extract(value, '$.order')), 0) + 1 AS next FROM entries WHERE kind='message'").get()!;
    const message: QueuedMessage = { ...input, id: crypto.randomUUID(), order: Number(row.next), status: "pending", createdAt: new Date().toISOString(), nextCheck: 0 };
    db.prepare("INSERT INTO entries VALUES ('message', ?, ?)").run(message.id, JSON.stringify(message));
    return message;
  });
}

export function cancelMessage(id: string, state = new State()) {
  return state.update<QueuedMessage>("message", id, message => {
    if (!message) fail("MESSAGE_NOT_FOUND", "Unknown queued message.");
    if (message.status === "dispatching") fail("DELIVERY_STARTED", "Dispatch has started. Inspect the recipient thread and queued status; the message cannot be recalled.");
    return message.status === "pending" ? { ...message, status: "cancelled" } : message;
  });
}

export type QueueDelivery = (message: QueuedMessage, claim: (command: NonNullable<QueuedMessage["command"]>, environmentId?: string) => boolean, bind: (environmentId: string) => boolean) => Promise<"busy" | "accepted" | "cancelled">;
export function queueDelivery(signal?: AbortSignal): QueueDelivery {
  return async (message, claim, bind) => {
    const { target, id } = await targetFor(message.options, message.ref, signal);
    if (message.environmentId && target.descriptor.environmentId !== message.environmentId) fail("ENVIRONMENT_MISMATCH", "The queued recipient's environment changed. Enqueue again using the intended environment.");
    if (!bind(target.descriptor.environmentId)) return "busy";
    return withApi(target, async api => {
      const thread = (await readThread(api, id!, 20)).thread;
      if (thread.messages?.some(m => m.id === message.messageId)) return "accepted";
      if (thread.deletedAt || thread.archivedAt) fail("THREAD_INACTIVE", "The queued recipient is deleted or archived.");
      if (message.status !== "dispatching" && !message.request?.steer && busy(thread)) return "busy";
      let command = message.command;
      if (message.status !== "dispatching") {
        if (message.request) {
          const request = message.request;
          let sender;
          if (request.caller) {
            const caller = parseRef(request.caller);
            const source = await targetFor({ config: message.options.config, home: caller.name === "local" ? message.options.home : undefined }, request.caller, signal);
            sender = await withApi(source.target, async sourceApi => ({
              ref: `${caller.name}:${caller.id}`, title: (await readThread(sourceApi, caller.id, 1)).thread.title,
              environmentId: source.target.descriptor.environmentId,
              replyRef: `${source.target.descriptor.environmentId === target.descriptor.environmentId ? "local" : `connect-${source.target.descriptor.environmentId}`}:${caller.id}`,
            }), signal);
          }
          command = sendCommand(thread, request.prompt, sender ?? { externalCaller: request.externalCaller! }, "steer");
          command = { ...command, commandId: message.commandId, message: { ...command.message, messageId: message.messageId } };
        } else if (command) {
          command = { ...command, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode,
            interactionMode: thread.interactionMode, createdAt: new Date().toISOString() };
        }
      }
      if (!command) fail("INVALID_MESSAGE", "Queued message has no dispatch command.");
      // Persist the exact command before sending; retries never re-read the sender or change settings.
      if (!claim(command, target.descriptor.environmentId)) return "cancelled";
      await dispatch(api, command);
      return "accepted";
    }, signal);
  };
}

export async function tickQueue(state = new State(), deliver = queueDelivery(), now = Date.now()) {
  const visited = new Set<string>();
  for (const initial of pendingMessages(state)) {
    const key = `${initial.environmentId ?? initial.ref.split(":")[0]}:${initial.threadId}`;
    // One attempt per recipient per pass, including aliases and a head waiting for retry.
    if (visited.has(key)) continue;
    visited.add(key);
    if (initial.nextCheck > now) continue;
    let message = initial;
    const save = (patch: Partial<QueuedMessage>) => {
      message = state.update<QueuedMessage>("message", message.id, current => current?.status === "cancelled" ? current : { ...message, ...patch });
    };
    try {
      const outcome = await deliver(message, (command, environmentId) => {
        save({ command, environmentId: environmentId ?? message.environmentId, status: "dispatching" });
        return message.status !== "cancelled";
      }, environmentId => {
        const canonical = `${environmentId}:${message.threadId}`;
        save({ environmentId });
        if (canonical !== key && visited.has(canonical)) return false;
        visited.add(canonical);
        return message.status !== "cancelled";
      });
      save({ nextCheck: now + 5000, ...(outcome === "accepted" ? { status: "accepted", acceptedAt: new Date().toISOString(), error: undefined } : {}) });
    } catch (error) {
      const permanent = error instanceof CliError && (["RPC_REJECTED", "THREAD_INACTIVE", "ENVIRONMENT_MISMATCH", "CONNECT_IDENTITY_MISMATCH", "ENVIRONMENT_NOT_FOUND", "INVALID_MESSAGE", "INVALID_ARGUMENT", "INVALID_CONFIG", "CONFIG_NOT_FOUND"].includes(error.code) || (error.code === "HTTP_ERROR" && (error.details as { status?: number })?.status === 404));
      save({ error: safeError(message.ref, error), nextCheck: now + 5000, ...(permanent ? { status: "failed" } : {}) });
    }
  }
}
