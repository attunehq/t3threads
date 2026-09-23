import { CliError, fail, withApi } from "./client.js";
import { targetFor, safeError, type Common } from "./environments.js";
import { busy, dispatch, readThread, sendCommand } from "./threads.js";
import { State } from "./state.js";

export type QueuedMessage = {
  id: string; order: number; ref: string; environmentId: string; options: Common;
  status: "pending" | "dispatching" | "accepted" | "cancelled" | "failed";
  createdAt: string; nextCheck: number;
  command: ReturnType<typeof sendCommand>; acceptedAt?: string;
  error?: ReturnType<typeof safeError>;
};
export const pendingMessages = (state: State) => state.list<QueuedMessage>("message")
  .filter(m => m.status === "pending" || m.status === "dispatching").sort((a, b) => a.order - b.order);

export function enqueue(input: Pick<QueuedMessage, "ref" | "environmentId" | "options" | "command">, state = new State()) {
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

export type QueueDelivery = (message: QueuedMessage, claim: (command: QueuedMessage["command"]) => boolean) => Promise<"busy" | "accepted" | "cancelled">;
export function queueDelivery(signal?: AbortSignal): QueueDelivery {
  return async (message, claim) => {
    const { target, id } = await targetFor(message.options, message.ref, signal);
    if (target.descriptor.environmentId !== message.environmentId) fail("ENVIRONMENT_MISMATCH", "The queued recipient's environment changed. Enqueue again using the intended environment.");
    return withApi(target, async api => {
      const thread = (await readThread(api, id!, 20)).thread;
      if (thread.messages?.some(m => m.id === message.command.message.messageId)) return "accepted";
      if (thread.deletedAt || thread.archivedAt) fail("THREAD_INACTIVE", "The queued recipient is deleted or archived.");
      if (busy(thread)) return "busy";
      // Freeze settings at first dispatch, then reuse the exact command for T3 receipt deduplication.
      const command = message.status === "dispatching" ? message.command : {
        ...message.command, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode, createdAt: new Date().toISOString(),
      };
      if (!claim(command)) return "cancelled";
      await dispatch(api, command);
      return "accepted";
    }, signal);
  };
}

export async function tickQueue(state = new State(), deliver = queueDelivery(), now = Date.now()) {
  const visited = new Set<string>();
  for (const initial of pendingMessages(state)) {
    const key = `${initial.environmentId}:${initial.command.threadId}`;
    // One attempt per recipient per pass, including aliases and a head waiting for retry.
    if (visited.has(key)) continue;
    visited.add(key);
    if (initial.nextCheck > now) continue;
    let message = initial;
    const save = (patch: Partial<QueuedMessage>) => {
      message = state.update<QueuedMessage>("message", message.id, current => current?.status === "cancelled" ? current : { ...message, ...patch });
    };
    try {
      const outcome = await deliver(message, command => {
        save({ command, status: "dispatching" });
        return message.status !== "cancelled";
      });
      save({ nextCheck: now + 5000, ...(outcome === "accepted" ? { status: "accepted", acceptedAt: new Date().toISOString(), error: undefined } : {}) });
    } catch (error) {
      const permanent = error instanceof CliError && (["RPC_REJECTED", "THREAD_INACTIVE", "ENVIRONMENT_MISMATCH", "CONNECT_IDENTITY_MISMATCH"].includes(error.code) || (error.code === "HTTP_ERROR" && (error.details as { status?: number })?.status === 404));
      save({ error: safeError(message.ref, error), nextCheck: now + 5000, ...(permanent ? { status: "failed" } : {}) });
    }
  }
}
