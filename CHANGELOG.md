# Changelog

## Unreleased

- **Groups**: list commands in named groups, like everything one app needs while you work on it. The view lists the commands by group, with buttons to start and stop a whole group. Check a group to start it now and whenever the project opens. If its commands change, you're asked again.
- **Config editor**: **Open Config** opens the config in a form, for adding, changing, reordering and deleting commands and groups. Changes are saved as you make them, and the rest of the file, comments included, stays as written. **Edit as JSON** switches to the file, and back.
- **Edit Command** opens the command in the config editor.
- New commands: **Start Group**, **Stop Group**, **Choose Auto-Start Groups...** and **Open Config (JSON)**.

## 0.1.0

Initial release.

- Define a project's commands in `.vscode/terminal-commands.json`, with validation and completions in the editor.
- The **Terminal Commands** view in the Explorer lists them with their status, with buttons to start, stop and restart each one. It expands by itself the first time you open a project that has commands.
- Each command runs as a task in a terminal of its own. The terminal stays open after the command exits, and running commands survive window reloads.
- Commands marked `autoStart` start when the project opens, once you've allowed it.
- **Create Config** fills in a new config from your `package.json` scripts.
- The commands also appear under **Tasks: Run Task**, and `tasks.json` can refer to them.
