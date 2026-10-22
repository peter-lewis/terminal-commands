import * as vscode from 'vscode';
import type { GroupDefinition } from './config';
import { groupTargets, targetsOf, type CommandTarget, type ConfigStore, type FolderConfig } from './configStore';
import { isActive, type CommandRunner, type CommandState } from './commandRunner';

/** A group, or the commands that are in no group. */
export type GroupNode =
  | { readonly kind: 'group'; readonly config: FolderConfig; readonly group: GroupDefinition }
  | { readonly kind: 'ungrouped'; readonly config: FolderConfig };

export type TreeNode =
  | { readonly kind: 'folder'; readonly config: FolderConfig }
  | GroupNode
  /** A command appears under each group it's in. */
  | ({ readonly kind: 'command'; readonly parent?: GroupNode } & CommandTarget)
  | { readonly kind: 'problem'; readonly config: FolderConfig; readonly message: string; readonly index: number };

export type CommandNode = Extract<TreeNode, { kind: 'command' }>;

export function isTreeNode(value: unknown): value is TreeNode {
  return typeof value === 'object' && value !== null && 'kind' in value && 'config' in value;
}

/** The commands under a group's node. */
export function groupMembers(node: GroupNode): CommandTarget[] {
  if (node.kind === 'group') return groupTargets(node.config, node.group);
  const grouped = new Set(node.config.groups.flatMap((group) => group.commands));
  return targetsOf(node.config).filter((target) => !grouped.has(target.definition.name));
}

/**
 * Lists each folder's commands with their live status, by group if the config has groups. Folders get
 * their own level only in multi-root workspaces.
 */
