import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

// Every run gets a fresh profile in the temp directory. VS Code puts its IPC socket in the profile, and
// on macOS a socket path can't be longer than 103 characters, which a profile inside the checkout can
// exceed (it does on GitHub's macOS runners).
const userDataDir = mkdtempSync(join(tmpdir(), 'tc-user-data-'));

// Auto-start would otherwise ask first, and nobody is there to answer. The setting can only be set in
// user settings, so it goes into the test profile.
mkdirSync(join(userDataDir, 'User'));
writeFileSync(join(userDataDir, 'User', 'settings.json'), JSON.stringify({ 'terminalCommands.autoStart': 'always' }));

// An empty ZDOTDIR keeps your zsh startup files out of the test terminals, which makes them start fast
// and predictably. Set TEST_USER_SHELL=1 to run against your real shell setup instead.
const env = process.env.TEST_USER_SHELL ? {} : { ZDOTDIR: mkdtempSync(join(tmpdir(), 'terminal-commands-zdotdir-')) };

export default defineConfig({
  files: 'out/test/integration/**/*.test.js',
  workspaceFolder: 'test/fixtures/workspace',
  launchArgs: [
    `--user-data-dir=${userDataDir}`,
    '--disable-workspace-trust',
    // The test profile has no extensions installed. Built-in Git would offer to open the parent repo.
    '--disable-extension=vscode.git',
    '--log=peter-lewis.terminal-commands:debug',
  ],
  env,
  mocha: { ui: 'bdd', timeout: 60_000 },
  // Point VSCODE_TEST_EXECUTABLE at an installed editor (VS Code or Cursor) to skip the download.
  ...(process.env.VSCODE_TEST_EXECUTABLE ? { useInstallation: { fromPath: process.env.VSCODE_TEST_EXECUTABLE } } : {}),
});
