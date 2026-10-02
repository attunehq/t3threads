# Agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, design notes,
and release steps.

## T3 thread coordination

Use `t3threads` when asked to start, spin off, delegate to, message, or coordinate
T3 Code threads, or when related threads may contain useful context or overlapping
work. Prefer its MCP tools; use the `t3threads` CLI when MCP is unavailable.
An explicit request to create or message threads authorizes that action within
the requested scope. T3 threads are persistent conversations visible in T3;
use them when requested instead of harness subagents. Follow
[the t3threads skill](skills/t3threads/SKILL.md) for handoffs and notifications.
Send immediately by default, steering busy threads. Use enqueue only when asked
to wait for idle with durable retries.

## Commands

- `npm run check` runs the type checker, tests, and build. It must pass before
  you finish.
- `npm run dev -- ARGS` runs the CLI from source.
- `npm pack && npm run test:package` tests the installed package. Run it when you
  change packaging, `bin`, postinstall, or startup.

## Rules

- Define each command once in `src/cli.ts`. incur exposes it to the CLI, MCP, and
  the Fetch API; do not add separate handlers.
- Give read commands the `readOnly` MCP annotation and commands that change
  threads the `write` annotation. Commands that change state must call
  `requirePost`.
- Never open T3's database or change T3's credential files. Reads may use local
  files, including desktop preferences. Change T3 state only through its APIs.
- Send writes through `orchestration.dispatchCommand` over WebSocket. The HTTP
  dispatch route skips T3's thread and worktree bootstrap.
- Never print, log, or pass tokens in process arguments. Do not return raw errors
  from credential commands to callers.
- Persist a command ID before any durable dispatch, and reuse it on retry.
- Tests must not need accounts, a running T3, or model calls. Use the protocol
  fixture in `test/fixture.ts` for T3 behavior.
- When command behavior changes, update `README.md`, `skills/t3threads/SKILL.md`,
  and the MCP `instructions` in `src/cli.ts`.
- Keep `README.md` for users: what t3threads does, why they want it, and how to
  use it. Put development details in `CONTRIBUTING.md`.