export class CommandTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: ConfigStore,
    private readonly runner: CommandRunner,
    /** Whether the user chose to auto-start a group, which its checkbox shows. */
    private readonly isAutoStartGroup: (config: FolderConfig, group: string) => boolean,
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      const configs = this.store.folders.filter((config) => config.exists);
      if (configs.length === 1) return childrenOf(configs[0]);
      return configs.map((config) => ({ kind: 'folder', config }));
    }
    switch (node.kind) {
      case 'folder':
        return childrenOf(node.config);
      case 'group':
      case 'ungrouped':
        return groupMembers(node).map((target): TreeNode => ({ kind: 'command', parent: node, ...target }));
      default:
        return [];
    }
  }

  /** TreeView.reveal needs this. Folder nodes only exist in multi-root workspaces. */
  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'command' && node.parent) return node.parent;
    if (node.kind === 'folder' || this.store.folders.filter((config) => config.exists).length === 1) return undefined;
    return { kind: 'folder', config: node.config };
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'folder':
        return this.folderItem(node.config);
      case 'group':
      case 'ungrouped':
        return this.groupItem(node);
      case 'command':
        return commandItem(node, this.runner.getState(node.key));
      case 'problem':
        return problemItem(node);
    }
  }

  private folderItem(config: FolderConfig): vscode.TreeItem {
    const item = new vscode.TreeItem(config.folder.name, vscode.TreeItemCollapsibleState.Expanded);
    const targets = targetsOf(config);
    const active = targets.filter((target) => isActive(this.runner.getState(target.key).status)).length;
    item.id = config.folder.uri.toString();
    item.iconPath = new vscode.ThemeIcon('root-folder');
    item.description = targets.length > 0 ? `${active}/${targets.length}` : undefined;
    item.contextValue = 'folder';
    return item;
  }

  private groupItem(node: GroupNode): vscode.TreeItem {
    const states = groupMembers(node).map((target) => this.runner.getState(target.key));
    const active = states.filter((state) => isActive(state.status)).length;
    const item = new vscode.TreeItem(
      node.kind === 'group' ? node.group.name : 'Other Commands',
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = groupNodeId(node);
    item.description = `${active}/${states.length}`;
    if (node.kind === 'ungrouped') {
      // In place of the groups' checkboxes, so that the labels line up.
      item.iconPath = new vscode.ThemeIcon('blank');
      item.contextValue = 'ungrouped';
      return item;
    }

    const autoStart = this.isAutoStartGroup(node.config, node.group.name);
    const turnedOff = vscode.workspace.getConfiguration('terminalCommands').get('autoStart') === 'never';
    item.checkboxState = {
      state: autoStart ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
      tooltip: turnedOff
        ? 'Nothing starts when the project opens: the terminalCommands.autoStart setting is "never"'
        : autoStart
          ? 'Starts when the project opens'
          : 'Start now, and whenever the project opens',
    };
    const canStart = states.some((state) => !isActive(state.status));
    const canStop = states.some((state) => isActive(state.status));
    item.contextValue = `group${canStart ? ':canStart' : ''}${canStop ? ':canStop' : ''}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown('**').appendText(node.group.name).appendMarkdown(`** — ${active} of ${states.length} running`);
    if (autoStart) tooltip.appendMarkdown('\n\nStarts when the project opens.');
    item.tooltip = tooltip;
    return item;
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function childrenOf(config: FolderConfig): TreeNode[] {
  const problems = config.problems.map((message, index): TreeNode => ({ kind: 'problem', config, message, index }));
  if (config.groups.length === 0) {
    return [...problems, ...targetsOf(config).map((target): TreeNode => ({ kind: 'command', ...target }))];
  }
  const ungrouped: GroupNode = { kind: 'ungrouped', config };
  return [
    ...problems,
    ...config.groups.map((group): TreeNode => ({ kind: 'group', config, group })),
    ...(groupMembers(ungrouped).length > 0 ? [ungrouped] : []),
  ];
}

/** Tree item IDs must be unique, and a command can be in several groups. */
function groupNodeId(node: GroupNode): string {
  const folder = node.config.folder.uri.toString();
  return JSON.stringify(node.kind === 'group' ? [folder, 'group', node.group.name] : [folder, 'ungrouped']);
}

function commandItem(node: CommandNode, state: CommandState): vscode.TreeItem {
  const { definition } = node;
  const item = new vscode.TreeItem(definition.name, vscode.TreeItemCollapsibleState.None);
  item.id = node.parent ? `${groupNodeId(node.parent)}/${JSON.stringify(definition.name)}` : node.key;
  item.iconPath = statusIcon(state);
  item.description = statusDescription(state);
  item.contextValue = `command:${state.status}${state.hasTerminal ? ':terminal' : ''}`;
  item.command = { command: 'terminalCommands.open', title: 'Open', arguments: [node] };

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown('**').appendText(definition.name).appendMarkdown(`** — ${statusLabel(state)}\n\n`);
  tooltip.appendCodeblock(definition.command, 'shellscript');
  if (definition.cwd) tooltip.appendMarkdown('\n\nWorking directory: ').appendText(definition.cwd);
  if (definition.autoStart) tooltip.appendMarkdown('\n\nStarts automatically when the project opens.');
  item.tooltip = tooltip;
  return item;
}

function problemItem(node: Extract<TreeNode, { kind: 'problem' }>): vscode.TreeItem {
  const item = new vscode.TreeItem(node.message, vscode.TreeItemCollapsibleState.None);
  item.id = JSON.stringify([node.config.folder.uri.toString(), 'problem', node.index]);
  item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
  item.tooltip = node.message;
  item.contextValue = 'problem';
  item.command = { command: 'terminalCommands.openConfig', title: 'Open Config', arguments: [node.config.folder] };
  return item;
}

function statusIcon(state: CommandState): vscode.ThemeIcon {
  switch (state.status) {
    case 'running':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('testing.iconPassed'));
    case 'starting':
    case 'stopping':
      return new vscode.ThemeIcon('loading~spin');
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
    case 'stopped':
      return new vscode.ThemeIcon('circle-outline');
  }
}

function statusDescription(state: CommandState): string | undefined {
  switch (state.status) {
    case 'starting':
      return 'starting…';
    case 'stopping':
      return 'stopping…';
    case 'failed':
      return state.exitCode === undefined ? 'failed' : `exit ${state.exitCode}`;
    case 'stopped':
      return state.exitCode === undefined ? undefined : `exited ${state.exitCode}`;
    case 'running':
      return undefined;
  }
}

function statusLabel(state: CommandState): string {
  switch (state.status) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'failed':
      return state.exitCode === undefined ? 'failed' : `failed with exit code ${state.exitCode}`;
    case 'stopped':
      return state.exitCode === undefined ? 'stopped' : `exited with code ${state.exitCode}`;
  }
}
