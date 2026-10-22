import { getNodeValue, parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';

/** Location of the config file, relative to a workspace folder. */
export const CONFIG_PATH = '.vscode/terminal-commands.json';

export interface CommandDefinition {
  /** Unique label, also used as the terminal name. */
  readonly name: string;
  /** Command line, run by the user's default shell. */
  readonly command: string;
  /** Working directory as written in the config (relative to the workspace folder, or absolute). */
  readonly cwd?: string;
  /** Extra environment variables. */
  readonly env: Readonly<Record<string, string>>;
  readonly autoStart: boolean;
  /** Offset of the command's entry in the config text. */
  readonly offset: number;
}

/** A named set of commands, which can be started together and chosen to auto-start. */
export interface GroupDefinition {
  readonly name: string;
  /** Names of the group's commands, in the order listed. Names that match no command are left out. */
  readonly commands: readonly string[];
  /** Offset of the group's entry in the config text. */
  readonly offset: number;
}

export interface ParsedConfig {
  readonly commands: readonly CommandDefinition[];
  readonly groups: readonly GroupDefinition[];
  /** Human-readable reasons the config, or some of its entries, were rejected. */
  readonly problems: readonly string[];
}

const ROOT_PROPERTIES = new Set(['$schema', 'commands', 'groups']);
const COMMAND_PROPERTIES = new Set(['name', 'command', 'cwd', 'env', 'autoStart']);
const GROUP_PROPERTIES = new Set(['name', 'commands']);

/**
 * Parses the text of a config file (JSON with comments). Invalid entries are skipped and reported in
 * `problems` so that one bad entry doesn't take down the rest.
 */
export function parseConfig(text: string): ParsedConfig {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true, allowEmptyContent: true });

  if (errors.length > 0) {
    const [first] = errors;
    return {
      commands: [],
      groups: [],
      problems: [`Invalid JSON on line ${lineAt(source, first.offset)}: ${printParseErrorCode(first.error)}`],
    };
  }
  if (!root || root.type !== 'object') {
    return { commands: [], groups: [], problems: ['The config must be an object with a "commands" array.'] };
  }

  const problems: string[] = [];
  const rootProperties = propertiesOf(root);
  for (const key of rootProperties.keys()) {
    if (!ROOT_PROPERTIES.has(key)) problems.push(`Unknown property "${key}".`);
  }

  const commandsNode = rootProperties.get('commands');
  if (!commandsNode) return { commands: [], groups: [], problems: [...problems, 'Missing the "commands" array.'] };
  if (commandsNode.type !== 'array') {
    return { commands: [], groups: [], problems: [...problems, '"commands" must be an array.'] };
  }

  const commands: CommandDefinition[] = [];
  const names = new Set<string>();
  // Names of entries skipped for their own problems. Groups can list them without a second complaint.
  const rejected = new Set<string>();
  for (const [index, entry] of (commandsNode.children ?? []).entries()) {
    const result = parseCommand(entry);
    const label = result.name ? `commands[${index}] "${result.name}"` : `commands[${index}]`;
    problems.push(...result.problems.map((problem) => `${label}: ${problem}`));
    if (!result.command) {
      if (result.name) rejected.add(result.name);
      continue;
    }
    if (names.has(result.command.name)) {
      problems.push(`${label}: another command already has this name.`);
      continue;
    }
    names.add(result.command.name);
    commands.push(result.command);
  }

  const groupsNode = rootProperties.get('groups');
  if (!groupsNode) return { commands, groups: [], problems };
  if (groupsNode.type !== 'array') return { commands, groups: [], problems: [...problems, '"groups" must be an array.'] };
  const groups: GroupDefinition[] = [];
  const groupNames = new Set<string>();
  for (const [index, entry] of (groupsNode.children ?? []).entries()) {
    const result = parseGroup(entry, names, rejected);
    const label = result.name ? `groups[${index}] "${result.name}"` : `groups[${index}]`;
    problems.push(...result.problems.map((problem) => `${label}: ${problem}`));
    if (!result.group) continue;
    if (groupNames.has(result.group.name)) {
      problems.push(`${label}: another group already has this name.`);
      continue;
    }
    groupNames.add(result.group.name);
    groups.push(result.group);
  }
  return { commands, groups, problems };
}

