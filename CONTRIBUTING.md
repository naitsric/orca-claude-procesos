# Contributing

Claude Processes is an [Orca](https://github.com/stablyai/orca) plugin. It is
a components panel and an HTML panel backed by a Node.js worker, all written in
TypeScript. Orca
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

`orca plugin test` runs the worker tests against the real `ps` and `lsof` (or
`/proc` on Linux) of your machine, so they check the shape of the result and not
its numbers. The logic and panel tests run against a made-up system in
`src/fixtures.ts`, and `src/linux.test.ts` against a made-up Linux desktop.
`src/git.test.ts` builds a real repository with worktrees in a temporary folder
and closes them with your `git`; it points `CLAUDE_CONFIG_DIR` at that folder so
it never looks at your own repositories.
Tests run in English, the default language; `src/i18n.test.ts` covers Spanish
and how the language is chosen.

## How the code is organized

| File | What it does |
| --- | --- |
| `src/procesos.ts` | Pure logic. Parses `ps` and `lsof` output (and `/proc` on Linux), groups processes by session, finds orphans, assigns verdicts and keeps the record that survives between checks. |
| `src/sistema.ts` | With `src/git.ts`, the only code that touches the machine. Runs `ps`, and `lsof` on macOS or reads `/proc` on Linux; reads `~/.claude/sessions/`, sends signals. |
| `src/worktrees.ts` | Pure logic for worktrees. Parses `git worktree list` and `git status`, decides each worktree's verdict from its inactivity and what closing it would lose, and checks every close against a fresh reading. |
| `src/git.ts` | Touches the machine for worktrees. Finds the repositories Claude worked in, runs `git` and `du`, reads file dates, and removes worktrees. |
| `src/worker.ts` | Checks on an interval and saves the record to storage. Looks for worktrees on a slower one. Answers the panel and updates the status bar and notifications. |
| `src/panel.tsx` | The sessions, orphans and worktrees panel (Orca components). |
| `src/graficas.ts` | The Claude Activity panel: HTML and SVG charts, since Orca's components have none. |
| `src/confirmar.ts` | What each close confirmation says and closes, shared by both panels. |
| `src/historial.ts` | Pure logic for the graphs: samples, real CPU between samples, stable session colors, and the roll-up that keeps the saved history under Orca's 256 KiB per value. |
| `src/series.ts` | Pure logic that turns the history into stacked series and axis ticks. |
| `src/protocol.ts` | The typed contract between the panel and the worker. |
| `src/tipos.ts` | Data types shared by both sides. |
| `src/i18n.ts` | Every text the user sees, in English and Spanish, and how the language is chosen. |
| `src/formato.ts` | Formatting for memory, durations, ports and percentages, with each language's decimal separator. |
| `src/fixtures.ts` | A made-up system for tests and for `orca plugin check`. |
| `docs/screenshot.png` | The README screenshot, rendered from made-up data. |
| `design/` | The icon. `icon.svg` is the source; `render-icon.sh` renders `icon.png` (README) and `icon-256.png` (Orca) with headless Chrome. |

## Guidelines

- Keep the logic in `src/procesos.ts` free of side effects, and cover changes
  with tests there.
- Never signal a process that is not in a fresh snapshot with the same start
  time. `cerrar` in `src/sistema.ts` enforces this; keep it that way.
- Never remove a worktree that is not in a fresh reading at the same commit,
  and never pass `--force` for changes the confirmation didn't show.
  `validarCierre` in `src/worktrees.ts` enforces this; keep it that way.
- Reading worktrees must not disturb them: `git` runs with
  `GIT_OPTIONAL_LOCKS=0`, so it neither takes the index lock nor changes the
  dates that count as activity.
- Fixtures and tests use made-up names, paths and session IDs. Never use real
  ones.
- Text the user sees goes in `src/i18n.ts`, in every language, never inline in
  a panel or the worker.

## Languages

Orca tells the panels its interface language but not the worker. So each panel
sends `env.locale` when it asks for a snapshot, the worker stores it, and the
`idioma` setting (`auto`, `en` or `es`) decides. The worker writes the reasons
and the status bar in that language and puts it in the snapshot
(`Foto.idioma`); the panels render in the snapshot's language, so their own
text and the worker's never mix. The manifest can't be translated, so panel
and command titles stay in English.

To add a language:

1. Add an object of type `Textos` to `src/i18n.ts` (TypeScript flags any
   missing or extra text) and list it in `IDIOMAS` and `TEXTOS`.
2. Add its code to the `idioma` setting's `enum`, and its name, written in that
   language, to `enumLabels` in `orca-plugin.json`.
3. Add a test to `src/i18n.test.ts`.

## Releasing

1. Bump `version` in `orca-plugin.json` and commit.
2. Tag the commit and push the tag. Orca installs the newest `vX.Y.Z` tag:

   ```sh
   git tag -a v0.2.0 -m v0.2.0
   git push origin v0.2.0
   ```

3. Users update with `orca plugin update naitsric.claude-procesos`.
