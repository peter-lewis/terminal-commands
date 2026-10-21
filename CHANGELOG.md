# Changelog

## 0.1.0

Initial release.

- Define a project's commands in `.vscode/terminal-commands.json`, with validation and completions in the editor.
- The **Terminal Commands** view in the Explorer lists them with their status, with buttons to start, stop and restart each one. It expands by itself the first time you open a project that has commands.
- Each command runs as a task in a terminal of its own. The terminal stays open after the command exits, and running commands survive window reloads.
- Commands marked `autoStart` start when the project opens, once you've allowed it.
- **Create Config** fills in a new config from your `package.json` scripts.
- The commands also appear under **Tasks: Run Task**, and `tasks.json` can refer to them.
