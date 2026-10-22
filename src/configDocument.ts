import { createScanner, getNodeValue, parseTree, type JSONPath, type Node, type ParseError } from 'jsonc-parser';
import { parseConfig } from './config';
import type { ConfigEdit, EditorCommand, EditorGroup, EditorModel, EnvValue, NewCommand } from './editorProtocol';

/** What the config editor shows: the config as written, including entries that aren't valid yet. */
export function readEditorModel(text: string, folderName: string): EditorModel {
  const { problems } = parseConfig(text);
  const { root, error } = parse(stripBom(text));
  if (error) return { folderName, error: problems[0] ?? error, problems: [], commands: [], groups: [] };
  if (root && root.type !== 'object') {
    return { folderName, error: problems[0], problems: [], commands: [], groups: [] };
  }

  // Problems start with the entry they're about, e.g. `commands[2] "web": ...`.
  const entryProblems = (kind: string, index: number) =>
    problems.filter((problem) => problem.startsWith(`${kind}[${index}]`)).map((problem) => problem.replace(/^\S+( "[^"]*")?: /, ''));
  const elements = (key: string) => {
    const node = nodeAt(root, [key]);
    return node?.type === 'array' ? (node.children ?? []) : [];
  };
  return {
    folderName,
    problems: problems.filter((problem) => !/^(commands|groups)\[\d+\]/.test(problem)),
    commands: elements('commands').map((node, index) => readCommand(node, entryProblems('commands', index))),
    groups: elements('groups').map((node, index) => readGroup(node, entryProblems('groups', index))),
  };
}

function readCommand(node: Node, problems: string[]): EditorCommand {
  const value: unknown = getNodeValue(node);
  if (!isRecord(value)) {
    return { name: '', label: '', command: '', cwd: '', env: [], autoStart: false, editable: false, problems };
  }
  const name = typeof value.name === 'string' ? value.name : '';
  const command = typeof value.command === 'string' ? value.command : '';
  const env = isRecord(value.env)
    ? Object.entries(value.env).filter((entry): entry is [string, EnvValue] => isEnvValue(entry[1]))
    : [];
  return {
    name,
    label: name.trim() || command.trim(),
    command,
    cwd: typeof value.cwd === 'string' ? value.cwd : '',
    env,
    autoStart: value.autoStart === true,
    editable: true,
    problems,
  };
}

function readGroup(node: Node, problems: string[]): EditorGroup {
  const value: unknown = getNodeValue(node);
  if (!isRecord(value)) return { name: '', commands: [], editable: false, problems };
  const members = Array.isArray(value.commands) ? value.commands : [];
  return {
    name: typeof value.name === 'string' ? value.name.trim() : '',
    commands: members.filter((member): member is string => typeof member === 'string').map((member) => member.trim()),
    editable: true,
    problems,
  };
}

/**
 * Applies a change from the config editor to the config's text. Everything else in the file stays as
 * written: comments, formatting, and entries the change isn't about. Returns undefined if the change
 * doesn't apply, e.g. because the entry it's about has changed meanwhile.
 */
export function applyConfigEdit(original: string, edit: ConfigEdit): string | undefined {
  const bom = original.charCodeAt(0) === 0xfeff ? original[0] : '';
  const { root, error } = parse(original.slice(bom.length));
  if (error || (root && root.type !== 'object')) return undefined;
  const document = new JsonDocument(original.slice(bom.length));
  return apply(document, edit) ? bom + document.text : undefined;
}

function apply(document: JsonDocument, edit: ConfigEdit): boolean {
  switch (edit.kind) {
    case 'addCommand': {
      const value = newCommandValue(edit.command);
      if (!value || labels(document).includes(value.name)) return false;
      const commands = document.array('commands');
      if (!commands) return false;
      document.insert(commands, document.length(commands), value);
      for (const group of edit.groups) {
        const index = groupNames(document).indexOf(group);
        if (index >= 0) setMember(document, index, value.name, true);
      }
      return true;
    }
    case 'updateCommand': {
      const path = commandPath(document, edit.index, edit.current);
      if (!path) return false;
      const value = edit.value.trim();
      if (edit.field === 'cwd') {
        if (value) document.set(path, 'cwd', edit.value);
        else document.delete(path, 'cwd');
        return true;
      }
      if (!value) return false;
      if (edit.field === 'command') {
        const entry: unknown = getNodeValue(document.node(path)!);
        // An entry without a name goes by its command line, so it can't take another command's name, and
        // its groups follow it.
        const named = isRecord(entry) && typeof entry.name === 'string' && entry.name.trim() !== '';
        if (!named && value !== edit.current && labels(document).includes(value)) return false;
        document.set(path, 'command', edit.value);
        if (!named) renameMembers(document, edit.current, value);
        return true;
      }
      if (value !== edit.current && labels(document).includes(value)) return false;
      document.set(path, 'name', value);
      renameMembers(document, edit.current, value);
      return true;
    }
    case 'setAutoStart': {
      const path = commandPath(document, edit.index, edit.current);
      if (path) document.set(path, 'autoStart', edit.value);
      return path !== undefined;
    }
    case 'setEnv': {
      const path = commandPath(document, edit.index, edit.current);
      const keys = edit.env.map(([key]) => key.trim());
      if (!path || keys.some((key) => !key) || new Set(keys).size !== keys.length) return false;
      setEnv(document, path, new Map(edit.env.map(([key, value]) => [key.trim(), value])));
      return true;
    }
    case 'removeCommand': {
      if (!isEntry(document, 'commands', edit.index, edit.current)) return false;
      document.remove(['commands'], edit.index);
      if (edit.current) renameMembers(document, edit.current, undefined);
      return true;
    }
    case 'moveCommand': {
      if (!isEntry(document, 'commands', edit.index, edit.current) || !inRange(edit.to, document.length(['commands']))) {
        return false;
      }
      document.move(['commands'], edit.index, edit.to);
      return true;
    }
    case 'addGroup': {
      const name = edit.name.trim();
      const known = labels(document);
      if (!name || groupNames(document).includes(name) || edit.commands.some((command) => !known.includes(command))) {
        return false;
      }
      const groups = document.array('groups');
      if (!groups) return false;
      document.insert(groups, document.length(groups), { name, commands: [...edit.commands] });
      return true;
    }
    case 'renameGroup': {
      const path = groupPath(document, edit.index, edit.current);
      const name = edit.name.trim();
      if (!path || !name || (name !== edit.current && groupNames(document).includes(name))) return false;
      document.set(path, 'name', name);
      return true;
    }
    case 'setMember': {
      // Removing a name that matches no command is how a typo gets fixed.
      if (!groupPath(document, edit.index, edit.current) || (edit.member && !labels(document).includes(edit.command))) {
        return false;
      }
      return setMember(document, edit.index, edit.command, edit.member);
    }
    case 'removeGroup': {
      if (!isEntry(document, 'groups', edit.index, edit.current)) return false;
      document.remove(['groups'], edit.index);
      return true;
    }
    case 'moveGroup': {
      if (!isEntry(document, 'groups', edit.index, edit.current) || !inRange(edit.to, document.length(['groups']))) {
        return false;
      }
      document.move(['groups'], edit.index, edit.to);
      return true;
    }
  }
}

function newCommandValue(command: NewCommand): Record<string, unknown> & { name: string } | undefined {
  const name = command.name.trim();
  if (!name || !command.command.trim()) return undefined;
  return {
    name,
    command: command.command,
    ...(command.cwd.trim() ? { cwd: command.cwd } : {}),
    ...(command.autoStart ? { autoStart: true } : {}),
  };
}

/**
 * Whether the entry at `index` is still the one the form calls `current`: the name of a command or group,
 * or '' for an entry without one, which can still be moved or removed.
 */
function isEntry(document: JsonDocument, key: 'commands' | 'groups', index: number, current: string): boolean {
  const node = document.node([key, index]);
  if (!node) return false;
  const value: unknown = getNodeValue(node);
  return (key === 'commands' ? labelOf(value) : groupNameOf(value)) === current;
}

/** The path of the command at `index`, if it's still the one called `current` and can be edited. */
function commandPath(document: JsonDocument, index: number, current: string): JSONPath | undefined {
  const editable = document.node(['commands', index])?.type === 'object';
  return editable && isEntry(document, 'commands', index, current) ? ['commands', index] : undefined;
}

/** The path of the group at `index`, if it's still the one called `current` and can be edited. */
function groupPath(document: JsonDocument, index: number, current: string): JSONPath | undefined {
  const editable = document.node(['groups', index])?.type === 'object';
  return editable && current && isEntry(document, 'groups', index, current) ? ['groups', index] : undefined;
}

function labels(document: JsonDocument): string[] {
  const commands = document.node(['commands']);
  return commands?.type === 'array' ? (commands.children ?? []).map((node) => labelOf(getNodeValue(node))) : [];
}

function groupNames(document: JsonDocument): string[] {
  const groups = document.node(['groups']);
  return groups?.type === 'array' ? (groups.children ?? []).map((node) => groupNameOf(getNodeValue(node))) : [];
}

function groupNameOf(value: unknown): string {
  return isRecord(value) && typeof value.name === 'string' ? value.name.trim() : '';
}

function labelOf(value: unknown): string {
  if (!isRecord(value)) return '';
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  return name || (typeof value.command === 'string' ? value.command.trim() : '');
}

function setMember(document: JsonDocument, index: number, command: string, member: boolean): boolean {
  const path = ['groups', index, 'commands'];
  const members = document.node(path);
  if (!members) {
    if (member) document.set(['groups', index], 'commands', [command]);
    return true;
  }
  if (members.type !== 'array') return false;
  const names = (members.children ?? []).map((node) => String(getNodeValue(node)).trim());
  if (member && !names.includes(command)) document.insert(path, names.length, command);
  if (!member) {
    for (let at = names.length - 1; at >= 0; at--) if (names[at] === command) document.remove(path, at);
  }
  return true;
}

/**
 * Changes a command's environment one variable at a time, so that the others keep their comments.
 * Variables with values the form doesn't show, which aren't valid, are left alone.
 */
function setEnv(document: JsonDocument, path: JSONPath, env: ReadonlyMap<string, EnvValue>): void {
  const envPath = [...path, 'env'];
  const node = document.node(envPath);
  if (node?.type !== 'object') {
    if (env.size > 0) document.set(path, 'env', Object.fromEntries(env));
    return;
  }
  const existing: Record<string, unknown> = getNodeValue(node);
  for (const [key, value] of Object.entries(existing)) {
    if (isEnvValue(value) && !env.has(key)) document.delete(envPath, key);
  }
  for (const [key, value] of env) {
    if (!Object.hasOwn(existing, key) || existing[key] !== value) document.set(envPath, key, value, false);
  }
  if (document.length(envPath) === 0) document.delete(path, 'env');
}

/** Points the groups that list a command at its new name, or drops it from them if `to` is undefined. */
function renameMembers(document: JsonDocument, from: string, to: string | undefined): void {
  const groups = document.length(['groups']);
  for (let index = 0; index < groups; index++) {
    const path = ['groups', index, 'commands'];
    const members = document.node(path);
    if (members?.type !== 'array') continue;
    // Last first, so that removing a member doesn't move the ones still to check.
    for (let at = (members.children?.length ?? 0) - 1; at >= 0; at--) {
      const member = document.node([...path, at]);
      if (!member || String(getNodeValue(member)).trim() !== from) continue;
      if (to === undefined) document.remove(path, at);
      else document.replace([...path, at], to);
    }
  }
}

function inRange(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnvValue(value: unknown): value is EnvValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function parse(text: string): { root?: Node; error?: string } {
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  return errors.length > 0 ? { error: 'The config is not valid JSON.' } : { root };
}

/** The value at a path. A key that appears twice means its last value, as it does to JSON.parse. */
function nodeAt(root: Node | undefined, path: JSONPath): Node | undefined {
  let node = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      node = node?.type === 'array' ? node.children?.[segment] : undefined;
    } else {
      const properties = node?.type === 'object' ? (node.children ?? []) : [];
      node = properties.filter((property) => property.children?.[0]?.value === segment).at(-1)?.children?.[1];
    }
  }
  return node;
}

// jsonc-parser's SyntaxKind is a const enum, which isolated modules can't use.
const COMMA = 5;
const LINE_COMMENT = 12;
const BLOCK_COMMENT = 13;
const LINE_BREAK = 14;
const EOF = 17;

/** Where new properties go, so that a command reads name, command, cwd, env, autoStart. */
const PROPERTY_ORDER = ['$schema', 'name', 'command', 'cwd', 'env', 'autoStart', 'commands', 'groups'];

/** An element or property of an object or array, with the comments that go with it. */
interface Item {
  /** The lines above it: comments, and '' for a blank line. */
  readonly before: readonly string[];
  readonly text: string;
  /** A comment after it on the same line. */
  readonly after: string;
}

interface Layout {
  multiline: boolean;
  /** Indentation of the items, when they're on lines of their own. */
  indent: string;
  /** Indentation of the closing bracket, and of the line the container starts on. */
  readonly closingIndent: string;
  /** Whether there are spaces inside the brackets of a container on one line, as in `{ "a": 1 }`. */
  readonly padded: boolean;
  readonly trailingComma: boolean;
  /** A comment after the opening bracket, on its line. */
  readonly opening: string;
  /** The lines after the last item: comments, and '' for a blank line. */
  readonly closing: readonly string[];
}

/**
 * JSON text that changes in place. To change an object or array, it prints the container again from its
 * items, each in its original text with its comments, so that only what changes looks different.
 */
class JsonDocument {
  private readonly unit: string;
  private readonly eol: string;

  constructor(public text: string) {
    // Indented like the top level's first property, if it's on a line of its own.
    const first = parse(text).root?.children?.[0];
    const indent = first ? indentAt(text, first.offset) : '';
    this.unit = indent.startsWith('\t') ? '\t' : indent || '  ';
    this.eol = text.includes('\r\n') ? '\r\n' : '\n';
  }

  node(path: JSONPath): Node | undefined {
    return nodeAt(parse(this.text).root, path);
  }

  length(path: JSONPath): number {
    return this.node(path)?.children?.length ?? 0;
  }

  /** The path of a top-level array, which is added if it's missing. Undefined if it isn't an array. */
  array(key: 'commands' | 'groups'): JSONPath | undefined {
    // A file with nothing but comments keeps them.
    if (!this.node([])) this.text = `${this.text.trimEnd() ? this.text.trimEnd() + this.eol : ''}{}${this.eol}`;
    const node = this.node([key]);
    if (!node) this.set([], key, []);
    return node && node.type !== 'array' ? undefined : [key];
  }

  /** Replaces a value. A value on one line stays on one line. */
  replace(path: JSONPath, value: unknown): void {
    const node = this.node(path);
    if (!node) return;
    const multiline = this.text.slice(node.offset, node.offset + node.length).includes('\n');
    this.splice(node.offset, node.length, this.serialize(value, multiline, indentAt(this.text, node.offset)));
  }

  /** Sets an object's property. A new property goes where it belongs in PROPERTY_ORDER, or else last. */
  set(objectPath: JSONPath, key: string, value: unknown, ordered = true): void {
    const object = this.node(objectPath);
    if (object?.type !== 'object') return;
    if (propertyIndexes(object, key).length > 0) {
      this.replace([...objectPath, key], value);
      return;
    }
    this.rewrite(object, (items, layout) => {
      // The top level always has a line per property.
      if (objectPath.length === 0) layout.multiline = true;
      const text = `${JSON.stringify(key)}: ${this.serialize(value, layout.multiline, layout.indent)}`;
      items.splice(ordered ? insertionIndex(object, key) : items.length, 0, { before: [], text, after: '' });
    });
  }

  delete(objectPath: JSONPath, key: string): void {
    const object = this.node(objectPath);
    if (object?.type !== 'object') return;
    const indexes = propertyIndexes(object, key);
    if (indexes.length > 0) this.rewrite(object, (items) => indexes.reverse().forEach((index) => items.splice(index, 1)));
  }

  insert(arrayPath: JSONPath, index: number, value: unknown): void {
    const array = this.node(arrayPath);
    if (array?.type !== 'array') return;
    this.rewrite(array, (items, layout) => {
      // A list of objects gets a line per object.
      if (isRecord(value)) layout.multiline = true;
      const expanded = items.some((item) => item.text.includes('\n'));
      items.splice(index, 0, { before: [], text: this.serialize(value, expanded, layout.indent), after: '' });
    });
  }

  remove(arrayPath: JSONPath, index: number): void {
    const array = this.node(arrayPath);
    if (array?.type === 'array') this.rewrite(array, (items) => items.splice(index, 1));
  }

  move(arrayPath: JSONPath, from: number, to: number): void {
    const array = this.node(arrayPath);
    if (array?.type !== 'array') return;
    this.rewrite(array, (items) => items.splice(to, 0, ...items.splice(from, 1)));
  }

  private rewrite(container: Node, change: (items: Item[], layout: Layout) => void): void {
    const { items, layout } = readContainer(this.text, container, this.unit);
    change(items, layout);
    const open = container.type === 'array' ? '[' : '{';
    this.splice(container.offset, container.length, printContainer(open, items, layout, this.eol));
  }

  /**
   * JSON text for a new value: on one line, like `{ "name": "web", "command": "pnpm dev" }`, or, where
   * the values around it are spread over several lines, the same way.
   */
  private serialize(value: unknown, expanded: boolean, indent: string): string {
    if (expanded && typeof value === 'object' && value !== null) {
      return JSON.stringify(value, null, this.unit).replace(/\n/g, this.eol + indent);
    }
    return compact(value);
  }

  private splice(offset: number, length: number, text: string): void {
    this.text = this.text.slice(0, offset) + text + this.text.slice(offset + length);
  }
}

function compact(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(compact).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${compact(entry)}`);
    return entries.length > 0 ? `{ ${entries.join(', ')} }` : '{}';
  }
  return JSON.stringify(value);
}

function propertyIndexes(object: Node, key: string): number[] {
  return (object.children ?? []).flatMap((property, index) => (property.children?.[0]?.value === key ? [index] : []));
}

function insertionIndex(object: Node, key: string): number {
  const rank = (name: unknown) => {
    const index = PROPERTY_ORDER.indexOf(String(name));
    return index < 0 ? PROPERTY_ORDER.length : index;
  };
  const properties = object.children ?? [];
  const index = properties.findIndex((property) => rank(property.children?.[0]?.value) > rank(key));
  return index < 0 ? properties.length : index;
}

/** The whitespace at the start of the line that `offset` is on. */
function indentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))?.[0] ?? '';
}

function readContainer(text: string, container: Node, unit: string): { items: Item[]; layout: Layout } {
  const open = container.offset;
  const close = container.offset + container.length - 1;
  const children = container.children ?? [];
  const starts = [open + 1, ...children.map((child) => child.offset + child.length)];
  const gaps = starts.map((start, index) => scanGap(text.slice(start, children[index]?.offset ?? close)));
  const multiline = text.slice(open, close).includes('\n');
  const closingIndent = indentAt(text, open);
  return {
    items: children.map((child, index) => ({
      before: gaps[index].lines,
      text: text.slice(child.offset, child.offset + child.length),
      after: gaps[index + 1].sameLine,
    })),
    layout: {
      multiline,
      indent: multiline && children.length > 0 ? indentAt(text, children[0].offset) : closingIndent + unit,
      closingIndent,
      padded: text[open + 1] === ' ',
      trailingComma: children.length > 0 && gaps[children.length].comma,
      opening: gaps[0].sameLine,
      closing: gaps[children.length].lines,
    },
  };
}

interface Gap {
  readonly comma: boolean;
  /** Comments before the first line break: they belong to the item before. */
  readonly sameLine: string;
  /** The lines after it: comments, which belong to the item after, and '' for blank lines. */
  readonly lines: string[];
}

/** Reads the whitespace, commas and comments between two items. */
function scanGap(gap: string): Gap {
  const scanner = createScanner(gap, false);
  let comma = false;
  const sameLine: string[] = [];
  const lines: string[] = [];
  let lineBreaks = 0;
  let lineIsEmpty = false;
  for (let kind = scanner.scan(); kind !== EOF; kind = scanner.scan()) {
    if (kind === COMMA) {
      comma = true;
    } else if (kind === LINE_BREAK) {
      if (lineBreaks > 0 && lineIsEmpty) lines.push('');
      lineBreaks++;
      lineIsEmpty = true;
    } else if (kind === LINE_COMMENT || kind === BLOCK_COMMENT) {
      const comment = gap.slice(scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
      (lineBreaks === 0 ? sameLine : lines).push(comment);
      lineIsEmpty = false;
    }
  }
  return { comma, sameLine: sameLine.join(' '), lines };
}

function printContainer(open: '[' | '{', items: readonly Item[], layout: Layout, eol: string): string {
  const close = open === '[' ? ']' : '}';
  if (!layout.multiline) {
    const inner = items.map((item) => (item.after ? `${item.text} ${item.after}` : item.text)).join(', ');
    const content = [layout.opening, inner + (inner && layout.trailingComma ? ',' : '')].filter(Boolean).join(' ');
    if (!content) return open + close;
    return layout.padded || layout.opening ? `${open} ${content} ${close}` : `${open}${content}${close}`;
  }
  const indented = (line: string) => (line ? layout.indent + line : '');
  const lines = [layout.opening ? `${open} ${layout.opening}` : open];
  items.forEach((item, index) => {
    const comma = index < items.length - 1 || layout.trailingComma ? ',' : '';
    lines.push(...item.before.map(indented), layout.indent + item.text + comma + (item.after ? ` ${item.after}` : ''));
  });
  lines.push(...layout.closing.map(indented), layout.closingIndent + close);
  return lines.join(eol);
}
