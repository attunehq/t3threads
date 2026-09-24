# t3threads

See and coordinate all of your [T3 Code](https://github.com/pingdotgg/t3code)
threads, on every machine, from one place.

When you run many agent threads across a laptop, a workstation, and a remote
box, simple questions get hard to answer. What is running right now? Is another
thread already changing this code? Did that task finish? t3threads answers them
from your terminal. It also gives your agents the same tools over MCP, so they
can check for overlapping work, hand off tasks, and wait for each other.

- **One view across machines.** List, search, and read threads on every machine
  linked to your T3 account.
- **Find overlapping work.** Describe a change in plain language and get the
  threads that touch it.
- **Catch up quickly.** Summarize a long thread instead of scrolling through it.
- **Hand off and follow up.** Start a new thread with a task, or message an
  existing one now or when it becomes idle.
- **Get notified.** Wake a thread when other threads finish, fail, or reach a
  point you describe.

t3threads uses your existing T3 sign-in. You do not need another account or a
modified T3.

## Let your agent set it up

Copy this prompt into your coding agent in T3:

```text
Set up t3threads so my agents can find related work and coordinate T3 threads.
Read https://github.com/attunehq/t3threads/blob/main/README.md and follow its
current setup instructions for my platform.

Before running setup commands, explain the README's "Data access and macOS
prompts" section: what T3 data is read, what is stored locally, and when thread
text goes to a model provider. Warn me before commands that may trigger macOS
app-data access, T3 Safe Storage Keychain prompts, or a background-item notice.
Explain the expected requester and purpose, and let me handle system dialogs.
Never ask me to paste my Mac password or credentials into the chat.

1. Check the prerequisites, install or update t3threads globally, and run
   `t3threads doctor`. Fix setup issues you can resolve; tell me if I need to
   open T3 or sign in through the desktop app.
2. Register the t3threads MCP server with the provider CLIs I use in T3. Check
   for custom provider home directories and configure those actual homes.
   Preserve existing configuration and avoid duplicate registrations.
3. Install the t3threads agent skill where those providers will discover it.
   Add a short note to their persistent agent instructions to use t3threads
   when related threads may contain useful context, to check for overlapping
   work, and when I ask to delegate or follow up in another T3 thread. Follow
   the skill's guidance for handoffs and completion notifications.
   Instruct agents to omit model and permission overrides so new threads use
   the destination project's T3 settings, then that machine's defaults. Only
   pass explicit overrides when I request them.
4. On macOS, install and check the background service so queued messages and
   watcher notifications keep working after login. On other platforms, explain
   how to run `t3threads watch-run` under a service manager.
5. Verify access with `t3threads environments` and `t3threads overview`. Report
   unreachable machines or other gaps. Leave optional Jev/TypeSafe setup alone
   unless I ask for it.
6. Summarize what you configured and any remaining steps. Tell me how to start
   a fresh agent session and verify it can see the skill and call the t3threads
   overview tool. Do not call setup complete based on `doctor` alone.
```

Installing the CLI does not give your agents MCP access or instructions to use
it. Start a new thread after setup, then try: "Use t3threads to show me my open
threads and find any work related to this project." You can explicitly ask it
to delegate with "Start a new T3 thread for ..."; installation alone does not
make agents delegate automatically.

## Requirements

- Node.js 22.16 or later.
- T3 Code 0.0.42 or later, running on each machine you want to reach. You can
  close the T3 window, but the T3 server must keep running.
- To reach your other machines automatically, sign in to T3 Connect in the T3
  desktop app.

### Platform support

t3threads is primarily tested on macOS. Linux and Windows support is unproven,
but should work. If something breaks,
[open an issue](https://github.com/attunehq/t3threads/issues).

Some features work only on macOS for now:

- Automatic access to your other machines through T3 Connect. On Linux and
  Windows, add remote machines yourself (see
  [Connect other machines](#connect-other-machines)).
- The [background service](#keep-delivery-running). On Linux and Windows, run
  `t3threads watch-run` under your own service manager.
- Storing the TypeSafe key in the Keychain. Use `TYPESAFE_API_KEY` instead.

## Data access and macOS prompts

t3threads needs access to T3's local connection information and, for T3 Connect,
your saved sign-in. Here is what it uses:

| Data | Why t3threads needs it |
| --- | --- |
| T3's runtime metadata in `~/.t3/userdata/server-runtime.json` | Find the running local server. It then uses T3's CLI to issue a temporary session. |
| T3's saved sign-in in `~/.t3/userdata/clerk-tokens.json` and its macOS Safe Storage Keychain item | Unlock the existing sign-in and authenticate with T3's sign-in provider and Connect relay to reach your linked machines. |
| Project metadata, thread messages and status, and model settings | Read and coordinate your work through T3's HTTP and WebSocket APIs. t3threads never opens T3's database or changes its credential files. |
| Its own [local state directory](#your-data) | Store cached thread text, model results, queued messages, watchers, and per-machine connection credentials and keys. |

The T3 paths above use the default home; custom T3 homes use their corresponding
files. Reading threads through MCP makes their contents available to your agent.
`summarize`, `find`, and `text` watchers send selected thread text through the
model provider configured in T3. Optional Jev features send text to TypeSafe.
See [Models and privacy](#models-and-privacy) for details.

On macOS, you may see these dialogs or notices, depending on your OS version,
existing permissions, and how you launch the command:

- **Access to data from other apps.** macOS may ask whether the app running the
  command can access other apps' data. The requester can be your terminal or
  agent host rather than "t3threads". Check that it matches the setup you just
  started; t3threads needs the T3 data described above.
- **Keychain access.** T3 Connect uses macOS's `security` helper to read a key
  named `t3code Safe Storage`, `T3 Code (Nightly) Safe Storage`, or
  `T3 Code Safe Storage`. A dialog may name `security` as the requester and ask
  for your login Keychain password, usually your Mac login password. Enter it
  only in the macOS dialog. **Allow** grants this access once; **Always Allow**
  lets that requester access the item again without asking. If the requester is
  `security`, this trusts the helper for that item, not just t3threads. Denying
  access prevents t3threads from unlocking that sign-in for Connect. See Apple's
  [Keychain access guidance](https://support.apple.com/guide/keychain-access/kyca1243/mac).
- **Background item added.** Installing the optional macOS service may produce
  a login/background-item notice. The service appears as **T3 Threads** in
  System Settings under General > Login Items & Extensions (the name varies by
  macOS version). It keeps queued messages and watcher notifications moving.
  See [Keep delivery running](#keep-delivery-running).

Your setup agent should explain these before triggering them and leave the
dialogs to you. If access is denied or times out, resolve the relevant permission
and rerun the failed check. Do not paste passwords or tokens into the agent chat.

## Install

```sh
npm install --global t3threads
t3threads doctor
```

`doctor` confirms that t3threads can reach T3 and shows the model it will use for
summaries.

To update, run `t3threads update`. Then restart your agents' sessions so they load
the new version.

## Give your agents access

Most of the value comes from the agents inside T3 using t3threads. Register the
MCP server with the provider CLIs that T3 launches:

```sh
claude mcp add --scope user t3threads -- t3threads --mcp
codex mcp add t3threads -- t3threads --mcp
```

For other MCP clients, run `t3threads mcp add`, or configure the server directly:

```json
{
  "mcpServers": {
    "t3threads": { "command": "t3threads", "args": ["--mcp"] }
  }
}
```

If a provider uses a custom home directory in T3, register the server in that
home.

Next, install the agent skill. It teaches agents when to consult other threads
and how to hand off work safely:

```sh
npx skills add attunehq/t3threads
```

Start a new thread so the agent picks up the server, then ask things like:

- "Is any other thread working on the billing webhook?"
- "Summarize what the workstation thread decided about the migration."
- "Start a worktree thread that writes tests for this module, and tell me when
  it finishes."

## Use it from the terminal

Every MCP tool is also a command. Run `t3threads COMMAND --help` for all options.
Output is compact by default; add `--json` for JSON.

A thread reference has the form `ENV:THREAD_ID`, for example `local:abc123` or
`connect-ENV_ID:abc123`. Commands print these references wherever a thread
appears.

`overview` and `find` cover every machine. `projects`, `list`, and `search` cover
only the local machine unless you pass `--env all` or `--env NAME`.

### See what is going on

```sh
t3threads overview
t3threads overview --project my-app
```

`overview` lists open threads on every machine. It is fast and makes no model
calls. If a machine is offline, the result lists it in `errors` and reports
`complete: false`. A missing machine is never shown as having no threads.

### Find related work

```sh
t3threads find 'work that overlaps with changing the billing webhook'
t3threads search 'billing webhook' --env all
```

`find` asks a model which open threads relate to your description. It checks
recent activity: the latest 8 user turns of up to 100 threads per machine. Use
`--turns` and `--max-threads` to widen the scan. The result reports what it
covered.

`search` matches literal text in thread titles and full message history. It does
not search attachments or tool output.

`overview` and `find` skip settled threads unless you add `--include-settled`.
`list` and `search` skip archived threads unless you add `--archived`.

### Read and summarize a thread

```sh
t3threads projects
t3threads list --project ~/code/my-app
t3threads summarize local:THREAD_ID
t3threads read local:THREAD_ID
t3threads read local:THREAD_ID --all
```

You can select a project by its ID, exact title, or workspace path. `read` shows
the latest 20 user turns and a cursor. Pass the cursor to `--before` for older
history, or use `--all` for the complete conversation.

Summaries and `find` results come from a model. Treat them as leads to check,
not as proof that tests passed or a PR is ready.

### Start a new thread

```sh
t3threads start --project my-app --checkout worktree --prompt-file task.md --dry-run
t3threads start --project my-app --checkout worktree --prompt-file task.md
```

`--dry-run` shows what t3threads would send without starting anything.

The new thread does not see your current conversation. Write a self-contained
prompt: the task, the context it needs, what "done" means, and what it must not
do (for example, push or open PRs).

- `--checkout worktree` creates a worktree on a new `t3threads/THREAD_ID` branch,
  based on your local branch. Add `--from-origin` to start from the remote, or
  `--skip-setup` to skip the project's setup script. On a remote machine, also
  pass `--branch BASE`.
- `--checkout current` works in the project's existing checkout.
- The thread inherits the destination project's model setting, then that
  machine's default, including the provider instance and model options. A
  project override with a disabled or missing provider falls back to the
  machine model, as in T3. Clearing the project default explicitly means no
  default model; choose one in T3 or pass `--provider INSTANCE --model MODEL`.
- `--model MODEL` overrides the model within the inherited provider. Changing
  the model clears inherited model options; keeping the same model preserves
  them. `--provider INSTANCE --model MODEL` selects both explicitly.
- New threads inherit T3's permission setting for the destination project on
  the destination machine. If the project has no override, they use that
  machine's default. This applies to local, direct, and T3 Connect environments;
  settings on the calling machine or parent thread do not override the target.
- To override inheritance, pass `--permission approval-required`,
  `--permission auto-accept-edits`, `--permission auto`, or
  `--permission full-access`. MCP uses the same values in `permission`; omit
  that field to inherit. Check `runtimeMode` in the `--dry-run` output.
- Use `--mode plan` to start in plan mode; interaction mode is separate from
  permissions.

The project must already exist in T3.

T3's settings for all projects or all machines are respected through the values
saved on each destination. For example, a project's Auto override on your
workstation wins over that workstation's Supervise default; the same project
on your laptop uses the laptop's own settings. t3threads reads settings on each
start. If T3 cannot supply a supported permission setting, the command fails
before creating a thread; fix the setting or pass `--permission` explicitly.

A result of `accepted` means that T3 received the task, not that the task is
done. Use `read` or a [watcher](#get-notified-when-threads-finish) to follow it.
If a start fails, check the reported thread before you try again, so that you do
not start the same work twice.

### Message another thread

```sh
t3threads send local:THREAD_ID --caller local:MY_THREAD_ID \
  --prompt 'Continue with the tests.'

t3threads send local:THREAD_ID --caller local:MY_THREAD_ID --steer \
  --prompt '1Password is unlocked. Continue where you left off.'

t3threads send local:THREAD_ID --caller local:MY_THREAD_ID --enqueue \
  --prompt 'When this turn finishes, run the integration tests.'
```

Choose how the message arrives:

- Plain `send` delivers to an idle thread. It fails if the thread is busy.
- `--steer` delivers now. If a turn is running, the agent receives the message
  during that turn, when its provider allows. If the thread is idle, a new turn
  starts.
- `--enqueue` waits until the thread is idle, then delivers. Messages to the same
  thread arrive in the order you queued them. If the recipient's machine is
  offline, t3threads keeps trying. If the recipient was deleted or archived, the
  message shows as `failed`. Use `queued` to check messages and
  `unqueue QUEUE_ID` to cancel one before it is sent.

The recipient keeps its own model and settings.

`--caller` is the T3 thread that sends the message. The recipient sees the
sender's title and a reply address, marked as a message from another agent, not
from you. Find your own thread ID with `list`. A provider's session ID is not a
T3 thread ID.

Queued messages survive restarts and crashes, and a retry after a crash does not
deliver a message twice. The machine that queued a message must stay on until
the message is delivered. On macOS, install the
[background service](#keep-delivery-running) so delivery continues after you log
in again.

### Get notified when threads finish

```sh
t3threads watch --threads local:THREAD_A --threads connect-ENV_ID:THREAD_B \
  --caller local:MY_THREAD_ID --condition all-completed

t3threads watch --threads local:THREAD_A --caller local:MY_THREAD_ID \
  --condition text --prompt 'The thread says the tests pass and gives a PR URL.'

t3threads watchers
t3threads unwatch WATCH_ID
```

When the condition matches, t3threads sends a message to the caller thread,
which wakes it up. If the caller is busy, the message waits until it is idle. To
record the match without waking a thread, use `--events-only` instead of
`--caller`.

| Condition | Matches when |
| --- | --- |
| `all-completed` | The latest turn of every watched thread succeeded. |
| `all-idle` | No watched thread is running. |
| `any-error` | Any watched thread reports an error. |
| `changed` | Any watched thread changes after you create the watcher. |
| `text` | A model decides that your `--prompt` is true. |
| `jev` | A [Jev classifier](#jev-classifiers) decides that your `--prompt` is true, with at least `--threshold` probability (default 0.9). |

A watcher fires once. It checks every 30 seconds and expires after 24 hours; change
these with `--interval-seconds` and `--expires-in-hours`. It keeps running after
the command or MCP session exits. The set of watched threads is fixed when you
create the watcher. If a watched thread is unreachable, the watcher does not fire.
`all-completed` means that the latest turns succeeded, not that the work is
ready to merge.

`text` and `jev` conditions read recent activity from the watched threads, up
to 100,000 characters in total. For larger sets, watch fewer threads or use one
of the status conditions.

`watchers` shows each watcher's state, evidence, and errors. `unwatch` stops a
watcher, including a notification that was not yet sent.

### Manage threads

```sh
t3threads manage local:THREAD_ID --action interrupt
t3threads manage local:THREAD_ID --action archive
t3threads manage local:THREAD_ID --action unarchive
t3threads manage local:THREAD_ID --action rename --title 'Billing webhook retries'
```

Add `--dry-run` to preview the change.

## Keep delivery running

A background worker delivers queued messages and watcher notifications.
t3threads starts it when needed. After a crash or reboot, the next t3threads
command or MCP session restarts pending work. On macOS, install the worker as a
login service so it runs without you:

```sh
t3threads service install
t3threads service status
```

The service starts at login, restarts after a crash, and loads new versions of
t3threads automatically. It appears as **T3 Threads** in Login Items, and it
writes `service.log` to the [state directory](#your-data). Use `service restart`
to reload it. Use `service uninstall` to remove it; queued messages and watchers
stay.

Install the service from a permanent installation, such as the global npm
install above. If you move Node or t3threads, run `service install` again.

The service does not see environment variables from your shell. Store the
TypeSafe key in the Keychain. A direct connection that uses `tokenEnv` works
from the service only if that variable is set in the service's environment.

On Linux and Windows, run `t3threads watch-run` under your own service manager.

## Connect other machines

### T3 Connect (macOS)

If you are signed in to T3 Connect in the T3 desktop app, t3threads finds your
other machines automatically. Run `t3threads environments` to see them. Each one
is named `connect-ENVIRONMENT_ID`.

t3threads reads T3's saved sign-in and never changes it. If you sign out of T3,
t3threads loses access too. Sign in through the desktop app at least once;
headless sign-in does not work. Every machine you want to reach must be running
T3.

### Direct connections and other T3 data directories

Add environments to `~/.config/t3threads/config.json`, or to
`$XDG_CONFIG_HOME/t3threads/config.json` if you set that variable:

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

- `home` points to another T3 data directory on this machine. `command` sets the
  `t3` executable to use with it.
- `url` connects straight to a remote T3 server. `tokenEnv` names the environment
  variable that holds an existing T3 session token for that server. The URL must
  use HTTPS, or point to a local SSH tunnel.

Use the name with `--env workstation`, or in a thread reference such as
`workstation:THREAD_ID`. By default, `local` is `$T3CODE_HOME` or `~/.t3`. Use
`--home PATH` to change it for one command.

## Models and privacy

- `overview`, `projects`, `list`, `search`, `read`, and all commands that change
  threads make no model calls.
- `summarize`, `find`, and `text` watchers use the text-generation model you
  selected in T3's settings. t3threads runs it through your local Codex or Claude
  CLI, with tools disabled. Other providers are not supported yet. Use
  `--model-env NAME` to take the model setting from another local T3
  environment.
- Model results are cached. Asking the same question about unchanged threads
  does not call the model again.
- `classify` and `jev` watchers send thread text to TypeSafe, only when you use
  them.

t3threads never opens T3's database and never stores a separate cloud login.

### Your data

t3threads keeps its own state in a private directory: `$T3THREADS_STATE_DIR` if
set, otherwise `$XDG_STATE_HOME/t3threads`, otherwise `~/.local/state/t3threads`.
The directory holds cached thread text, model results, watchers, queued messages,
and connection keys. Deleting it clears all of these, including messages that
were not yet delivered.

## Jev classifiers

`classify` asks many threads the same structured questions at once and returns
probabilities, for example "Does this thread change billing webhooks?" It uses
Jev from [TypeSafe](https://typesafe.ai) and needs a TypeSafe API key.

Set `TYPESAFE_API_KEY`, or store the key in the macOS Keychain:

```sh
security add-generic-password -s t3threads.typesafe -a "$USER" -w
```

Then ask your questions:

```sh
t3threads classify --project my-app --questions-json \
  '{"overlap":{"type":"noul","instructions":"Does this work change billing webhooks?"},"area":{"type":"choice","instructions":"What area is being changed?","criteria":{"billing":"Payments or subscriptions","other":"Other work"}}}'
```

Jev supports `noul`, `choice`, and `score` questions. In MCP, pass the same
object as `questions`. Set `T3THREADS_JEV_MODEL` to use a model other than the
default `jev-1.13.0`.

## Use it from JavaScript

The package exports a Fetch handler with the same commands:

```js
import { cli } from 't3threads'

const response = await cli.fetch(new Request('http://local/projects'))
console.log(await response.json())
```

Read commands take query parameters. Commands that change threads take a JSON
`POST` body:

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

The handler also serves `/openapi.json` and HTTP MCP at `/mcp`. It does not start
a server on its own. It can control your T3 threads and read local files, so
keep it on your machine or add your own authentication before you expose it.

## Troubleshooting

- Run `t3threads doctor` first.
- `complete: false` means that a machine was unreachable or a limit was reached.
  Check `errors` and the reported coverage.
- `MATCHING_CLI_REQUIRED` means that t3threads needs a `t3` command with the same
  version as the running T3 server. On macOS, it uses the one inside the T3 app.
  Elsewhere, install the matching `t3` CLI, or set `command` for that
  environment in the configuration file.
- `UNSUPPORTED_SERVER` means that your T3 version is too old. Update T3.
- If your agent does not see the t3threads tools, start a new thread or restart
  the provider session.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. t3threads is an independent project and is not affiliated with T3.
