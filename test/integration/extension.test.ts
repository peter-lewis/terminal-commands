import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { CommandStatus } from '../../src/commandRunner';
import type { TerminalCommandsApi } from '../../src/extension';

const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
const configPath = path.join(workspaceRoot, '.vscode', 'terminal-commands.json');
const envCwdOutput = path.join(workspaceRoot, 'env-cwd.out');

async function waitFor(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Terminal Commands', () => {
  let api: TerminalCommandsApi;
  let originalConfig: string;

  const status = (name: string) => api.getState(name)?.status;
  const waitForStatus = (name: string, expected: CommandStatus) =>
    waitFor(() => status(name) === expected, `"${name}" to be ${expected} (it is ${status(name)})`);
  const start = (name: string) => vscode.commands.executeCommand('terminalCommands.start', name);

  before(async () => {
    const extension = vscode.extensions.getExtension<TerminalCommandsApi>('peter-lewis.terminal-commands');
    assert.ok(extension, 'extension is installed');
    api = await extension.activate();
    await api.ready;
    originalConfig = fs.readFileSync(configPath, 'utf8');
  });

  afterEach(async () => {
    if (fs.readFileSync(configPath, 'utf8') !== originalConfig) {
      fs.writeFileSync(configPath, originalConfig);
      await waitFor(() => api.commandNames().length === 5, 'the original config to reload');
    }
    for (const name of api.commandNames()) await vscode.commands.executeCommand('terminalCommands.kill', name);
    await waitFor(
      () =>
        api.commandNames().every((name) => {
          const state = api.getState(name)!;
          return ['stopped', 'failed'].includes(state.status) && !state.hasTerminal;
        }),
      'every command to be killed',
    );
    fs.rmSync(envCwdOutput, { force: true });
  });

  // Runs first: afterEach kills everything.
  it('auto-starts the commands marked autoStart', async () => {
    await waitForStatus('auto', 'running');
    assert.equal(status('long'), 'stopped');
  });

  it('lists the configured commands', () => {
    assert.deepEqual(api.commandNames(), ['quick', 'fail', 'long', 'auto', 'env-cwd']);
    assert.equal(status('quick'), 'stopped');
  });

  it('runs a command in its own terminal and sees it exit', async () => {
    await start('quick');
    await waitForStatus('quick', 'stopped');
    assert.deepEqual(api.getState('quick'), { status: 'stopped', exitCode: 0, hasTerminal: true });
    const terminal = api.getTerminal('quick')!;
    assert.ok(vscode.window.terminals.includes(terminal), 'the terminal stays open after the command exits');
  });

  it('gives each command its own terminal', async () => {
    await start('quick');
    await start('fail');
    await waitForStatus('quick', 'stopped');
    await waitForStatus('fail', 'failed');
    assert.notEqual(api.getTerminal('quick'), api.getTerminal('fail'));
  });

  it('marks a command that exits with an error as failed', async () => {
    await start('fail');
    await waitForStatus('fail', 'failed');
    assert.equal(api.getState('fail')?.exitCode, 3);
  });

  it('stops a running command with Ctrl+C and keeps its terminal', async () => {
    await start('long');
    await waitForStatus('long', 'running');
    await sleep(1000);
    await vscode.commands.executeCommand('terminalCommands.stop', 'long');
    await waitForStatus('long', 'stopped');
    assert.deepEqual(api.getState('long'), { status: 'stopped', exitCode: undefined, hasTerminal: true });
  });

  it('stops a command right after starting it', async () => {
    await start('long');
    await vscode.commands.executeCommand('terminalCommands.stop', 'long');
    await waitForStatus('long', 'stopped');
    await sleep(1500);
    assert.equal(status('long'), 'stopped', 'it stays stopped');
  });

  it('restarts a running command in the same terminal', async () => {
    await start('long');
    await waitForStatus('long', 'running');
    await waitFor(() => api.getTerminal('long') !== undefined, 'the terminal');
    const terminal = api.getTerminal('long');
    const seen: Array<CommandStatus | undefined> = [];
    const subscription = api.onDidChange(() => {
      if (seen.at(-1) !== status('long')) seen.push(status('long'));
    });
    try {
      await vscode.commands.executeCommand('terminalCommands.restart', 'long');
      await waitForStatus('long', 'running');
    } finally {
      subscription.dispose();
    }
    assert.deepEqual(seen, ['stopping', 'stopped', 'starting', 'running']);
    await waitFor(() => api.getTerminal('long') !== undefined, 'the terminal');
    assert.equal(api.getTerminal('long'), terminal);
  });

  it('restarts a command right after starting it', async () => {
    await start('long');
    await vscode.commands.executeCommand('terminalCommands.restart', 'long');
    await waitForStatus('long', 'running');
    await sleep(500);
    assert.equal(status('long'), 'running');
  });

  it('runs again in the same terminal', async () => {
    await start('quick');
    await waitForStatus('quick', 'stopped');
    const first = api.getTerminal('quick');
    await start('quick');
    await waitForStatus('quick', 'stopped');
    assert.equal(api.getTerminal('quick'), first);
  });

  it('applies the working directory and environment', async () => {
    await start('env-cwd');
    await waitForStatus('env-cwd', 'stopped');
    assert.equal(api.getState('env-cwd')?.exitCode, 0);
    const [cwd, value] = fs.readFileSync(envCwdOutput, 'utf8').split('|');
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(workspaceRoot, 'sub')));
    assert.equal(value, 'hello');
  });

  it('kills a running command and closes its terminal', async () => {
    await start('long');
    await waitForStatus('long', 'running');
    await waitFor(() => api.getTerminal('long') !== undefined, 'the terminal');
    const terminal = api.getTerminal('long')!;
    await vscode.commands.executeCommand('terminalCommands.kill', 'long');
    await waitForStatus('long', 'stopped');
    await waitFor(() => !vscode.window.terminals.includes(terminal), 'the terminal to close');
    assert.equal(api.getState('long')?.hasTerminal, false);
  });

  it('notices when the user closes the terminal', async () => {
    await start('long');
    await waitForStatus('long', 'running');
    await waitFor(() => api.getTerminal('long') !== undefined, 'the terminal');
    api.getTerminal('long')!.dispose();
    await waitForStatus('long', 'stopped');
    await waitFor(() => api.getState('long')?.hasTerminal === false, 'the terminal to be forgotten');
  });

  it('starts and stops everything', async () => {
    await vscode.commands.executeCommand('terminalCommands.startAll');
    await waitForStatus('long', 'running');
    await waitForStatus('fail', 'failed');
    await waitForStatus('quick', 'stopped');
    await vscode.commands.executeCommand('terminalCommands.stopAll');
    await waitForStatus('long', 'stopped');
  });

  it('lists the groups', () => {
    assert.deepEqual(api.groupNames(), ['servers', 'checks']);
    assert.deepEqual(api.autoStartGroupNames(), []);
  });

  it('starts and stops a group', async () => {
    await vscode.commands.executeCommand('terminalCommands.startGroup', 'servers');
    await waitForStatus('long', 'running');
    await waitForStatus('auto', 'running');
    assert.equal(status('quick'), 'stopped');
    await vscode.commands.executeCommand('terminalCommands.stopGroup', 'servers');
    await waitForStatus('long', 'stopped');
    await waitForStatus('auto', 'stopped');
  });

  it('starts a group when it is chosen to auto-start, and leaves it running when it no longer is', async () => {
    await vscode.commands.executeCommand('terminalCommands.chooseAutoStartGroups', ['servers']);
    assert.deepEqual(api.autoStartGroupNames(), ['servers']);
    await waitForStatus('long', 'running');
    await vscode.commands.executeCommand('terminalCommands.chooseAutoStartGroups', []);
    assert.deepEqual(api.autoStartGroupNames(), []);
    await sleep(500);
    assert.equal(status('long'), 'running');
  });

  it('offers the commands as tasks and tracks runs started from them', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: 'terminalCommand' });
    // tasks.json customizes "quick" (see the fixture), which renames it.
    assert.deepEqual(tasks.map((task) => task.name).sort(), ['auto', 'env-cwd', 'fail', 'long', 'quick via tasks.json']);
    await vscode.tasks.executeTask(tasks.find((task) => task.name === 'long')!);
    await waitForStatus('long', 'running');
    await vscode.commands.executeCommand('terminalCommands.stop', 'long');
    await waitForStatus('long', 'stopped');
  });

  it('resolves tasks.json tasks that refer to a command', async () => {
    const tasks = await vscode.tasks.fetchTasks({ type: 'terminalCommand' });
    const custom = tasks.find((task) => task.name === 'quick via tasks.json');
    assert.ok(custom, `tasks.json's task is listed (got ${tasks.map((task) => task.name).join(', ')})`);
    await vscode.tasks.executeTask(custom);
    await waitForStatus('quick', 'stopped');
    assert.equal(api.getState('quick')?.exitCode, 0);

    const dependent = (await vscode.tasks.fetchTasks()).find((task) => task.name === 'after quick')!;
    await vscode.tasks.executeTask(dependent);
    await waitFor(() => fs.existsSync(envCwdOutput), 'the dependency to run');
  });

  it('opens the config in the config editor, and as JSON', async () => {
    const activeInput = () => vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    try {
      await vscode.commands.executeCommand('terminalCommands.openConfig');
      await waitFor(() => activeInput() instanceof vscode.TabInputCustom, 'the config editor to open');
      const input = activeInput() as vscode.TabInputCustom;
      assert.equal(input.viewType, 'terminalCommands.configEditor');
      assert.equal(input.uri.fsPath, configPath);

      // Switching between the form and the JSON happens in place.
      await vscode.commands.executeCommand('terminalCommands.openConfigJson');
      await waitFor(() => activeInput() instanceof vscode.TabInputText, 'the config to open as JSON');
      assert.equal((activeInput() as vscode.TabInputText).uri.fsPath, configPath);
      assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, 1);
      await vscode.commands.executeCommand('terminalCommands.openConfigUi', vscode.Uri.file(configPath));
      await waitFor(() => activeInput() instanceof vscode.TabInputCustom, 'the config editor to open again');
      await waitFor(() => vscode.window.tabGroups.activeTabGroup.tabs.length === 1, 'the JSON tab to close');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });

  it('reloads when the config file changes', async () => {
    const config = originalConfig.replace('"commands": [', '"commands": [\n    { "name": "added", "command": "true" },');
    fs.writeFileSync(configPath, config);
    await waitFor(() => api.commandNames().includes('added'), 'the new command to appear');
    assert.deepEqual(api.commandNames(), ['added', 'quick', 'fail', 'long', 'auto', 'env-cwd']);
  });
});
