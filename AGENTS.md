# Agent instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, design notes,
and release steps.

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
- Never open T3's database or change T3's credential files. Reach T3 only through
  its HTTP and WebSocket APIs.
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
