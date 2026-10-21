import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { autoStartFingerprint, decideAutoStart, type AutoStartDecision, type AutoStartMode } from './autoStartPolicy';
import { CommandRunner, isActive, TASK_TYPE, taskFor, type CommandState, type LaunchSpec } from './commandRunner';
import { CommandTreeProvider, isTreeNode, type TreeNode } from './commandTree';
import type { CommandDefinition } from './config';
import { ConfigStore, configUriFor, targetsOf, type CommandTarget, type FolderConfig } from './configStore';
import { scaffoldConfig, type ScaffoldInput } from './scaffold';

/** workspaceState key: auto-start decisions by workspace folder URI. */
const DECISIONS_KEY = 'terminalCommands.autoStartDecisions';
/** workspaceState key: whether the view has been shown in this workspace. */
const VIEW_SHOWN_KEY = 'terminalCommands.viewShown';
/** How long VS Code gets to reconnect to commands that kept running through a window reload. */
const RECONNECT_SETTLE_MS = 1500;

/** What `activate` returns. Not a supported API; it lets the integration tests observe the extension. */
export interface TerminalCommandsApi {
  /** Settles once every workspace folder's config has been loaded. */
  readonly ready: Promise<void>;
  readonly onDidChange: vscode.Event<void>;
  commandNames(): string[];
  getState(name: string): CommandState | undefined;
  getTerminal(name: string): vscode.Terminal | undefined;
}

