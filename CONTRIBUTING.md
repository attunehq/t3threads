# Contributing to t3threads

This guide covers development, design constraints, testing, and releases. For
what t3threads does and how to use it, read the [README](README.md).

## Set up

You need Node.js 22.16 or later.

```sh
npm ci
npm run check
npm run dev -- doctor --json
```

- `npm run check` runs the type checker, the tests, and the build.
- `npm run dev -- ARGS` runs the CLI from source.
- `npm link` puts your checkout on your `PATH` as `t3threads`.

### Contributor skills

`npm ci` also installs shared agent skills for Codex (`.agents/skills`) and
Claude Code (`.claude/skills`):

- From `jssblck/agents`: `babysit`, `code-craft`, `gh-stack`, `merge-open-prs`,
  `resolve-pr-conflicts`, `ship-it`, `tag-release`, and `testing-craft`.
- From `typesafe-ai/skills`: `typesafe-ai`.

The postinstall script reuses a cache in the shared Git directory, so worktrees
do not download the skills again. Run `npm run skills:update` to refresh them
from upstream with the pinned `skills@1.5.22` installer.

Downloads and `skills-lock.json` are ignored by Git. The lock records upstream
content but does not pin it. The update refuses to replace skills that the
repository tracks.

Skill setup is best effort. A failed download prints how to retry and does not
fail the install. CI and published npm installs skip it. Set
`T3THREADS_SKIP_POSTINSTALL=1` to skip it in a checkout.

These contributor skills are separate from `skills/t3threads`, the agent skill
that ships to users.

## Project layout

