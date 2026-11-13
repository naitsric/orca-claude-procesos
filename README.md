<h1 align="center">Procesos de Claude</h1>

<p align="center">
  <strong>An activity monitor for Claude Code, built into Orca.</strong><br>
  Sessions · MCP servers · Background commands · Orphaned processes
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Orca-%E2%89%A5%201.4.248-6b5bd2" alt="Orca 1.4.248 or later">
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="macOS">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

<!-- screenshot: docs/screenshot.png -->

## Why Procesos de Claude

Every Claude Code session starts processes of its own: MCP servers, the shells
behind the Bash tool, and the dev servers and tunnels it launches for you. Most
of them end with the session. Some don't. A crashed session, a `nohup` from a
background command or a forgotten tunnel keeps holding memory and ports long
after anyone needs it. With a few sessions open, Activity Monitor can't tell
you which `node` belongs to which conversation.

Procesos de Claude groups every process under the session that started it,
names each session, finds what outlived its session and tells you what is safe
to close. It is careful about it: it asks before closing anything, checks each
process again right before signalling it, and never touches a process that
isn't Claude's.

## Features

### Every session at a glance
- **Sessions by name**, as Claude Code names them, with their folder, their
  terminal and the memory they hold together with everything they started.
- **Real status**: *working*, or *idle* and for how long. It comes from Claude
  Code itself and is not guessed from CPU usage.
- **The full process tree** of each session: MCP servers, Bash commands and
  what they run, dev servers with their ports, tunnels, `caffeinate` and nested
  `claude` runs.
- Sessions running in any terminal (Orca, Ghostty, Terminal, iTerm2, VS Code)
  show up, not only Orca's.

### Find what outlived its session
- **Orphans**: processes still running after their session ended, with the
  session they came from and when it ended.
- **Detached processes**: things a live session started that are no longer
  tied to it, such as a `nohup … &` from Bash. They will survive when you close
  the session.
- **Certain or probable**: certain when the plugin saw the process start under
  a session, probable when it only looks like something Claude starts, such as
  an MCP server with no owner.
- A **desktop notification** the first time something outlives its session.

### A verdict for every process
- **Close**: an orphan nobody is using.
- **Review**:
  - a session idle for longer than you set;
  - a command or server running in the background for over an hour;
  - a detached process;
  - an MCP server of uncertain origin.
- **Keep**: what a live session is using, such as its MCP servers,
  `caffeinate` and commands in progress.
- Every verdict comes with its reason. Selecting a row shows its full command
  line.

### Close with care
- **The confirmation appears where you clicked**, inside the session card or in
  place of the orphan alert. It lists what will close, the memory it frees and
  the ports it releases.
- **It spells out the consequences**:
  - a busy session loses the task in progress;
  - closing an MCP server takes its tools away from the session;
  - a closed session can be resumed with the `claude --resume <id>` it shows.
- **SIGTERM first**, so sessions shut down their own MCP servers. SIGKILL only
  if something doesn't respond, and only when you ask for it.
- **Checked again before every signal**: the worker takes a fresh snapshot
  and only signals processes that are still there with the same start time, so
  a reused PID is never hit. Processes of other users and anything not tied to
  Claude are never offered.

### Always in sight
- A **status bar item**, `Claude 5 · 2 huérfanos`, that turns amber when there
  are orphans and red when they hold ports. Click it to check now.
- Two **command palette** entries: check now, and close every certain orphan.

## Install

Requires **Orca 1.4.248 or later on macOS**, with plugins turned on
(Settings → Plugins → *Turn on plugins*).

1. **Request the install.** The plugin runs code, so Orca asks for your approval
   first. It prints the access the plugin requests and a fingerprint:

   ```sh
   orca plugin install naitsric/orca-claude-procesos
   ```

2. **Approve it** with that fingerprint:

   ```sh
   orca plugin install naitsric/orca-claude-procesos --approve ap1-…
   ```

3. **Open it** from Orca's right sidebar (**Procesos de Claude**), or with:

   ```sh
   orca plugin open naitsric.claude-procesos --panel procesos
   ```

The `orca` CLI ships inside the app. If your shell can't find it, use
`/Applications/Orca.app/Contents/Resources/bin/orca` or add an alias for it.

**Update** with `orca plugin update naitsric.claude-procesos`. It asks for
approval again only if the requested access changes. **Uninstall** with
`orca plugin uninstall naitsric.claude-procesos`.

### Permissions

| Access | Why |
| --- | --- |
| Run code in Node.js as your user (`trusted-worker`) | List processes with `ps` and `lsof`, read `~/.claude/sessions/`, and signal the processes you choose to close. |
| `storage:own` | Remember which processes started under each session. That record is how it recognizes orphans. |
| `settings:own` | Read its own settings. |
| `notifications:show` | Tell you when something outlives its session. |

The plugin makes no network requests.

## Settings

In Settings → Plugins → Procesos de Claude:

| Setting | Default | |
| --- | --- | --- |
| Check interval | 15 s | From 5 to 300 seconds. |
| Long session threshold | 12 h | A session idle for longer than this is marked for review. |
| Notify about orphans | On | A desktop notification the first time a process outlives its session. |

## How it works

**Sessions.** A process belongs to a session when it descends from a `claude`
process. The name, conversation ID and status come from
`~/.claude/sessions/<pid>.json`, which Claude Code keeps up to date. On
versions that don't write that file, the panel uses the folder and CPU usage
instead.

**Orphans.** macOS doesn't let one process read another's environment, so
there is no way to ask a process whether Claude started it. Instead, the worker
checks every few seconds and keeps a record of what it saw:
- which processes descended from each session;
- which process groups each session and each Bash shell led;
- when each session ended (kept for seven days).

A process whose parent is `launchd` is a certain orphan when it matches that
record, or when it is a Bash tool shell, which carries the
`~/.claude/shell-snapshots` marker. Orphans whose session ended before the
plugin was installed can only be recognized by that marker; MCP servers among
them show up as probable.

**Safety.** Every close goes through the worker. It takes a new snapshot and
signals a process only if it is still there, belongs to your user and has the
same start time as the one you chose.

## Roadmap

- English interface (the UI is in Spanish today)
- Jump from a session to its Orca terminal
- Linux support

## Contributing

The plugin is plain TypeScript that Orca loads without a build step. See
[CONTRIBUTING.md](CONTRIBUTING.md) to load it from a clone, run the tests and
find your way around the code.

## License

[MIT](LICENSE)

---

<sub>Claude and Claude Code are trademarks of Anthropic. Orca is developed by Stably AI. Procesos de Claude is an independent project and is not affiliated with or endorsed by either.</sub>