export function activate(context: vscode.ExtensionContext): TerminalCommandsApi {
  const log = vscode.window.createOutputChannel('Terminal Commands', { log: true });
  const store = new ConfigStore();
  const runner = new CommandRunner(log);
  const tree = new CommandTreeProvider(store, runner);
  const view = vscode.window.createTreeView('terminalCommands', { treeDataProvider: tree });
  const statusItem = vscode.window.createStatusBarItem('terminalCommands.status', vscode.StatusBarAlignment.Left, 10);
  statusItem.name = 'Terminal Commands';
  statusItem.command = 'terminalCommands.focus';
  const changeEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(log, store, runner, tree, view, statusItem, changeEmitter);

  function render(): void {
    tree.refresh();
    const targets = store.targets();
    const states = targets.map((target) => runner.getState(target.key));
    const active = states.filter((state) => isActive(state.status)).length;
    const failed = states.filter((state) => state.status === 'failed').length;
    view.description = targets.length > 0 ? `${active}/${targets.length}` : undefined;
    if (targets.length > 0) {
      statusItem.text = `$(terminal) ${active}/${targets.length}${failed > 0 ? ` $(error) ${failed}` : ''}`;
      statusItem.tooltip = `Terminal Commands: ${active} of ${targets.length} running${failed > 0 ? `, ${failed} failed` : ''}`;
      statusItem.show();
    } else {
      statusItem.hide();
    }
    changeEmitter.fire();
  }

  function setContextKeys(): void {
    void vscode.commands.executeCommand('setContext', 'terminalCommands.hasConfig', store.folders.some((config) => config.exists));
    void vscode.commands.executeCommand('setContext', 'terminalCommands.hasCommands', store.targets().length > 0);
  }

  /**
   * Resolves a command's argument to a target: a tree node when invoked from the view, a command name
   * when invoked from a keybinding or another extension, otherwise whatever the user picks.
   */
  async function resolveTarget(
    arg: unknown,
    placeHolder: string,
    applies: (state: CommandState) => boolean,
    noneApply: string,
  ): Promise<CommandTarget | undefined> {
    if (isTreeNode(arg) && arg.kind === 'command') return arg;
    const targets = store.targets();
    if (typeof arg === 'string') {
      const target = targets.find((candidate) => candidate.definition.name === arg);
      if (!target) void vscode.window.showErrorMessage(`There is no terminal command named "${arg}".`);
      return target;
    }
    const candidates = targets.filter((target) => applies(runner.getState(target.key)));
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(noneApply);
      return undefined;
    }
    const multiRoot = new Set(candidates.map((target) => target.config.folder.uri.toString())).size > 1;
    const picked = await vscode.window.showQuickPick(
      candidates.map((target) => ({
        label: target.definition.name,
        description: multiRoot ? target.config.folder.name : undefined,
        detail: target.definition.command,
        target,
      })),
      { placeHolder, matchOnDetail: true },
    );
    return picked?.target;
  }

  async function openConfig(arg: unknown): Promise<void> {
    const folder = folderOf(arg) ?? (await pickFolder());
    if (!folder) return;
    const uri = configUriFor(folder);
    if (!(await exists(uri))) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(scaffoldConfig(await scaffoldInput(folder))));
    }
    await vscode.window.showTextDocument(uri);
  }

  async function autoStart(config: FolderConfig): Promise<void> {
    const commands = config.commands.filter((command) => command.autoStart);
    if (commands.length === 0) return;
    const folderKey = config.folder.uri.toString();
    const fingerprint = autoStartFingerprint(config.commands);
    const mode = vscode.workspace.getConfiguration('terminalCommands').get<AutoStartMode>('autoStart', 'prompt');
    const previous = context.workspaceState.get<Record<string, AutoStartDecision>>(DECISIONS_KEY, {})[folderKey];
    const decision = decideAutoStart(mode, fingerprint, previous);
    if (decision === 'skip') return;
    if (decision === 'ask') {
      const allowed = await askToAutoStart(config, commands, previous !== undefined);
      if (allowed === undefined) return;
      const decisions = context.workspaceState.get<Record<string, AutoStartDecision>>(DECISIONS_KEY, {});
      await context.workspaceState.update(DECISIONS_KEY, { ...decisions, [folderKey]: { fingerprint, allowed } });
      if (!allowed) return;
    }
    // After a window reload, commands may still be running from before. VS Code reconnects to them
    // shortly after it has asked for the tasks; starting them sooner would run a second copy.
    await vscode.tasks.fetchTasks({ type: TASK_TYPE });
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_SETTLE_MS));

    // The config may have changed meanwhile. Only start what the user agreed to.
    const current = store.folders.find((candidate) => candidate.folder.uri.toString() === folderKey);
    if (!current || autoStartFingerprint(current.commands) !== fingerprint) return;
    const targets = targetsOf(current).filter((target) => target.definition.autoStart);
    await Promise.all(targets.map((target) => runner.start(launchSpecFor(target))));
  }

  async function askToAutoStart(
    config: FolderConfig,
    commands: readonly CommandDefinition[],
    changed: boolean,
  ): Promise<boolean | undefined> {
    const names = commands.map((command) => `"${command.name}"`).join(', ');
    const message = changed
      ? `The auto-start commands for ${config.folder.name} have changed: ${names}. Start them?`
      : `${config.folder.name} has commands that start automatically: ${names}. Allow them to start?`;
    const choice = await vscode.window.showInformationMessage(message, 'Allow', 'Review Config', "Don't Allow");
    if (choice === 'Review Config') {
      await openConfig(config.folder);
      return askToAutoStart(config, commands, changed);
    }
    return choice === undefined ? undefined : choice === 'Allow';
  }

  /**
   * VS Code adds the view to the Explorer collapsed, and remembers per workspace whether it's expanded.
   * So that a project's commands are on show when it opens, the view is expanded the first time a
   * workspace has commands. After that it stays the way the user leaves it.
   */
  async function showViewOnce(): Promise<void> {
    if (store.targets().length === 0 || context.workspaceState.get<boolean>(VIEW_SHOWN_KEY)) return;
    await context.workspaceState.update(VIEW_SHOWN_KEY, true);
    // Given no element, reveal() just shows the view.
    if (!view.visible) await view.reveal(undefined as unknown as TreeNode, { select: false, focus: false });
  }

  function register(id: string, handler: (arg?: unknown) => unknown): void {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  register('terminalCommands.open', async (arg) => {
    const target = await resolveTarget(arg, 'Select a command', () => true, 'There are no terminal commands.');
    if (target && !runner.show(target.key, true)) await runner.start(launchSpecFor(target), { reveal: true });
  });
  register('terminalCommands.start', async (arg) => {
    const target = await resolveTarget(
      arg,
      'Select a command to start',
      (state) => !isActive(state.status),
      'All terminal commands are already running.',
    );
    if (target) await runner.start(launchSpecFor(target), { reveal: true });
  });
  register('terminalCommands.stop', async (arg) => {
    const target = await resolveTarget(
      arg,
      'Select a command to stop',
      (state) => isActive(state.status),
      'No terminal commands are running.',
    );
    if (target) runner.stop(target.key);
  });
  register('terminalCommands.restart', async (arg) => {
    const target = await resolveTarget(arg, 'Select a command to restart', () => true, 'There are no terminal commands.');
    if (target) await runner.restart(launchSpecFor(target), { reveal: true });
  });
  register('terminalCommands.showTerminal', async (arg) => {
    const target = await resolveTarget(
      arg,
      'Select a command',
      (state) => state.hasTerminal,
      'No terminal commands have an open terminal.',
    );
    if (target) runner.show(target.key, false);
  });
  register('terminalCommands.kill', async (arg) => {
    const target = await resolveTarget(
      arg,
      'Select a command to kill',
      (state) => isActive(state.status) || state.hasTerminal,
      'No terminal commands are running or have an open terminal.',
    );
    if (target) runner.kill(target.key);
  });
  register('terminalCommands.edit', async (arg) => {
    const target = await resolveTarget(arg, 'Select a command to edit', () => true, 'There are no terminal commands.');
    if (!target) return;
    const document = await vscode.workspace.openTextDocument(target.config.configUri);
    const position = document.positionAt(target.definition.offset);
    await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) });
  });
  register('terminalCommands.startAll', async () => {
    const idle = store.targets().filter((target) => !isActive(runner.getState(target.key).status));
    await Promise.all(idle.map((target) => runner.start(launchSpecFor(target))));
  });
  register('terminalCommands.stopAll', () => runner.stopAll());
  register('terminalCommands.openConfig', (arg) => openConfig(arg));
  register('terminalCommands.resetAutoStartDecisions', async () => {
    await context.workspaceState.update(DECISIONS_KEY, undefined);
    void vscode.window.showInformationMessage(
      "Terminal Commands will ask again before auto-starting this workspace's commands.",
    );
  });

  context.subscriptions.push(
    store.onDidChange(() => {
      setContextKeys();
      render();
    }),
    store.onDidOpenFolder((config) => {
      autoStart(config).catch((error: unknown) => {
        void vscode.window.showErrorMessage(`Terminal Commands couldn't auto-start commands: ${String(error)}`);
      });
    }),
    runner.onDidChangeState(() => render()),
  );

  const loaded = store.initialize();
  const ready = loaded.then(async () => {
    await vscode.commands.executeCommand('setContext', 'terminalCommands.loaded', true);
    showViewOnce().catch((error: unknown) => log.warn(`Couldn't show the view: ${String(error)}`));
  });

  // Lists the commands under "Tasks: Run Task", and lets tasks.json refer to them by name. VS Code also
  // relies on it to reconnect to running commands after a window reload, which is often what activates
  // the extension, so it must wait for the config rather than answer with nothing.
  const taskProvider = vscode.tasks.registerTaskProvider(TASK_TYPE, {
    provideTasks: async () => {
      await loaded;
      return store.targets().map((target) => taskFor(launchSpecFor(target), true));
    },
    resolveTask: async (task) => {
      await loaded;
      const folderUri = typeof task.scope === 'object' ? task.scope.uri.toString() : undefined;
      const target = store
        .targets()
        .find(
          (candidate) =>
            candidate.definition.name === task.definition.name && candidate.config.folder.uri.toString() === folderUri,
        );
      return target && taskFor(launchSpecFor(target), true, task.definition);
    },
  });
  context.subscriptions.push(taskProvider);

  const find = (name: string) => store.targets().find((target) => target.definition.name === name);
  return {
    ready,
    onDidChange: changeEmitter.event,
    commandNames: () => store.targets().map((target) => target.definition.name),
    getState: (name) => {
      const target = find(name);
      return target && runner.getState(target.key);
    },
    getTerminal: (name) => {
      const target = find(name);
      return target && runner.getTerminal(target.key);
    },
  };
}

