import * as vscode from 'vscode';
import { CONFIG_PATH, parseConfig, type CommandDefinition } from './config';

/** The config of one workspace folder. */
export interface FolderConfig {
  readonly folder: vscode.WorkspaceFolder;
  readonly configUri: vscode.Uri;
  /** Whether the folder has a config file at all. */
  readonly exists: boolean;
  readonly commands: readonly CommandDefinition[];
  readonly problems: readonly string[];
}

/** A configured command, addressable across config reloads by `key`. */
export interface CommandTarget {
  readonly key: string;
  readonly config: FolderConfig;
  readonly definition: CommandDefinition;
}

export function configUriFor(folder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(folder.uri, ...CONFIG_PATH.split('/'));
}

export function commandKey(folderUri: vscode.Uri, name: string): string {
  return `${folderUri.toString()}#${name}`;
}

export function targetsOf(config: FolderConfig): CommandTarget[] {
  return config.commands.map((definition) => ({
    key: commandKey(config.folder.uri, definition.name),
    config,
    definition,
  }));
}

/** Loads the config of every workspace folder and keeps it in sync with the files on disk. */
export class ConfigStore implements vscode.Disposable {
  private readonly configs = new Map<string, FolderConfig>();
  /** Latest load per folder, so a slow read can't overwrite a newer one. */
  private readonly loads = new Map<string, number>();
  private readonly opened = new Set<string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly openEmitter = new vscode.EventEmitter<FolderConfig>();
  private readonly disposables: vscode.Disposable[];

  /** Fires when any folder's config changes. */
  readonly onDidChange = this.changeEmitter.event;
  /** Fires once per folder, when its config is first loaded in this window: the project "opening". */
  readonly onDidOpenFolder = this.openEmitter.event;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_PATH}`);
    const reload = (uri: vscode.Uri) => {
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      if (folder && configUriFor(folder).toString() === uri.toString()) void this.load(folder);
    };
    this.disposables = [
      this.changeEmitter,
      this.openEmitter,
      watcher,
      watcher.onDidCreate(reload),
      watcher.onDidChange(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeWorkspaceFolders((event) => {
        for (const folder of event.removed) {
          const key = folder.uri.toString();
          this.configs.delete(key);
          this.loads.delete(key);
          this.opened.delete(key);
        }
        if (event.removed.length > 0) this.changeEmitter.fire();
        for (const folder of event.added) void this.load(folder);
      }),
    ];
  }

  /** Configs in workspace folder order. */
  get folders(): FolderConfig[] {
    return (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => this.configs.get(folder.uri.toString()) ?? []);
  }

  targets(): CommandTarget[] {
    return this.folders.flatMap(targetsOf);
  }

  async initialize(): Promise<void> {
    await Promise.all((vscode.workspace.workspaceFolders ?? []).map((folder) => this.load(folder)));
  }

  private async load(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    const load = (this.loads.get(key) ?? 0) + 1;
    this.loads.set(key, load);
    const config = await readFolderConfig(folder);
    if (this.loads.get(key) !== load) return;

    this.configs.set(key, config);
    const firstLoad = !this.opened.has(key);
    this.opened.add(key);
    this.changeEmitter.fire();
    if (firstLoad) this.openEmitter.fire(config);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}

async function readFolderConfig(folder: vscode.WorkspaceFolder): Promise<FolderConfig> {
  const configUri = configUriFor(folder);
  try {
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(configUri));
    return { folder, configUri, exists: true, ...parseConfig(text) };
  } catch (error) {
    const exists = await vscode.workspace.fs.stat(configUri).then(
      () => true,
      () => false,
    );
    const problems = exists ? [`Couldn't read ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`] : [];
    return { folder, configUri, exists, commands: [], problems };
  }
}
