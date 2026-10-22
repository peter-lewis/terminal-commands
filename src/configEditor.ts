import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { applyConfigEdit, readEditorModel } from './configDocument';
import type { ConfigEdit, ExtensionMessage, WebviewMessage } from './editorProtocol';

export const CONFIG_EDITOR_VIEW_TYPE = 'terminalCommands.configEditor';

/**
 * Edits a config through a form. Changes made in the form go into the config's text document, keeping
 * the rest of the file as written, and are saved straight away, as in the Settings editor, so that the
 * sidebar shows them at once.
 */
export class ConfigEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Map<string, { panel: vscode.WebviewPanel; post: (message: ExtensionMessage) => void }>();
  /** Commands to show once their editor's webview has loaded. */
  private readonly pendingFocus = new Map<string, string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly log: vscode.LogOutputChannel,
    /** Called when a group is renamed in the form, so that choices tied to its name can follow. */
    private readonly onDidRenameGroup: (configUri: vscode.Uri, from: string, to: string) => void,
  ) {}

  /**
   * Opens a config in the form, optionally showing one of its commands. If the active editor shows the
   * config as JSON, the form takes its place.
   */
  async open(configUri: vscode.Uri, command?: string): Promise<void> {
    const open = this.panels.get(configUri.toString());
    if (command !== undefined) {
      // A form in a background tab has no page to tell. It asks once it's shown again.
      if (open?.panel.visible) open.post({ type: 'focusCommand', name: command });
      else this.pendingFocus.set(configUri.toString(), command);
    }
    if (open) {
      open.panel.reveal();
      return;
    }
    const isJson = (tab: vscode.Tab | undefined) =>
      tab?.input instanceof vscode.TabInputText && tab.input.uri.toString() === configUri.toString();
    const group = vscode.window.tabGroups.activeTabGroup;
    const replacing = isJson(group.activeTab);
    await vscode.commands.executeCommand('vscode.openWith', configUri, CONFIG_EDITOR_VIEW_TYPE);
    if (!replacing) return;
    // Opening the form changes the tabs, so the JSON's tab is looked up again. Some editors, like Cursor,
    // close it by themselves.
    const json = vscode.window.tabGroups.all
      .find((candidate) => candidate.viewColumn === group.viewColumn)
      ?.tabs.find((tab) => isJson(tab));
    if (json) await vscode.window.tabGroups.close(json, true).then(undefined, (error: unknown) => this.log.debug(`Couldn't close the JSON: ${String(error)}`));
  }

  /** Opens a config as JSON. If the active editor shows the config in the form, the JSON takes its place. */
  async openJson(configUri: vscode.Uri): Promise<void> {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const inForm =
      input instanceof vscode.TabInputCustom &&
      input.viewType === CONFIG_EDITOR_VIEW_TYPE &&
      input.uri.toString() === configUri.toString();
    if (inForm) await vscode.commands.executeCommand('workbench.action.reopenTextEditor');
    else await vscode.commands.executeCommand('vscode.openWith', configUri, 'default');
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const key = document.uri.toString();
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    const folderName = folder?.name ?? path.basename(path.dirname(path.dirname(document.uri.fsPath)));
    const post = (message: ExtensionMessage) => void panel.webview.postMessage(message);
    const sendModel = (ack: boolean) => post({ type: 'model', model: readEditorModel(document.getText(), folderName), ack });
    this.panels.set(key, { panel, post });

    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    panel.webview.html = this.html(panel.webview);

    // The form's edits are applied one at a time, in order. While one is being applied, the document
    // changes it causes aren't reported back: the form gets the result as the edit's reply.
    let queue = Promise.resolve();
    let applying = false;
    const applyEdit = async (edit: ConfigEdit) => {
      // A removal is confirmed first, unless it wouldn't apply anyway.
      const removal = edit.kind === 'removeCommand' || edit.kind === 'removeGroup';
      if (removal && applyConfigEdit(document.getText(), edit) !== undefined && !(await confirmRemoval(edit))) {
        sendModel(true);
        return;
      }
      const text = document.getText();
      const result = applyConfigEdit(text, edit);
      if (result !== undefined && result !== text) {
        applying = true;
        try {
          const [start, end] = changedSpan(text, result);
          const range = new vscode.Range(document.positionAt(start), document.positionAt(text.length - end));
          const workspaceEdit = new vscode.WorkspaceEdit();
          workspaceEdit.replace(document.uri, range, result.slice(start, result.length - end));
          if (await vscode.workspace.applyEdit(workspaceEdit)) {
            await document.save();
            if (edit.kind === 'renameGroup') this.onDidRenameGroup(document.uri, edit.current, edit.name.trim());
          }
        } finally {
          applying = false;
        }
      } else if (result === undefined) {
        this.log.debug(`Config editor: skipped an edit that no longer applies: ${edit.kind}`);
      }
      sendModel(true);
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === document && event.contentChanges.length > 0 && !applying) sendModel(false);
      }),
      panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        switch (message.type) {
          case 'ready': {
            sendModel(false);
            const command = this.pendingFocus.get(key);
            this.pendingFocus.delete(key);
            if (command !== undefined) post({ type: 'focusCommand', name: command });
            break;
          }
          case 'edit':
            queue = queue.then(() => applyEdit(message.edit)).catch((error: unknown) => {
              this.log.error(`Config editor: couldn't apply an edit: ${String(error)}`);
              void vscode.window.showErrorMessage(`Couldn't change the config: ${String(error)}`);
              sendModel(true);
            });
            break;
          case 'openJson':
            void this.openJson(document.uri);
            break;
        }
      }),
    ];
    panel.onDidDispose(() => {
      if (this.panels.get(key)?.panel === panel) this.panels.delete(key);
      for (const subscription of subscriptions) subscription.dispose();
    });
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', file));
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('webview.css').toString()}">
  <title>Terminal Commands</title>
</head>
<body>
  <main id="app"></main>
  <script nonce="${nonce}" src="${asset('webview.js').toString()}"></script>
</body>
</html>`;
  }
}

async function confirmRemoval(edit: Extract<ConfigEdit, { kind: 'removeCommand' | 'removeGroup' }>): Promise<boolean> {
  const kind = edit.kind === 'removeCommand' ? 'command' : 'group';
  // An entry without a name isn't in any group.
  const detail =
    kind === 'group' ? "The commands in it aren't deleted." : edit.current ? "It's also taken out of any groups it's in." : undefined;
  const message = edit.current ? `Delete the ${kind} "${edit.current}"?` : `Delete this ${kind}?`;
  return (await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Delete')) === 'Delete';
}

/**
 * The lengths of the common prefix and suffix of two texts, which don't overlap. Replacing only what's
 * between them leaves the rest of the document, and the cursors of other editors on it, alone.
 */
function changedSpan(before: string, after: string): [number, number] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before.at(-1 - end) === after.at(-1 - end)) end++;
  return [start, end];
}