function launchSpecFor(target: CommandTarget): LaunchSpec {
  const { folder } = target.config;
  const { definition } = target;
  const cwd = definition.cwd?.replace(/^~(?=$|[\\/])/, os.homedir());
  return {
    key: target.key,
    name: definition.name,
    folder,
    commandLine: definition.command,
    cwd: cwd ? path.resolve(folder.uri.fsPath, cwd) : folder.uri.fsPath,
    env: definition.env,
  };
}

/** The workspace folder a command argument refers to: a tree node or a workspace folder. */
function folderOf(arg: unknown): vscode.WorkspaceFolder | undefined {
  if (isTreeNode(arg)) return arg.config.folder;
  const uri = typeof arg === 'object' && arg !== null && 'uri' in arg ? arg.uri : undefined;
  return uri instanceof vscode.Uri ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];
  return vscode.window.showWorkspaceFolderPick({ placeHolder: 'Select the folder whose commands to edit' });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false,
  );
}

async function scaffoldInput(folder: vscode.WorkspaceFolder): Promise<ScaffoldInput> {
  const packageJson = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'package.json')).then(
    (bytes) => new TextDecoder().decode(bytes),
    () => undefined,
  );
  const rootEntries = await vscode.workspace.fs.readDirectory(folder.uri).then(
    (entries) => entries.map(([name]) => name),
    () => [],
  );
  return { packageJson, rootEntries };
}
