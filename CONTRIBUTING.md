# Contributing

Procesos de Claude is an [Orca](https://github.com/stablyai/orca) plugin. It is
a components panel backed by a Node.js worker, all written in TypeScript. Orca
transpiles the TypeScript when it loads the plugin, so there is no build step
and no dependencies to install.

## Run it from a clone

```sh
git clone https://github.com/naitsric/orca-claude-procesos
cd orca-claude-procesos
orca plugin types .        # writes Orca's typings to .orca/types (not committed)
orca plugin dev load .     # asks for approval, like an install
```

Once loaded, Orca reloads the plugin every time you save a file. The worker's
output goes to:

```sh
orca plugin logs local.claude-procesos
```

If you also have the released version installed, uninstall it first or you
will see two status bar items.

## Test

```sh
orca plugin test .                  # logic, panel and worker tests
npx -p typescript tsc -p .          # type check
orca plugin check .                 # render the panel with the real worker and with the demo data
orca plugin validate .              # manifest
```

`orca plugin test` runs the worker tests against the real `ps` and `lsof` of
your machine, so they check the shape of the result and not its numbers. The
logic and panel tests run against a made-up system in `src/fixtures.ts`.

## How the code is organized

| File | What it does |
| --- | --- |
| `src/procesos.ts` | Pure logic. Parses `ps` and `lsof` output, groups processes by session, finds orphans, assigns verdicts and keeps the record that survives between checks. |
| `src/sistema.ts` | The only code that touches the machine. Runs `ps` and `lsof`, reads `~/.claude/sessions/`, sends signals. |
| `src/worker.ts` | Checks on an interval and saves the record to storage. Answers the panel and updates the status bar and notifications. |
| `src/panel.tsx` | The interface. |
| `src/protocol.ts` | The typed contract between the panel and the worker. |
| `src/tipos.ts` | Data types shared by both sides. |
| `src/formato.ts` | Formatting for memory, durations and ports. |
| `src/fixtures.ts` | A made-up system for tests and for `orca plugin check`. |

## Guidelines

- Keep the logic in `src/procesos.ts` free of side effects, and cover changes
  with tests there.
- Never signal a process that is not in a fresh snapshot with the same start
  time. `cerrar` in `src/sistema.ts` enforces this; keep it that way.
- Fixtures and tests use made-up names, paths and session IDs. Never use real
  ones.

## Releasing

1. Bump `version` in `orca-plugin.json` and commit.
2. Tag the commit and push the tag. Orca installs the newest `vX.Y.Z` tag:

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

3. Users update with `orca plugin update naitsric.claude-procesos`.
