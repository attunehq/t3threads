# t3threads

Read, search, and start [T3 Code](https://github.com/pingdotgg/t3code) conversations
from a CLI, an MCP server, or a Fetch API. No T3 fork required.

The commands are defined once with [incur](https://github.com/wevm/incur).
The installed package runs on Node.js 22.16+; it does not require Bun, a compiler,
or a second copy of T3. T3 Code must be running on the target machine.

## Install

From a checkout (the package has not been published yet):

```sh
npm ci
npm run check
npm link
t3threads doctor
```

To distribute an npm tarball:

```sh
npm pack
npm install --global ./t3threads-0.1.0.tgz
```

After publication, installation will be `npm install --global t3threads`.
`npm pack --dry-run` shows exactly what ships. Runtime code is compiled JavaScript;
TypeScript, tests, and the development WebSocket server dependency are not shipped.

## CLI

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

t3threads send local:THREAD_ID --prompt 'Continue with the tests.'
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

A new thread does not inherit the calling conversation. Include the task,
necessary context, completion criteria, and action limits in its prompt.
`status: accepted` means dispatch succeeded, not that the agent finished.
Use `read` to check `latestTurn`, `session`, and replies. Completion does not
automatically notify the calling conversation. A failed write reports thread and
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

Incur also supplies `t3threads mcp add` for client registration. The eight commands
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

**T3 Connect login, discovery, renewal, and cross-machine aggregation are not
implemented yet.** Named direct environments work today. Each command targets one
environment; a thread stays on the server that owns it.

## Development

```sh
npm ci
npm run check
npm run dev -- doctor --json
```

The tests cover pagination, filtering, credential cleanup, version mismatches,
WebSocket dispatch, CLI/API validation, and real stdio/HTTP MCP transports against
a disposable T3 protocol fixture. They do not require accounts or invoke models.

Compatibility target: T3 `0.0.43-nightly.20260922.2110`, orchestration protocol 1.
These are application APIs, not a promised stable third-party SDK. Reads use the
HTTP shell and per-thread snapshots. Writes use `orchestration.dispatchCommand`
over authenticated WebSocket, including T3's thread/worktree bootstrap. The HTTP
dispatch route does not perform that bootstrap.

CI tests Node 22 and 24 on macOS, Linux, and Windows. The release workflow tests
and packs an installable tarball on a `v*` tag; it does not publish to npm.

MIT licensed. Independent project; not affiliated with T3.
