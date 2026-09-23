# t3threads

Discover, search, summarize, classify, watch, and manage
[T3 Code](https://github.com/pingdotgg/t3code) conversations across machines from
a CLI, MCP server, or Fetch API. No T3 fork or separate Connect login required.

The commands are defined once with [incur](https://github.com/wevm/incur).
The installed package runs on Node.js 22.16+; it does not require Bun, a compiler,
or a second copy of T3. T3 Code must be running on the target machine.

## Install

Install with Node.js 22.16 or newer:

```sh
npm install --global t3threads
t3threads doctor
```

From a checkout:

```sh
npm ci
npm run check
npm link
t3threads doctor
```

To distribute an npm tarball:

```sh
npm pack
npm install --global ./t3threads-0.2.0.tgz
```

`npm pack --dry-run` shows exactly what ships. Runtime code is compiled JavaScript;
TypeScript, tests, and the development WebSocket server dependency are not shipped.

## CLI

Start with a cheap inventory, then narrow the work you want to inspect:

```sh
t3threads overview                         # all configured machines; no model calls
t3threads find 'work that overlaps with changing the billing webhook' --project Sorted
t3threads summarize local:THREAD_ID
t3threads list --env all
t3threads search 'billing webhook' --env all
```

`overview` and `find` default to all environments and exclude settled threads.
Use `--include-settled` to include those. `list`, `projects`, and literal `search`
default to local; `--env all` aggregates them. Aggregated results include
`results`, `errors`, and `complete`. Each thread reference contains its owning
environment. A linked local host is deduplicated by environment ID. An offline
host or failed thread read makes coverage incomplete, never an empty success.

`find` batches relevance decisions over recent thread text, with up to 100
threads per machine by default (`--max-threads`). It reads the latest eight user
turns (`--turns`), retains at most 12,000 characters per thread, and reports its
coverage. This is a recent-work scan; use literal `search` or paginated `read`
for exhaustive history. Relevance decisions and summaries are cached by content,
query, and model. Repeating an unchanged scan does not invoke the model again.

Summaries and relevance use the running local T3 server's saved
`textGenerationModelSelection` and provider instance. `--model-env NAME` selects
another local T3 home. The adapter currently supports Codex and Claude, invoking
their CLI with the selected model in a temporary directory with executable
tools/MCP/hooks disabled. T3 has no general-purpose summary RPC, so this small
adapter is the one model operation implemented outside T3. Unsupported providers
and custom launch arguments fail explicitly. It does not create a coding thread
to generate a summary. Model judgments are evidence to inspect, not proof of
test results or PR readiness.

```sh
t3threads projects
t3threads list --project /path/to/project
t3threads search "billing decision" --project PROJECT_ID
t3threads read local:THREAD_ID
t3threads read local:THREAD_ID --before CURSOR
t3threads read local:THREAD_ID --all --json
```

Project selectors accept an ID, exact title, or workspace path. Duplicate titles
require an ID. List/search exclude archived threads unless `--archived` is set.
Read returns the latest 20 user turns and a cursor for older history; `--turns N`
changes the window. Search scans titles and message text across history, newest
threads first. It stops at `--limit N` matches (default 20) and reports
`complete: false` when it stops early. Attachments and tool activity are not searched.

Outputs use incur's compact format by default. Use `--json` for JSON,
`--full-output` for the success/error envelope, and `--schema` or `--llms` for
machine-readable command discovery. Invalid input and failed operations exit nonzero.

### Start and continue work

```sh
t3threads start --project PROJECT_ID --checkout worktree \
  --prompt-file /tmp/task.txt --dry-run

t3threads start --project PROJECT_ID --checkout worktree \
  --prompt-file /tmp/task.txt

t3threads send local:THREAD_ID --caller local:CALLER_ID --prompt 'Continue with the tests.'
```

Use `--checkout current` to work in the project's existing checkout. Each worktree
gets its own `t3threads/<thread-id>` branch, starting from the local base unless
`--from-origin` is set. T3's setup script
runs unless `--skip-setup` is set. For a remote worktree, provide `--branch BASE`.
Projects must already exist in T3; the CLI does not silently add one.

Start preserves the project's saved model and provider options. If no default is
saved, specify `--provider INSTANCE --model MODEL`. Changing providers requires
both flags. New threads default to `--permission approval-required` and
`--mode default`; `--mode plan` starts a planning thread. Send preserves the
thread's settings and rejects busy, deleted, or archived threads.

Send requires `--caller ENV:THREAD_ID` (`caller` in MCP/API) to identify the
sending agent's T3 thread. Resolve it with `list` using the agent's current
worktree; provider conversation IDs are different. Bare caller IDs mean local,
independently of the recipient's `--env`. Existing send scripts must add caller.
Messages include the sender's thread title, reference, environment ID, and reply
target, explicitly identifying them as agent messages rather than user messages.
Reply targets use `local` on the same environment and `connect-ENV_ID` across
machines; direct-only setups must map that environment ID to a configured alias.
`--dry-run` includes the complete attributed message.

A new thread does not inherit the calling conversation. Include the task,
necessary context, completion criteria, and action limits in its prompt.
`status: accepted` means dispatch succeeded, not that the agent finished.
Use `read` to check `latestTurn`, `session`, and replies, or register a watcher
below. A failed write reports thread and
command IDs; inspect the thread before retrying to avoid duplicate work.

## MCP

```sh
t3threads --mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "t3threads": { "command": "t3threads", "args": ["--mcp"] }
  }
}
```

For the provider CLIs that T3 launches:

```sh
codex mcp add t3threads -- t3threads --mcp
claude mcp add --scope user t3threads -- t3threads --mcp
```

Register in the provider instance's configured home when it uses a custom home.
Existing provider sessions may need to be restarted to discover newly installed
MCP servers. `doctor` checks T3 access, shows the saved text-generation model,
reports whether a Jev credential is available, and prints the watcher state path.

Incur also supplies `t3threads mcp add` for client registration. The commands
are exposed directly as typed tools. Read tools and agent-launching tools have
distinct MCP annotations. Pass prompt text through the `prompt` input; stdin is
reserved for the MCP transport.

An optional [agent skill](skills/t3threads/SKILL.md) explains how to consult other
threads and hand over authorized work. `t3threads skills add` can also generate
and install command-reference skills through incur.

## Fetch API

```js
import { cli } from 't3threads'

const response = await cli.fetch(new Request('http://local/projects'))
console.log(await response.json())
```

The same handler exposes `/openapi.json` and `/mcp` (HTTP MCP). Read commands
accept query parameters. For writes, send all options in a JSON POST body:

```js
await cli.fetch(new Request('http://local/start', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    project: 'PROJECT_ID', checkout: 'worktree',
    prompt: 'Review this change and report findings.', dryRun: true
  })
}))
```

No HTTP listener starts automatically. This handler controls the host's T3
environments and can read prompt/config files. Keep it local, or provide your own
authentication and access controls before exposing it to other callers.

## Environments and authentication

Local discovery reads `T3CODE_HOME` or `~/.t3`. Use `--home PATH` for another local
data directory. On macOS, the CLI finds the matching executable inside T3's
desktop app. Elsewhere it uses `t3` on PATH. It verifies an exact version match
before calling T3's own `auth session issue` command, keeps the temporary bearer
in memory, and revokes it in `finally`. It never opens T3's SQLite database.
A forced process kill can leave a session until its one-hour expiry.

Optional configuration: `$XDG_CONFIG_HOME/t3threads/config.json`, or
`~/.config/t3threads/config.json` when that variable is unset:

```json
{
  "environments": {
    "sandbox": { "home": "/tmp/t3-sandbox" },
    "custom": {
      "home": "/path/to/t3-home",
      "command": ["/path/to/t3"]
    },
    "workstation": {
      "url": "https://your-t3-host.example",
      "tokenEnv": "T3_WORKSTATION_TOKEN"
    }
  }
}
```

Select with `--env workstation` or `workstation:THREAD_ID`. Direct remote access
uses an existing T3 environment bearer session from the named environment
variable. Remote URLs require HTTPS or a loopback SSH tunnel. Tokens are never
printed, passed in process arguments, or forwarded through HTTP redirects.
Cloud identity tokens cannot replace environment sessions.

T3 Connect discovery reuses T3's existing signed-in account. On macOS, a read-only
native adapter opens T3's encrypted Clerk cache with its existing Keychain Safe
Storage key, asks Clerk for the same `t3-relay` session JWT the T3 client uses,
and follows T3's DPoP connection protocol. It never changes T3's credential files
or stores a second cloud login. Per-environment session credentials and DPoP keys
are kept in t3threads' private state and renewed through the same account. Sign-out
in T3 is respected on the next connection. Connect targets are named
`connect-ENVIRONMENT_UUID`; `environments` shows their friendly labels.

A local T3 server must be running. The GUI may be closed once it has established
the saved sign-in; headless-only OAuth sign-in cannot currently bootstrap a relay
client session. Windows/Linux encrypted desktop credential adapters are not yet
implemented. Direct named environment sessions remain available there.

Optional `connect` configuration can override `home`, `relayUrl`, `issuerUrl`, or
`jwtTemplate` for another T3 installation. Normal installations need none of these.

## Watch other threads

```sh
t3threads watch --threads local:THREAD_A --threads connect-ENV_ID:THREAD_B \
  --caller local:CALLER_ID --condition all-completed

t3threads watch --threads local:THREAD_A --caller local:CALLER_ID \
  --condition text --prompt 'The thread says the implementation and tests are done and provides its PR URL.'

t3threads watchers
t3threads unwatch WATCH_ID
```

In MCP, `threads` is an array, `caller` is the calling T3 thread reference, and
`condition` is an enum. Resolve the caller from `list` by its current worktree or
thread ID; do not confuse a provider's conversation ID with a T3 thread ID.

Conditions: `all-completed` (every latest turn succeeded), `all-idle` (none are
running), `any-error`, `changed`, `text` (caller-defined prompt), or `jev`
(caller-defined prompt with probability threshold, default 0.9). A completed
turn is not a guarantee that the overall task or PR is ready. The watched set is
explicit and frozen at registration, so newly opened threads cannot extend it.
An unavailable/missing thread prevents a condition from triggering. Custom
conditions use cached recent text with disclosed coverage and a 100,000-character
evaluation budget; split larger sets or use a deterministic condition.

Watchers persist immediately and start a detached worker. Default polling is
30 seconds (`--interval-seconds`), with a 24-hour lifetime (`--expires-in-hours`).
The worker continues after the CLI/MCP exits. Registration and any later CLI/MCP
startup restart pending watchers after a worker/process crash or machine reboot.
For unattended restart at login, run `t3threads watch-run` under a service manager.
No model runs for deterministic status checks. Semantic decisions are reused
until the input changes.

On a match, a one-shot event is persisted and a follow-up wakes the caller using
its existing model and settings. Busy callers retain a pending notification until
they become idle. The notification command ID is persisted before dispatch and
T3's command receipts deduplicate crash/lost-response retries. `watchers` shows
evidence, errors, and delivery state. Cancellation prevents undelivered work; it
cannot recall a message already dispatched. `--events-only` records the event
without waking a caller. Expiration also ends pending delivery attempts.

`manage THREAD --action interrupt|archive|unarchive|rename` uses T3 orchestration;
renaming requires `--title`. `--dry-run` returns the command without applying it.

## Jev classifiers

Set `TYPESAFE_API_KEY`, or on macOS store the key as a generic password in the
login Keychain with service `t3threads.typesafe` and account equal to your macOS
username. The CLI, MCP server, and watcher worker read that item automatically;
the environment variable takes precedence. `doctor` reports availability without
revealing the key. Then:

```sh
t3threads classify --project Sorted --questions-json \
  '{"overlap":{"type":"noul","instructions":"Does this work change billing webhooks?"},"area":{"type":"choice","instructions":"What area is being changed?","criteria":{"billing":"Payments or subscriptions","other":"Other work"}}}'
```

MCP accepts the same object directly in `questions`. Jev supports `noul`, `choice`,
and `score` questions, batched per thread and cached by content/questions/model.
Responses preserve probabilities, the returned model ID, and token usage.
The default model is `jev-1.13.0`; `T3THREADS_JEV_MODEL` can override it.
Thread text is sent to TypeSafe only when a Jev operation is explicitly selected.

State is in `$T3THREADS_STATE_DIR`, or `$XDG_STATE_HOME/t3threads`, defaulting to
`~/.local/state/t3threads`. The directory is private and its database uses mode
0600. This is t3threads' own database; T3's database is never opened. It contains
cached thread text, model results, watch records, and environment session keys.
Deleting it clears these caches and registrations.

## Development

```sh
npm ci
npm run check
npm run dev -- doctor --json
```

The tests cover native credential reuse, DPoP signatures/exchange, cross-machine
partial results, pagination, model-result caching, Jev validation, durable watcher
delivery/recovery/cancellation, a detached worker, CLI/API validation, and real
stdio/HTTP MCP transports against disposable protocol fixtures. They do not
require accounts or invoke models.

Compatibility target: T3 `0.0.43-nightly.20260922.2110`, orchestration protocol 1,
plus the known `0.0.42` legacy descriptor (which omits the protocol field).
These are application APIs, not a promised stable third-party SDK. Reads use the
HTTP shell and per-thread snapshots. Writes use `orchestration.dispatchCommand`
over authenticated WebSocket, including T3's thread/worktree bootstrap. The HTTP
dispatch route does not perform that bootstrap.

CI tests Node 22 and 24 on macOS, Linux, and Windows. It also installs the packed
tarball into a temporary global prefix and checks the CLI and stdio MCP startup
outside the checkout, without install scripts or development dependencies.
Run this check locally with `npm pack && npm run test:package`.

### Releases

The release workflow checks, packs, and smoke-tests the package on a `v*` tag.
It publishes the tested tarball to npm, then attaches it and its SHA-256 checksum
to a GitHub release. The tag must match the version in `package.json`.

For a release, update the version with `npm version patch` (or `minor`/`major`),
then push the release commit and its version tag. Use a new version for every
npm release; published versions cannot be overwritten.

Publishing uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
with GitHub organization `attunehq`, repository `t3threads`, and workflow file
`release.yml`. The npm package's trusted publisher must allow `npm publish`.
No npm publishing token is stored in GitHub. The initial publication requires
an npm maintainer login before this package-level trust can be configured.

MIT licensed. Independent project; not affiliated with T3.
