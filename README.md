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
   Add the "Persistent agent instructions" snippet below to their actual
   instruction files, preserving existing guidance and avoiding duplicates.
   Follow the skill's guidance for handoffs and completion notifications.
   Instruct agents to omit model and permission overrides so new threads use
   the destination project's T3 settings, then that machine's defaults. Only
   pass explicit overrides when I request them.
4. On macOS, install and check the background service so queued messages and
   watcher notifications keep working after login. On other platforms, explain
   how to run `t3threads watch-run` under a service manager.
5. Verify access with `t3threads environments` and `t3threads overview`. Report
   unreachable machines or other gaps. Leave optional Jev/TypeSafe setup alone
   unless I ask for it.
6. Follow "Verify agent access" below for each provider home on each machine
   being configured. Verify the skill, persistent instructions, and MCP tools
   in a fresh session. Report checks requiring a new session as pending until
   observed; do not call setup complete based on `doctor` alone. Summarize the
   configuration and any remaining steps.
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
| T3's desktop preferences in `~/.t3/userdata/client-settings.json` | Read Auto balance, machine weights, and shared-project grouping for new threads. t3threads never writes this file. |
| T3's saved sign-in in `~/.t3/userdata/clerk-tokens.json` and its macOS Safe Storage Keychain item | Unlock the existing sign-in and authenticate with T3's sign-in provider and Connect relay to reach your linked machines. |
| Project metadata, thread messages and status, and model settings | Read and coordinate your work through T3's HTTP and WebSocket APIs. t3threads never opens T3's database or changes its credential files. |
| Its own [local state directory](#your-data) | Store cached thread text, model results, queued messages, watchers, and per-machine connection credentials, keys, and a cached T3 client sign-in for unattended renewal. |

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

### Persistent agent instructions

Add this note to the persistent instructions loaded by each provider you use in
T3 (for example, its `AGENTS.md` or `CLAUDE.md`). Use the actual provider home,
including any custom home configured in T3, and preserve existing instructions.

```text
Use t3threads when asked to start, spin off, delegate to, message, or coordinate
T3 Code threads, or when related threads may contain useful context or overlapping
work. Prefer its MCP tools; use the t3threads CLI when MCP is unavailable.
An explicit request to create or message threads authorizes that action within
the requested scope. T3 threads are persistent conversations visible in T3;
use them when requested instead of harness subagents. Read the t3threads skill
for handoffs and completion notifications. Preserve the full approved scope in
task briefs. Inherit destination model and permission settings unless the user
requests overrides. Use watchers for follow-up; yield when waiting so completion
notifications can wake the caller.
Send immediately by default, steering busy threads. Use enqueue only when asked
to wait for idle with durable retries.
```

### Verify agent access

Repeat these checks for each provider home on each machine you configure:

1. Confirm the t3threads skill and instruction note are installed in locations that provider loads.
2. Confirm the MCP registration points to an executable available to that provider.
3. Start a fresh T3 thread using that provider and home.
4. Ask it to identify the t3threads skill and call the t3threads `overview` MCP tool.
5. Check that it reports unreachable machines and other coverage gaps.

To check delegation discovery without creating work, use this prompt:

```text
How would you spin off three T3 threads for three independent tasks in this
project and notify this thread when they finish? Identify the tool and outline
the handoff and notification steps. Do not create threads or watchers.
```

The agent should select t3threads, use self-contained briefs and separate
worktrees, preserve requested settings and authority, and describe a watcher
that wakes the caller. Investigating `t3` subcommands or server APIs first means
the routing instructions have not taken effect.

`doctor` verifies server access, not agent discovery. If the agent uses CLI
because MCP is unavailable, report that fallback and the unresolved MCP setup.
Leave fresh-session checks pending until verified.

Once access is verified, ask things like:

- "Is any other thread working on the billing webhook?"
- "Summarize what the workstation thread decided about the migration."
- "Start a worktree thread that writes tests for this module, and tell me when
  it finishes."

## Use it from the terminal

Every MCP tool is also a command. Run `t3threads COMMAND --help` for all options.
Output is compact by default; add `--json` for JSON. `projects`, `list`, `read`,
`queued`, and `watchers` accept `--details` for full metadata (`details: true`
in MCP/API). JSON uses the same compact defaults; scripts that need the former
full output should request details.

**Upgrading from 0.6.x to 0.7.0:** `send` now delivers directly and steers busy
threads by default for both thread and external callers. Success returns
`status: accepted` with a dispatch receipt, rather than a `queueId`. Connection
and authentication failures return immediately; they do not queue the message.
Use `--enqueue` (`enqueue: true` in MCP/API) when you want durable delivery after
the recipient becomes idle. Explicit `--steer` also sends directly now. Existing
queued messages keep their stored delivery behavior. Watcher notifications still
wait for the caller to be idle.

**Upgrading from 0.5.x to 0.6.0:** T3 Connect machines are now named after
their T3 label, for example `jessbox:abc123` instead of
`connect-ENV_ID:abc123`. The `connect-ENV_ID` form still resolves, so saved
references and queued messages keep working. Compact `overview` and `list`
rows name the project by title instead of `projectId`, and compact `read`
omits `projectId`. Add `--details` when you need the project ID.

**Upgrading from 0.4.x to 0.5.0:** default CLI, JSON, MCP, and Fetch output now
omits diagnostic metadata and stored payloads. Add `--details` (`details: true`
in MCP/API) to existing `projects`, `list`, `read`, `queued`, and `watchers`
calls that depend on those fields. `watch`, `unwatch`, and `unqueue` return
compact status; retrieve full records through `watchers` or `queued` with
`--id ID --details`. In compact thread output, an absent `settledAt` means the
thread is unsettled; do not require `settledAt === null`.

A thread reference has the form `ENV:THREAD_ID`, for example `local:abc123` or
`jessbox:abc123`. Commands print these references wherever a thread appears.

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

`read` keeps the full text and role of every message in the selected page.
Partial messages include `streaming: true`; finished messages omit the flag.
Messages with attachments show an `attachmentCount`; use `read REF --details`
for attachment metadata, message IDs and timestamps, and thread settings.
`list` keeps status, branch/worktree paths, and attention flags; `--details`
also shows model, permission, and session metadata. Unset paths and empty
archive/settlement timestamps are omitted in compact output.

Summaries and `find` results come from a model. Treat them as leads to check,
not as proof that tests passed or a PR is ready.

### Start a new thread

```sh
t3threads start --project my-app --checkout worktree --branch main --prompt-file task.md --dry-run
t3threads start --project my-app --checkout worktree --branch main --prompt-file task.md
```

Replace `main` with the intended base branch. `--dry-run` shows the chosen
machine and what t3threads would send without starting anything. Auto balance
checks fresh load on each call, so a later start can choose a different machine.

New threads respect the invoking desktop's **Auto balance** setting, including
machine preference weights. With it enabled, t3threads chooses an eligible
machine in the same shared project using T3's free CPU and memory scoring.
`--env NAME` identifies where to look up the project; it does not disable Auto
balance. Use `--env NAME --pin-env` when the task must run on that machine.
MCP/API uses `pinEnv: true`. Agents should pin only when you request a machine.

The setting is read from the local T3 home's desktop preferences on each start,
even when `--env` names a remote machine. Browser-only preferences are separate.
If Auto balance is off or the desktop preference file is absent, starts use the
selected environment as before. Projects without a shared repository identity,
or grouped separately in T3, also stay on that environment.

Balanced results include `routing` with machine scores, exclusions, and any
unreachable-machine errors. If no machine is eligible, the start fails before
creating a thread. Zero-weight machines and machines without a usable provider
are excluded. `send` continues on the existing thread's machine.

The new thread does not see your current conversation. Write a self-contained
brief with the full approved scope, relevant issue list, context, and completion
criteria. Preserve the user's instructions about commits, PRs, reviews, merges,
and communication. Include dependencies and who coordinates overlapping changes.
For coordinated work, include the parent's T3 reference and instructions to reply
with `send` using the child's own caller reference.
For several workstreams, write one brief per thread and keep every approved issue
assigned; do not silently reduce the scope to an initial suggested subset.

Agents use `projects` to resolve the destination and `list` to identify their
own caller thread by its current worktree. After starting tasks, save the returned
references, [register a watcher](#get-notified-when-threads-finish) when follow-up
is requested, and report the threads created or any failures. Requests for T3
threads create persistent conversations visible in T3, rather than harness
subagents. Explicit requests authorize starting the specified work without a
second approval for the same action.

- `--checkout worktree` creates a worktree on a new `t3threads/THREAD_ID` branch,
  based on your local branch. Add `--from-origin` to start from the remote, or
  `--skip-setup` to skip the project's setup script. On a remote machine, also
  pass `--branch BASE`. Supply it when Auto balance may choose a remote machine,
  too; that branch must exist there.
- `--checkout current` works in the project's existing checkout.
- The thread inherits the destination project's model setting, then that
  machine's default, including the provider instance and model options. A
  project override with a disabled or missing provider falls back to the
  machine model, as in T3. Clearing the project default explicitly means no
  default model; choose one in T3 or pass `--provider INSTANCE --model MODEL`.
- `--model MODEL` overrides the model within the inherited provider. Changing
  the model clears inherited model options; keeping the same model preserves
  them. `--provider INSTANCE --model MODEL` selects both explicitly.
- `--model-options-json` replaces the selected model's options with a JSON array,
  for example `'[{"id":"reasoningEffort","value":"xhigh"}]'` for Codex.
  MCP/API accepts `modelOptions` as an array. Omit to inherit; `[]` clears options.
  Use option IDs and values supported by the selected provider and model; inspect the dry run.
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

Plain `send` delivers immediately, steering a running turn or starting a new
turn when the recipient is idle. It returns `status: accepted` with T3's
dispatch receipt. The recipient keeps its own model and settings. Direct sends
do not depend on the background worker and do not queue on connection or
authentication failure. If a dispatch result is uncertain, inspect the reported
thread and command ID before retrying; the message may already have arrived.

Use `--enqueue` only when you want durable delivery after the recipient becomes
idle. It saves the message in the local outbox before either server is contacted,
then returns `status: queued`, a `queueId`, and a stable `commandId`. This confirms
local storage, not delivery. Use `queued` to check acceptance or errors; do not
resend a queued message.

Use `queued --id QUEUE_ID` to inspect one delivery. Add `--details` to see its
prompt, stable command/message IDs, and stored dispatch payload. The default
view shows delivery status, sender, timestamps, and errors without repeating
message bodies. `unqueue` returns the same compact status view.

- `--steer` explicitly selects the default immediate delivery.
- `--enqueue` requests durable delivery when idle. It cannot
  be combined with `--steer`.
- In MCP/API, `steer: false` requests direct delivery only if idle; a busy thread
  returns `THREAD_BUSY` without queueing.

For queued messages, the worker retries temporary authentication and connection
failures and preserves queue order per recipient. Direct sends do not wait behind
queued messages. A deleted, archived, or missing queued recipient fails
visibly in `queued`. Use `unqueue QUEUE_ID` to cancel before dispatch starts.
After dispatch starts, recovery reuses the frozen command and message IDs so
T3 can deduplicate a lost receipt. `--dry-run` requires reachable servers and
previews the command without saving or delivering it.

`--caller` is the T3 thread that sends the message. The recipient sees the
sender's title and a reply address, marked as a message from another agent, not
from you. Find your own thread ID with `list`. A provider's session ID is not a
T3 thread ID.

The message prefix is two lines, followed by your unchanged prompt:

```text
[t3threads agent message: "Grace Hopper's review"; not the user]
Reply: t3threads send 'local:SENDER_ID' --caller YOUR_THREAD_REF --prompt-file REPLY_FILE
```

Write the reply to a UTF-8 file and replace `REPLY_FILE` with its path, quoting
the path if needed. This keeps apostrophes and other shell syntax in the reply
out of the command. In MCP, supply the reply text as `prompt` instead.
Cross-machine replies use the sender machine's name, such as
`jessbox:SENDER_ID`, and include a third line:
`Direct-only: replace jessbox with your configured name for that machine.`

Integrations outside T3 use `--external-caller NAME` instead of `--caller`:

```sh
t3threads send local:THREAD_ID --external-caller jessbot \
  --prompt-file /private/path/slack-request.txt
```

Supply exactly one caller option. External messages identify the integration
without inventing a T3 sender thread. Include the original request, its source
link, and instructions for replying in the prompt. The caller name is a label
supplied by the integration, not a verified user identity. External callers also
send directly and steer busy threads by default. Success means `accepted`, so
integrations such as jessbot can use the receipt to order their next action.
External callers can
use `--enqueue` for durable delivery and `--dry-run` for a preview.

Queued messages survive restarts and crashes, and a retry after a crash does not
deliver a message twice. The machine that queued a message must stay on until
the message is delivered. On macOS, install the
[background service](#keep-delivery-running) so delivery continues after you log
in again.

### Get notified when threads finish

```sh
t3threads watch --threads local:THREAD_A --threads jessbox:THREAD_B \
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

After registering the watcher, continue independent work or yield the caller's
turn. Sleep/poll loops keep the caller busy and delay its notification. Save the
watcher ID so you can inspect delivery or cancel it. Resolve the caller's T3
reference with `list` using its current worktree; provider conversation IDs are
different. If the match is ambiguous, resolve it before registering a wake-up.

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

Read the notified threads and verify the requested outcomes, tests, and review
evidence before taking further authorized action. Register a new watcher if
follow-up work needs another notification. A separate `any-error` watcher can
notify you of failures before all threads finish.

`text` and `jev` conditions read recent activity from the watched threads, up
to 100,000 characters in total. For larger sets, watch fewer threads or use one
of the status conditions.

`watchers` shows each watcher's condition, state, delivery timestamps, and
errors. Once fired, it also shows the `decision`, including the reason and
probability when present. This includes events-only watchers. Use
`watchers --id WATCH_ID --details` for per-thread evidence and delivery
metadata. `watch` and `unwatch` return compact status views; `unwatch` stops a
watcher, including a notification that was not yet sent.

### Manage threads

```sh
t3threads manage local:THREAD_ID --action interrupt
t3threads manage local:THREAD_ID --action settle
t3threads manage local:THREAD_ID --action archive
t3threads manage local:THREAD_ID --action unarchive
t3threads manage local:THREAD_ID --action rename --title 'Billing webhook retries'
```

Add `--dry-run` to preview the change. Settlement marks finished work settled
without archiving it; later activity can reopen the thread. It requires a server
that advertises `threadSettlement`. T3 rejects settlement while a turn is running
or work is queued.

`list` includes settlement state; unarchived listings also expose pending approval,
user input, proposed plan, and background-work metadata from the server.

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
is named after its T3 label in lowercase, with other characters replaced by
hyphens: a machine labeled `JessBox` is `jessbox`. A machine keeps the
`connect-ENVIRONMENT_ID` name when its label is empty, reserved (`local`,
`all`), shared with another machine, or taken by an environment in your
configuration. The `connect-ENVIRONMENT_ID` form resolves for every machine.
Renaming a machine in T3 changes its name here; references that use the old
name stop resolving.

t3threads reads T3's saved sign-in and never changes it. Once after signing in,
run `t3threads environments` while the login Keychain is accessible and allow
the Safe Storage request. t3threads caches the decrypted client sign-in in its
own owner-only state directory (0700, database 0600). It does not save the
Keychain password or Safe Storage encryption key. This credential lets it mint
fresh relay tokens and renew environment sessions while the Mac is locked,
including after a worker restart. The credential is sensitive; protect this
state directory like the T3 sign-in itself.

The background service checks for changed sign-in data once a minute so it can
warm the cache while access is available. `service status` shows the latest
warm-up error. A changed or removed T3 sign-in invalidates the cached credential;
a new sign-in may require one unlocked warm-up. Server-side revocation and
expired logins still require signing in again. Queued messages remain pending
through temporary authentication failures. Sign in through the desktop app at
least once; headless sign-in does not work. Every machine you want to reach must be running
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

Read commands take query parameters or a JSON `POST` body. Boolean options such
as `details` and `all` require JSON booleans in a `POST` body; the current Fetch
adapter does not convert GET strings to booleans. Commands that change threads
require a JSON `POST` body:

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
  version as the running T3 server. It first checks that home's
  `runtime/versions/SERVER_VERSION/t3` (`t3.exe` on Windows), then the macOS
  desktop bundles and PATH. An explicit environment `command` overrides
  discovery. Every candidate must report the exact server version.
- `NATIVE_AUTH_LOCKED` means the current sign-in has not been cached yet. Run
  `t3threads environments` once with the login Keychain unlocked; the service
  retries cache warm-up, and queued messages retry delivery automatically.
- `UNSUPPORTED_SERVER` means that your T3 version is too old. Update T3.
- If your agent does not see the t3threads tools, start a new thread or restart
  the provider session.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. t3threads is an independent project and is not affiliated with T3.
