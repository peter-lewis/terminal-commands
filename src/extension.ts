import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { autoStartFingerprint, decideAutoStart, type AutoStartDecision, type AutoStartMode } from './autoStartPolicy';
import { CommandRunner, isActive, TASK_TYPE, taskFor, type CommandState, type LaunchSpec } from './commandRunner';
import { CommandTreeProvider, groupMembers, isTreeNode, type GroupNode, type TreeNode } from './commandTree';
import { CONFIG_EDITOR_VIEW_TYPE, ConfigEditorProvider } from './configEditor';
import type { GroupDefinition } from './config';
import { ConfigStore, configUriFor, groupTargets, targetsOf, type CommandTarget, type FolderConfig } from './configStore';
import { scaffoldConfig, type ScaffoldInput } from './scaffold';

/** workspaceState key: auto-start decisions about the commands marked autoStart, by workspace folder URI. */
const DECISIONS_KEY = 'terminalCommands.autoStartDecisions';
/** workspaceState key: the groups the user chose to auto-start, by workspace folder URI. */
const AUTO_START_GROUPS_KEY = 'terminalCommands.autoStartGroups';
/** workspaceState key: whether the view has been shown in this workspace. */
const VIEW_SHOWN_KEY = 'terminalCommands.viewShown';
/** How long VS Code gets to reconnect to commands that kept running through a window reload. */
const RECONNECT_SETTLE_MS = 1500;

/** A group the user chose to auto-start, with the fingerprint of its commands when they chose it. */
interface AutoStartGroup {
  readonly name: string;
  readonly fingerprint: string;
}

type GroupOnlyNode = Extract<GroupNode, { kind: 'group' }>;

/** What `activate` returns. Not a supported API; it lets the integration tests observe the extension. */
export interface TerminalCommandsApi {
  /** Settles once every workspace folder's config has been loaded. */
  readonly ready: Promise<void>;
  readonly onDidChange: vscode.Event<void>;
  commandNames(): string[];
  groupNames(): string[];
  /** The groups chosen to auto-start. */
  autoStartGroupNames(): string[];
  getState(name: string): CommandState | undefined;
  getTerminal(name: string): vscode.Terminal | undefined;
}

