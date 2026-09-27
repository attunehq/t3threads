import { status } from "./intelligence.js";
import type { Thread } from "./threads.js";
import type { QueuedMessage } from "./queue.js";
import type { Watch } from "./watchers.js";

export function threadOutput(t: Thread, project?: string) {
  return {
    title: t.title, project, status: status(t), updatedAt: t.updatedAt,
    branch: t.branch ?? undefined, worktreePath: t.worktreePath ?? undefined,
    archivedAt: t.archivedAt || undefined, settledAt: t.settledAt || undefined,
    hasPendingApprovals: t.hasPendingApprovals, hasPendingUserInput: t.hasPendingUserInput,
    hasActionableProposedPlan: t.hasActionableProposedPlan, backgroundLiveness: t.backgroundLiveness ?? undefined,
    error: t.session?.lastError || undefined,
  };
}

export function messageOutput(m: NonNullable<Thread["messages"]>[number]) {
  return { role: m.role, text: m.text, ...(m.streaming === true ? { streaming: true } : {}), ...(m.attachments?.length ? { attachmentCount: m.attachments.length } : {}) };
}

export function queuedOutput(m: QueuedMessage) {
  return {
    id: m.id, ref: m.ref, status: m.status, createdAt: m.createdAt, acceptedAt: m.acceptedAt,
    caller: m.request?.caller, externalCaller: m.request?.externalCaller,
    delivery: m.request ? m.request.steer ? "steer" : "idle" : undefined,
    error: m.error,
  };
}

export function watchOutput(w: Watch) {
  return {
    id: w.id, refs: w.refs, caller: w.caller, condition: w.condition, status: w.status,
    expiresAt: w.expiresAt, lastCheck: w.lastCheck, firedAt: w.firedAt, deliveredAt: w.deliveredAt,
    ...(w.firedAt && w.evidence && typeof w.evidence === "object" && "decision" in w.evidence ? { decision: w.evidence.decision } : {}),
    ...(w.errors?.length ? { errors: w.errors } : {}),
  };
}
