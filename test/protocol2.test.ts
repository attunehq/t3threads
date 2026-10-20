import assert from "node:assert/strict";
import test from "node:test";
import { launchInput, selection, v2Command, type Project } from "../src/threads.js";

const project = { id: "p1", title: "App", workspaceRoot: "/repo" } as Project;
const turn = (extra: Record<string, unknown> = {}) => ({
  type: "thread.turn.start", commandId: "c1", threadId: "t1",
  message: { messageId: "m1", role: "user", text: "Do the thing", attachments: [] },
  modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default",
  createdAt: "2026-10-20T00:00:00.000Z", ...extra,
});

test("protocol 2 launch maps a worktree bootstrap onto launchThread", () => {
  const input = launchInput(turn({ bootstrap: {
    createThread: { projectId: "p1", title: "Title", branch: "main" },
    prepareWorktree: { projectCwd: "/repo", baseBranch: "main", branch: "t3threads/t1", startFromOrigin: true, requireWorktree: true },
    runSetupScript: true,
  } }));
  assert.deepEqual(input, {
    commandId: "c1", threadId: "t1", projectId: "p1", title: "Title",
    modelSelection: { instanceId: "claudeAgent", model: "m" }, runtimeMode: "full-access", interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "main", branch: "t3threads/t1", startFromOrigin: true },
    initialMessage: { messageId: "m1", text: "Do the thing", attachments: [] },
  });
});

test("protocol 2 launch in the current checkout uses the root strategy", () => {
  const input = launchInput(turn({ bootstrap: { createThread: { projectId: "p1", title: "Title", branch: "dev" } } }));
  assert.deepEqual(input.workspaceStrategy, { type: "root", branch: "dev" });
});

test("protocol 2 sends start an idle thread and steer an active run", () => {
  const idle = v2Command(turn({ activeRunId: null }));
  assert.equal(idle.type, "message.dispatch");
  assert.deepEqual(idle.dispatchMode, { type: "start_immediately" });
  assert.equal(idle.text, "Do the thing");
  assert.equal(idle.messageId, "m1");
  assert.deepEqual(v2Command(turn({ activeRunId: "r9" })).dispatchMode, { type: "steer_active", targetRunId: "r9" });
});

test("protocol 2 maps interrupt, rename and lifecycle commands", () => {
  assert.deepEqual(v2Command({ type: "thread.turn.interrupt", commandId: "c", threadId: "t", runId: "r", createdAt: "x" }),
    { type: "run.interrupt", commandId: "c", threadId: "t", runId: "r", holdQueue: true });
  assert.throws(() => v2Command({ type: "thread.turn.interrupt", commandId: "c", threadId: "t" }), /no active run/);
  assert.deepEqual(v2Command({ type: "thread.meta.update", commandId: "c", threadId: "t", title: "New" }),
    { type: "thread.metadata.update", commandId: "c", threadId: "t", title: "New" });
  assert.deepEqual(v2Command({ type: "thread.archive", commandId: "c", threadId: "t" }), { type: "thread.archive", commandId: "c", threadId: "t" });
});

test("unconfigured Codex and Claude instances count as enabled, as in T3 0.1.0", () => {
  const settings = { defaultModelSelection: { instanceId: "claudeAgent", model: "m" }, providerInstances: { codex: { driver: "codex", enabled: false } }, projectSettingsFolded: true };
  assert.deepEqual(selection(project, undefined, undefined, settings), { instanceId: "claudeAgent", model: "m" });
  assert.throws(() => selection(project, undefined, undefined, { ...settings, defaultModelSelection: { instanceId: "codex", model: "m" } }), /disabled/);
  assert.throws(() => selection(project, undefined, undefined, { ...settings, defaultModelSelection: { instanceId: "cursor", model: "m" } }), /disabled/);
});