interface CommandResult {
  /** Present when the entry is usable. */
  readonly command?: CommandDefinition;
  /** Best-effort name, for labelling problems. */
  readonly name?: string;
  readonly problems: readonly string[];
}

function parseCommand(entry: Node): CommandResult {
  if (entry.type !== 'object') return { problems: ['must be an object.'] };

  const properties = propertiesOf(entry);
  const value = (key: string): unknown => {
    const node = properties.get(key);
    return node ? getNodeValue(node) : undefined;
  };
  // Errors reject the entry: a command with a mistyped field might not do what its author intended.
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const key of properties.keys()) {
    if (!COMMAND_PROPERTIES.has(key)) warnings.push(`unknown property "${key}".`);
  }

  const optionalString = (key: string): string | undefined => {
    const raw = value(key);
    if (raw === undefined || typeof raw === 'string') return (raw as string | undefined)?.trim() || undefined;
    errors.push(`"${key}" must be a string.`);
    return undefined;
  };

  const command = value('command');
  if (typeof command !== 'string' || !command.trim()) errors.push('"command" must be a non-empty string.');
  const rawName = value('name');
  const name = typeof rawName === 'string' ? rawName.trim() || undefined : undefined;
  if (rawName !== undefined && name === undefined) errors.push('"name" must be a non-empty string.');
  const cwd = optionalString('cwd');
  const env = parseEnv(value('env'), errors);
  const autoStart = value('autoStart') ?? false;
  if (typeof autoStart !== 'boolean') errors.push('"autoStart" must be true or false.');

  if (errors.length > 0 || typeof command !== 'string') return { name, problems: [...errors, ...warnings] };
  return {
    name,
    problems: warnings,
    command: {
      name: name ?? command.trim(),
      command,
      cwd,
      env,
      autoStart: autoStart === true,
      offset: entry.offset,
    },
  };
}

interface GroupResult {
  /** Present when the entry is usable. */
  readonly group?: GroupDefinition;
  /** Best-effort name, for labelling problems. */
  readonly name?: string;
  readonly problems: readonly string[];
}

function parseGroup(entry: Node, commandNames: ReadonlySet<string>, rejected: ReadonlySet<string>): GroupResult {
  if (entry.type !== 'object') return { problems: ['must be an object.'] };

  const properties = propertiesOf(entry);
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const key of properties.keys()) {
    if (!GROUP_PROPERTIES.has(key)) warnings.push(`unknown property "${key}".`);
  }
  const nameNode = properties.get('name');
  const rawName: unknown = nameNode && getNodeValue(nameNode);
  const name = typeof rawName === 'string' ? rawName.trim() || undefined : undefined;
  if (name === undefined) errors.push('"name" must be a non-empty string.');
  const membersNode = properties.get('commands');
  const members: unknown = membersNode && getNodeValue(membersNode);
  const memberNames = Array.isArray(members) && members.every((member) => typeof member === 'string') ? members : undefined;
  if (!memberNames) errors.push('"commands" must be an array of command names.');
  if (errors.length > 0 || name === undefined || !memberNames) return { name, problems: [...errors, ...warnings] };

  // An unknown name leaves the rest of the group usable, like an invalid entry in "commands".
  const commands: string[] = [];
  for (const member of memberNames.map((memberName) => memberName.trim())) {
    if (commands.includes(member)) warnings.push(`"${member}" is listed more than once.`);
    else if (commandNames.has(member)) commands.push(member);
    else if (!rejected.has(member)) warnings.push(`there is no command named "${member}".`);
  }
  return { name, problems: warnings, group: { name, commands, offset: entry.offset } };
}

function parseEnv(raw: unknown, errors: string[]): Record<string, string> {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push('"env" must be an object.');
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') env[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
    else errors.push(`"env.${key}" must be a string, number or boolean.`);
  }
  return env;
}

/** Maps property names to value nodes. A repeated key keeps its last value, as JSON.parse does. */
function propertiesOf(node: Node): Map<string, Node> {
  const properties = new Map<string, Node>();
  for (const property of node.children ?? []) {
    const [key, value] = property.children ?? [];
    if (key?.type === 'string' && value) properties.set(key.value as string, value);
  }
  return properties;
}

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
