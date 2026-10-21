# Contributing

Bug reports, ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/peter-lewis/terminal-commands/issues) and include:

- your editor and its version (VS Code, Cursor, ...), your operating system, and your shell;
- the config entry involved, if there is one;
- what you expected to happen, and what happened instead;
- the log from the **Terminal Commands** output channel, ideally at the Debug level (**Developer: Set Log Level...**, then Terminal Commands, then Debug).

## Development

You need Node.js 22 or later and pnpm 11.

```sh
pnpm install
pnpm run build             # bundle the extension into dist/
pnpm run watch             # rebuild on change
pnpm run typecheck
pnpm test                  # unit tests (vitest)
pnpm run test:integration  # integration tests in a real VS Code
pnpm run package           # build terminal-commands-<version>.vsix
```

To try a change, open the repository in VS Code and press F5. That builds the extension and opens a second window with the extension loaded and `test/fixtures/workspace` open. After rebuilding, run **Developer: Reload Window** in that window.

The repository has a Terminal Commands config of its own, so with the extension installed you can run the watcher and the unit tests from the sidebar.

### Where things are

| Path                       | Contents                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `src/extension.ts`         | Activation. Connects the pieces and registers the commands, the view and the task provider. |
| `src/config.ts`            | Parses and validates `.vscode/terminal-commands.json`.                                      |
| `src/configStore.ts`       | Loads each workspace folder's config, and reloads it when the file changes.                 |
| `src/commandRunner.ts`     | Runs the commands as tasks, and tracks their status from the task events.                   |
| `src/commandTree.ts`       | The Terminal Commands view.                                                                 |
| `src/autoStartPolicy.ts`   | Decides whether to auto-start a workspace's commands, ask first, or skip them.              |
| `src/scaffold.ts`          | The contents of a new config.                                                               |
| `schemas/`                 | The config's JSON schema, which the editor uses for validation and completions.             |
| `test/unit/`               | Unit tests for the parts that don't need VS Code.                                           |
| `test/integration/`        | Tests that run the extension in VS Code, against the workspace in `test/fixtures/`.         |

### Integration tests

The first run of `pnpm run test:integration` downloads VS Code into `.vscode-test/`. To use an installed editor instead, point `VSCODE_TEST_EXECUTABLE` at it. That also lets you run the tests in Cursor:

```sh
VSCODE_TEST_EXECUTABLE="/Applications/Visual Studio Code.app/Contents/MacOS/Code" pnpm run test:integration
VSCODE_TEST_EXECUTABLE="/Applications/Cursor.app/Contents/MacOS/Cursor" pnpm run test:integration
```

The tests run with an empty zsh config, so that terminals start quickly and the same way every time. Set `TEST_USER_SHELL=1` to run them with your own shell setup, which is worth doing when you change how commands are started or stopped. On Linux without a display, run them with `xvfb-run -a pnpm run test:integration`.

## Pull requests

- Keep each pull request to one change, and add tests for changes in behavior.
- `pnpm run typecheck`, `pnpm test` and `pnpm run test:integration` should pass. CI runs them on Linux and macOS.
- For changes users will notice, add a line under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md), adding the heading if it isn't there yet.

Releases are described in [RELEASING.md](RELEASING.md).
