/**
 * What the config editor's webview and the extension send each other. Both sides import this file, so it
 * must not import anything that only exists on one side.
 */

/** An environment variable's value, as written in the config. */
export type EnvValue = string | number | boolean;

/** A command entry as written, so that the form can show entries that aren't valid yet. */
export interface EditorCommand {
  /** The "name" as written, or empty if there is none. */
  readonly name: string;
  /** The name it goes by: its "name", or else its command line. Groups refer to it by this. */
  readonly label: string;
  readonly command: string;
  readonly cwd: string;
  readonly env: ReadonlyArray<readonly [string, EnvValue]>;
  readonly autoStart: boolean;
  /** False when the entry isn't an object, so the form can't edit it. */
  readonly editable: boolean;
  readonly problems: readonly string[];
}

export interface EditorGroup {
  readonly name: string;
  readonly commands: readonly string[];
  /** False when the entry isn't an object, so the form can't edit it. */
  readonly editable: boolean;
  readonly problems: readonly string[];
}

export interface EditorModel {
  /** The workspace folder the config belongs to. */
  readonly folderName: string;
  /** Why the form can't edit the config at all, e.g. a JSON syntax error. */
  readonly error?: string;
  /** Problems that aren't about one command or group. */
  readonly problems: readonly string[];
  readonly commands: readonly EditorCommand[];
  readonly groups: readonly EditorGroup[];
}

export interface NewCommand {
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly autoStart: boolean;
}

/**
 * A change made in the form. Entries are addressed by index, and `current` is the name the form shows
 * for the entry, so that a change made while the file was being edited elsewhere isn't applied to the
 * wrong entry. Renaming a command or removing it also updates the groups that list it.
 */
export type ConfigEdit =
  | { readonly kind: 'addCommand'; readonly command: NewCommand; readonly groups: readonly string[] }
  | {
      readonly kind: 'updateCommand';
      readonly index: number;
      readonly current: string;
      readonly field: 'name' | 'command' | 'cwd';
      readonly value: string;
    }
  | { readonly kind: 'setAutoStart'; readonly index: number; readonly current: string; readonly value: boolean }
  | {
      readonly kind: 'setEnv';
      readonly index: number;
      readonly current: string;
      readonly env: ReadonlyArray<readonly [string, EnvValue]>;
    }
  | { readonly kind: 'removeCommand'; readonly index: number; readonly current: string }
  | { readonly kind: 'moveCommand'; readonly index: number; readonly current: string; readonly to: number }
  | { readonly kind: 'addGroup'; readonly name: string; readonly commands: readonly string[] }
  | { readonly kind: 'renameGroup'; readonly index: number; readonly current: string; readonly name: string }
  | {
      readonly kind: 'setMember';
      readonly index: number;
      readonly current: string;
      readonly command: string;
      readonly member: boolean;
    }
  | { readonly kind: 'removeGroup'; readonly index: number; readonly current: string }
  | { readonly kind: 'moveGroup'; readonly index: number; readonly current: string; readonly to: number };

export type WebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'edit'; readonly edit: ConfigEdit }
  | { readonly type: 'openJson' };

export type ExtensionMessage =
  /** `ack` marks the reply to an edit from the form; other models come from changes made elsewhere. */
  | { readonly type: 'model'; readonly model: EditorModel; readonly ack: boolean }
  | { readonly type: 'focusCommand'; readonly name: string };
