import * as vscode from 'vscode';
import { targetsOf, type CommandTarget, type ConfigStore, type FolderConfig } from './configStore';
import { isActive, type CommandRunner, type CommandState } from './commandRunner';

export type TreeNode =
  | { readonly kind: 'folder'; readonly config: FolderConfig }
  | ({ readonly kind: 'command' } & CommandTarget)
  | { readonly kind: 'problem'; readonly config: FolderConfig; readonly message: string; readonly index: number };

export type CommandNode = Extract<TreeNode, { kind: 'command' }>;

export function isTreeNode(value: unknown): value is TreeNode {
  return typeof value === 'object' && value !== null && 'kind' in value && 'config' in value;
}

/** Lists each folder's commands with their live status. Folders get their own level only in multi-root workspaces. */
export class CommandTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(
    private readonly store: ConfigStore,
    private readonly runner: CommandRunner,
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node) return node.kind === 'folder' ? childrenOf(node.config) : [];
    const configs = this.store.folders.filter((config) => config.exists);
    if (configs.length === 1) return childrenOf(configs[0]);
    return configs.map((config) => ({ kind: 'folder', config }));
  }

  /** TreeView.reveal needs this. Folder nodes only exist in multi-root workspaces. */
  getParent(node: TreeNode): TreeNode | undefined {
    if (node.kind === 'folder' || this.store.folders.filter((config) => config.exists).length === 1) return undefined;
    return { kind: 'folder', config: node.config };
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'folder':
        return this.folderItem(node.config);
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

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

function childrenOf(config: FolderConfig): TreeNode[] {
  return [
    ...config.problems.map((message, index): TreeNode => ({ kind: 'problem', config, message, index })),
    ...targetsOf(config).map((target): TreeNode => ({ kind: 'command', ...target })),
  ];
}

function commandItem(node: CommandNode, state: CommandState): vscode.TreeItem {
  const { definition } = node;
  const item = new vscode.TreeItem(definition.name, vscode.TreeItemCollapsibleState.None);
  item.id = node.key;
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
  item.id = `${node.config.folder.uri.toString()}#problem-${node.index}`;
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