export function activate(context: vscode.ExtensionContext): TerminalCommandsApi {
  const log = vscode.window.createOutputChannel('Terminal Commands', { log: true });
  const store = new ConfigStore();
  const runner = new CommandRunner(log);
  const isAutoStartGroup = (config: FolderConfig, name: string) =>
    chosenGroups(config.folder.uri.toString()).some((group) => group.name === name);
  const tree = new CommandTreeProvider(store, runner, isAutoStartGroup);
  // A group's checkbox is about the group only, not the commands in it.
  const view = vscode.window.createTreeView('terminalCommands', { treeDataProvider: tree, manageCheckboxStateManually: true });
  const statusItem = vscode.window.createStatusBarItem('terminalCommands.status', vscode.StatusBarAlignment.Left, 10);
  statusItem.name = 'Terminal Commands';
  statusItem.command = 'terminalCommands.focus';
  const changeEmitter = new vscode.EventEmitter<void>();
  const configEditor = new ConfigEditorProvider(context.extensionUri, log, renameChosenGroup);
  context.subscriptions.push(
    log,
    store,
    runner,
    tree,
    view,
    statusItem,
    changeEmitter,
    vscode.window.registerCustomEditorProvider(CONFIG_EDITOR_VIEW_TYPE, configEditor),
  );

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
    void vscode.commands.executeCommand('setContext', 'terminalCommands.hasGroups', allGroups().length > 0);
  }

  function allGroups(): GroupOnlyNode[] {
    return store.folders.flatMap((config) => config.groups.map((group): GroupOnlyNode => ({ kind: 'group', config, group })));
  }

  /**
   * Resolves a group command's argument: a group's node when invoked from the view, a group name when
   * invoked from a keybinding, otherwise whatever the user picks.
   */
  async function resolveGroup(arg: unknown, placeHolder: string): Promise<GroupNode | undefined> {
    if (isTreeNode(arg) && (arg.kind === 'group' || arg.kind === 'ungrouped')) return arg;
    const groups = allGroups();
    if (typeof arg === 'string') {
      const group = groups.find((candidate) => candidate.group.name === arg);
      if (!group) void vscode.window.showErrorMessage(`There is no terminal command group named "${arg}".`);
      return group;
    }
    return (await pickGroups(groups, placeHolder, false))?.[0];
  }

  async function pickGroups(
    groups: GroupOnlyNode[],
    placeHolder: string,
    canPickMany: boolean,
  ): Promise<GroupOnlyNode[] | undefined> {
    if (groups.length === 0) {
      void vscode.window.showInformationMessage('There are no terminal command groups.');
      return undefined;
    }
    const multiRoot = new Set(groups.map((node) => node.config.folder.uri.toString())).size > 1;
    const items = groups.map((node) => ({
      label: node.group.name,
      description: multiRoot ? node.config.folder.name : undefined,
      detail: node.group.commands.join(', '),
      picked: canPickMany && isAutoStartGroup(node.config, node.group.name),
      node,
    }));
    if (canPickMany) return (await vscode.window.showQuickPick(items, { placeHolder, canPickMany: true }))?.map((item) => item.node);
    const picked = await vscode.window.showQuickPick(items, { placeHolder });
    return picked && [picked.node];
  }

  function chosenGroups(folderKey: string): readonly AutoStartGroup[] {
    return context.workspaceState.get<Record<string, AutoStartGroup[]>>(AUTO_START_GROUPS_KEY, {})[folderKey] ?? [];
  }

  /** Records that a group auto-starts, as long as its commands match the fingerprint, or that it doesn't. */
  async function setChosenGroup(folderKey: string, name: string, fingerprint: string | undefined): Promise<void> {
    const all = context.workspaceState.get<Record<string, AutoStartGroup[]>>(AUTO_START_GROUPS_KEY, {});
    const groups = (all[folderKey] ?? []).filter((group) => group.name !== name);
    if (fingerprint !== undefined) groups.push({ name, fingerprint });
    await context.workspaceState.update(AUTO_START_GROUPS_KEY, { ...all, [folderKey]: groups });
    tree.refresh();
  }

  /**
   * Choosing a group to auto-start also starts it. The view lists what's in the group, so choosing it
   * counts as allowing those commands to auto-start, as they are now.
   */
  async function setGroupAutoStart(config: FolderConfig, group: GroupDefinition, autoStart: boolean): Promise<void> {
    const targets = groupTargets(config, group);
    await setChosenGroup(config.folder.uri.toString(), group.name, autoStart ? fingerprintOf(targets) : undefined);
    if (autoStart) await Promise.all(targets.map((target) => runner.start(launchSpecFor(target))));
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

  /** Opens a folder's config, in the config editor or as JSON, creating the config if there's none yet. */
  async function openConfig(arg: unknown, editor: 'ui' | 'json' = 'ui'): Promise<void> {
    // From an editor's title bar, the argument is the config file itself.
    let uri = arg instanceof vscode.Uri ? arg : undefined;
    if (!uri) {
      const folder = folderOf(arg) ?? (await pickFolder());
      if (!folder) return;
      uri = configUriFor(folder);
      if (!(await exists(uri))) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode'));
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(scaffoldConfig(await scaffoldInput(folder))));
      }
    }
    if (editor === 'ui') await configEditor.open(uri);
    else await configEditor.openJson(uri);
  }

  /** A group renamed in the config editor stays chosen to auto-start. */
  function renameChosenGroup(configUri: vscode.Uri, from: string, to: string): void {
    const folder = vscode.workspace.getWorkspaceFolder(configUri);
    if (!folder || configUriFor(folder).toString() !== configUri.toString()) return;
    const folderKey = folder.uri.toString();
    const all = context.workspaceState.get<Record<string, AutoStartGroup[]>>(AUTO_START_GROUPS_KEY, {});
    const groups = all[folderKey] ?? [];
    if (!groups.some((group) => group.name === from)) return;
    const renamed = groups.filter((group) => group.name !== to).map((group) => (group.name === from ? { ...group, name: to } : group));
    void context.workspaceState.update(AUTO_START_GROUPS_KEY, { ...all, [folderKey]: renamed }).then(() => tree.refresh());
  }

  /**
   * Starts what should start when a folder's config is first loaded: the commands marked autoStart, and
   * the groups the user chose. Each is decided on separately, and asks again once its commands change. A
   * question the user leaves unanswered holds up only what it's about.
   */
  async function autoStart(config: FolderConfig): Promise<void> {
    const folderKey = config.folder.uri.toString();
    const mode = vscode.workspace.getConfiguration('terminalCommands').get<AutoStartMode>('autoStart', 'prompt');
    // After a window reload, commands may still be running from before. VS Code reconnects to them
    // shortly after it has asked for the tasks; starting them sooner would run a second copy.
    let settled: Promise<void> | undefined;
    const settle = () =>
      (settled ??= Promise.resolve(vscode.tasks.fetchTasks({ type: TASK_TYPE })).then(
        () => new Promise((resolve) => setTimeout(resolve, RECONNECT_SETTLE_MS)),
      ));
    /** Starts a set of commands once that's done, if the config still has them the way the user agreed to. */
    const startWhenSettled = async (fingerprint: string, targetsIn: (current: FolderConfig) => CommandTarget[] | undefined) => {
      await settle();
      const current = store.folders.find((candidate) => candidate.folder.uri.toString() === folderKey);
      const targets = current && targetsIn(current);
      if (targets && fingerprintOf(targets) === fingerprint) {
        await Promise.all(targets.map((target) => runner.start(launchSpecFor(target))));
      }
    };
    const starts: Array<Promise<void>> = [];

    const marked = (current: FolderConfig) => targetsOf(current).filter((target) => target.definition.autoStart);
    const markedTargets = marked(config);
    if (markedTargets.length > 0) {
      const fingerprint = fingerprintOf(markedTargets);
      const previous = context.workspaceState.get<Record<string, AutoStartDecision>>(DECISIONS_KEY, {})[folderKey];
      const decision = decideAutoStart(mode, fingerprint, previous);
      if (decision === 'start') starts.push(startWhenSettled(fingerprint, marked));
      if (decision === 'ask') {
        const names = namesOf(markedTargets);
        const message = previous
          ? `The auto-start commands for ${config.folder.name} have changed: ${names}. Start them?`
          : `${config.folder.name} has commands that start automatically: ${names}. Allow them to start?`;
        starts.push(
          askToAutoStart(config, message).then(async (allowed) => {
            if (allowed === undefined) return;
            const decisions = context.workspaceState.get<Record<string, AutoStartDecision>>(DECISIONS_KEY, {});
            await context.workspaceState.update(DECISIONS_KEY, { ...decisions, [folderKey]: { fingerprint, allowed } });
            if (allowed) await startWhenSettled(fingerprint, marked);
          }),
        );
      }
    }

    for (const chosen of chosenGroups(folderKey)) {
      const group = config.groups.find((candidate) => candidate.name === chosen.name);
      if (!group) continue;
      const targets = groupTargets(config, group);
      const fingerprint = fingerprintOf(targets);
      // Only while the group is still checked: the user can uncheck it in the meantime.
      const groupTargetsIn = (current: FolderConfig) => {
        const currentGroup = current.groups.find((candidate) => candidate.name === group.name);
        return currentGroup && isAutoStartGroup(current, group.name) ? groupTargets(current, currentGroup) : undefined;
      };
      const decision = decideAutoStart(mode, fingerprint, { fingerprint: chosen.fingerprint, allowed: true });
      if (decision === 'start') starts.push(startWhenSettled(fingerprint, groupTargetsIn));
      if (decision === 'ask') {
        const message = `The "${group.name}" group has changed since you chose to auto-start it: ${namesOf(targets)}. Start it?`;
        starts.push(
          askToAutoStart(config, message).then(async (allowed) => {
            if (allowed === undefined || !isAutoStartGroup(config, group.name)) return;
            // Declining unchecks the group, so that the checkboxes show what will start next time.
            await setChosenGroup(folderKey, group.name, allowed ? fingerprint : undefined);
            if (allowed) await startWhenSettled(fingerprint, groupTargetsIn);
          }),
        );
      }
    }
    await Promise.all(starts);
  }

  async function askToAutoStart(config: FolderConfig, message: string): Promise<boolean | undefined> {
    const choice = await vscode.window.showInformationMessage(message, 'Allow', 'Review Config', "Don't Allow");
    if (choice === 'Review Config') {
      await openConfig(config.folder);
      return askToAutoStart(config, message);
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
    if (target) await configEditor.open(target.config.configUri, target.definition.name);
  });
  register('terminalCommands.startAll', async () => {
    const idle = store.targets().filter((target) => !isActive(runner.getState(target.key).status));
    await Promise.all(idle.map((target) => runner.start(launchSpecFor(target))));
  });
  register('terminalCommands.stopAll', () => runner.stopAll());
  register('terminalCommands.startGroup', async (arg) => {
    const node = await resolveGroup(arg, 'Select a group to start');
    if (node) await Promise.all(groupMembers(node).map((target) => runner.start(launchSpecFor(target))));
  });
  register('terminalCommands.stopGroup', async (arg) => {
    const node = await resolveGroup(arg, 'Select a group to stop');
    for (const target of node ? groupMembers(node) : []) runner.stop(target.key);
  });
  register('terminalCommands.chooseAutoStartGroups', async (arg) => {
    const groups = allGroups();
    // Takes the names of the groups to auto-start, e.g. from a keybinding.
    const chosen = Array.isArray(arg)
      ? groups.filter((node) => arg.includes(node.group.name))
      : await pickGroups(groups, 'Select the groups to start when the project opens', true);
    if (!chosen) return;
    for (const node of groups) {
      const autoStart = chosen.includes(node);
      if (autoStart !== isAutoStartGroup(node.config, node.group.name)) await setGroupAutoStart(node.config, node.group, autoStart);
    }
  });
  register('terminalCommands.openConfig', (arg) => openConfig(arg));
  register('terminalCommands.openConfigJson', (arg) => openConfig(arg, 'json'));
  register('terminalCommands.openConfigUi', (arg) => openConfig(arg, 'ui'));
  register('terminalCommands.resetAutoStartDecisions', async () => {
    await context.workspaceState.update(DECISIONS_KEY, undefined);
    await context.workspaceState.update(AUTO_START_GROUPS_KEY, undefined);
    tree.refresh();
    void vscode.window.showInformationMessage(
      "Terminal Commands will ask again before auto-starting this workspace's commands, and no groups are set to auto-start.",
    );
  });

  context.subscriptions.push(
    view.onDidChangeCheckboxState(async (event) => {
      for (const [node, state] of event.items) {
        if (node.kind !== 'group') continue;
        await setGroupAutoStart(node.config, node.group, state === vscode.TreeItemCheckboxState.Checked).catch(
          (error: unknown) => void vscode.window.showErrorMessage(`Terminal Commands couldn't start "${node.group.name}": ${String(error)}`),
        );
      }
    }),
    store.onDidChange(() => {
      setContextKeys();
      render();
    }),
    // The groups' checkboxes say whether auto-start is turned off.
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('terminalCommands.autoStart')) tree.refresh();
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
    groupNames: () => allGroups().map((node) => node.group.name),
    autoStartGroupNames: () =>
      allGroups()
        .filter((node) => isAutoStartGroup(node.config, node.group.name))
        .map((node) => node.group.name),
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

function fingerprintOf(targets: readonly CommandTarget[]): string {
  return autoStartFingerprint(targets.map((target) => target.definition));
}

function namesOf(targets: readonly CommandTarget[]): string {
  return targets.map((target) => `"${target.definition.name}"`).join(', ');
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