| Path | Contents |
| --- | --- |
| `src/cli.ts` | Every command, defined once with [incur](https://github.com/wevm/incur). The same definitions drive the CLI, stdio MCP, and the Fetch API. |
| `src/bin.ts` | CLI entry point. Starts the delivery worker if work is pending. |
| `src/client.ts` | T3 discovery, local session issue, HTTP and WebSocket RPC. |
| `src/environments.ts` | Configuration, environment resolution, and cross-machine fan-out. |
| `src/connect.ts`, `src/native-auth.ts` | T3 Connect through T3's native macOS credential cache. |
| `src/threads.ts` | Thread reads, search, and `start`/`send` commands. |
| `src/intelligence.ts` | Summaries, semantic `find`, and Jev. |
| `src/watchers.ts`, `src/queue.ts`, `src/worker.ts` | Watchers, queued messages, and the delivery worker. |
| `src/service.ts`, `src/runtime-update.ts` | macOS LaunchAgent and upgrade detection. |
| `src/state.ts` | t3threads' own SQLite state. |
| `skills/t3threads` | Agent skill for users. |
| `scripts` | Postinstall, contributor skill updates, and the package test. |

When you change command behavior, update the README, `skills/t3threads/SKILL.md`,
and the MCP `instructions` in `src/cli.ts` to match.

## Design notes

### T3 compatibility

The compatibility target is T3 `0.0.43-nightly.20260922.2110` with orchestration
protocol 1, plus the `0.0.42` and `0.0.43` legacy descriptors, which omit the
protocol field. These are T3 application APIs, not a stable third-party SDK.

Reads use T3's HTTP shell and per-thread snapshots. Writes use
`orchestration.dispatchCommand` over an authenticated WebSocket. That path runs
T3's thread and worktree bootstrap; the HTTP dispatch route does not, so do not
use it for writes.

New-thread model and permissions share one `server.getSettings` snapshot from
the destination API. `projectSettingsOverrides[projectId]` overrides the machine's
`defaultModelSelection` and `defaultRuntimeMode`, matching T3's
`resolveProjectSettings`. Explicit CLI options override the corresponding
values; fully explicit model/provider and permission skip the settings lookup.
Missing or invalid effective settings fail before dispatch. Do not substitute
the caller's settings or read T3's settings files. T3's cross-machine settings
controls persist values to each selected server; the destination is authoritative.

Before `projectSettingsFolded` is true, a legacy project model sits above the
machine default and below the current project overrides. After folding, ignore
that field so stale catalog data cannot undo a reset. An explicit null project
model clears the default. A disabled project model provider falls back to the
machine model. Preserve all options on an inherited selection; a different
explicit model starts without the previous model's options.

### Local authentication

On macOS, t3threads finds the `t3` executable inside T3's desktop app. Elsewhere
it uses `t3` on `PATH`. The executable's version must match the server version
exactly. t3threads then runs T3's `auth session issue`, keeps the bearer token in
memory, and revokes it in a `finally` block. A forced kill can leave the session
open until it expires after one hour.

t3threads never opens T3's SQLite database.

### T3 Connect

The native adapter is read-only. It opens T3's encrypted Clerk cache with the
existing Keychain Safe Storage key, asks Clerk for the same `t3-relay` session
JWT that the T3 client uses, and follows T3's DPoP connection protocol. It never
changes T3's credential files and never stores a second cloud login.
Per-environment session credentials and DPoP keys live in t3threads' state and
are renewed through the same account. A sign-out in T3 takes effect on the next
connection.

Headless OAuth sign-in cannot yet bootstrap a relay client session. Windows and
Linux adapters for T3's encrypted desktop credentials are not implemented.

The `connect` configuration block can override `home`, `relayUrl`, `issuerUrl`,
and `jwtTemplate`, for example to test against a non-production T3 installation.

### Direct connections

Remote URLs must use HTTPS or a loopback address, such as an SSH tunnel. Tokens
are never printed, passed in process arguments, or forwarded through HTTP
redirects. Cloud identity tokens cannot replace T3 environment sessions.

### Model calls

T3 has no general-purpose summary RPC, so this adapter is the one model
operation that t3threads implements outside T3. It reads the running T3
server's `textGenerationModelSelection` and provider instance, then runs the
Codex or Claude CLI with that model in a temporary directory, with tools, MCP,
and hooks disabled. Unsupported providers and custom launch arguments fail
explicitly. The adapter never creates a coding thread.

Summaries, relevance decisions, and Jev results are cached by content, question,
and model.

### Delivery

Detached workers and the macOS service share one worker lease, so only one
process delivers at a time. Before dispatch, the worker persists a stable command
ID. After a crash or lost response, it reuses that ID so T3's command receipts
deduplicate the retry.

Queued messages are delivered in enqueue order per recipient, including
environment aliases. The idle check and the dispatch are separate operations, so
another client can start a turn between them.

Semantic watcher conditions evaluate cached recent text with a 100,000-character
budget.

### macOS service

The LaunchAgent is `~/Library/LaunchAgents/com.attune.t3threads.plist`. A private
launcher at `service/T3 Threads` in the state directory gives Login Items a
readable name. The launcher executes Node directly, without a supervisor
process, and needs no signing certificate.

The plist preserves `PATH`, the state directory, `T3CODE_HOME`,
`XDG_CONFIG_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`. It does not copy other
shell variables, so shell secrets stay out of the plist.

The persistent worker checks the installed runtime every five seconds. When the
files change and then stay stable, it finishes its delivery pass, releases the
lease, and exits so that launchd loads the new code. This works with
`--ignore-scripts` and with same-version local builds. Reinstalling identical
code does not restart the worker.

## Tests

The tests use disposable protocol fixtures. They need no accounts and make no
model calls. They cover native credential reuse, DPoP, cross-machine partial
results, pagination, caching, Jev validation, watchers, steering, queued
messages, the detached worker, the service, CLI and API validation, and real
stdio and HTTP MCP transports.

macOS is the primary test environment. On Linux and Windows, CI is the only
testing, so support there is unproven against real T3 installations.

CI runs `npm run check` on Node 22 and 24, on macOS, Linux, and Windows. It then
runs the package test, which installs the packed tarball into a temporary global
prefix without install scripts or development dependencies. The package test
checks CLI and stdio MCP startup outside the checkout and confirms that the
published postinstall hook does not install contributor skills. Run it locally:

```sh
npm pack
npm run test:package
```

`npm pack --dry-run` lists what ships. The package contains compiled JavaScript,
the user skill, and the postinstall hook. TypeScript sources, tests, and
development dependencies do not ship.

## Releases

Pushing a `v*` tag runs the release workflow. It checks, packs, and tests the
package, publishes the tested tarball to npm, and attaches the tarball and its
SHA-256 checksum to a GitHub release. The tag must match the version in
`package.json`.

To release:

1. Run `npm version patch --no-git-tag-version` (or `minor` or `major`).
2. Set the same version in `src/cli.ts`.
3. Commit the change.
4. Tag the commit `vX.Y.Z`.
5. Push the commit and the tag.

Every npm release needs a new version. npm does not let you overwrite a
published version.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
for GitHub organization `attunehq`, repository `t3threads`, and workflow
`release.yml`. GitHub stores no npm token.
