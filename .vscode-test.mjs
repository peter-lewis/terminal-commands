import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

// Auto-start would otherwise ask first, and nobody is there to answer. The setting can only be set in
// user settings, so it goes into the test profile.
const userSettings = join(dirname(fileURLToPath(import.meta.url)), '.vscode-test', 'user-data', 'User', 'settings.json');
mkdirSync(dirname(userSettings), { recursive: true });
writeFileSync(userSettings, JSON.stringify({ 'terminalCommands.autoStart': 'always' }));

// An empty ZDOTDIR keeps your zsh startup files out of the test terminals, which makes them start fast
// and predictably. Set TEST_USER_SHELL=1 to run against your real shell setup instead.
const env = process.env.TEST_USER_SHELL ? {} : { ZDOTDIR: mkdtempSync(join(tmpdir(), 'terminal-commands-zdotdir-')) };

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: 'test/fixtures/workspace',
  // The test profile has no extensions installed. Built-in Git would offer to open the parent repo.
  launchArgs: ['--disable-workspace-trust', '--disable-extension=vscode.git', '--log=peter-lewis.vscode-terminal-commands:debug'],
  env,
  mocha: { ui: 'bdd', timeout: 60_000 },
  // Point VSCODE_TEST_EXECUTABLE at an installed editor (VS Code or Cursor) to skip the download.
  ...(process.env.VSCODE_TEST_EXECUTABLE ? { useInstallation: { fromPath: process.env.VSCODE_TEST_EXECUTABLE } } : {}),
});
