import type {
  ConfigEdit,
  EditorCommand,
  EditorGroup,
  EditorModel,
  EnvValue,
  ExtensionMessage,
  WebviewMessage,
} from '../editorProtocol';
import './style.css';

interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface CommandDraft {
  name: string;
  command: string;
  cwd: string;
  autoStart: boolean;
  groups: string[];
}

interface GroupDraft {
  name: string;
  commands: string[];
}

/** What the form keeps while its tab is in the background: open cards, and entries being added. */
interface UiState {
  /** Keys of the expanded cards, e.g. "command:2". */
  expanded: string[];
  commandDraft?: CommandDraft;
  groupDraft?: GroupDraft;
}

/** How long a change typed into a field waits for the next keystroke before it's saved. */
const TYPING_DELAY_MS = 400;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const ui: UiState = { expanded: [], ...(vscode.getState() as Partial<UiState> | undefined) };
/** The config as the form shows it: what the extension sent last, plus the edits sent since. */
let model: EditorModel | undefined;
/** The model the page was last rendered from. Inputs and cards are numbered by their place in it. */
let rendered: EditorModel | undefined;
/** Edits sent and not answered yet. Answers that arrive while others are on their way are out of date. */
let unanswered = 0;
/** Validation messages, by input key. */
const errors = new Map<string, string>();
/**
 * Edits waiting to be sent, by input key: until the user pauses typing, or, for names, until they leave
 * the field. A name is the command's identity, so it isn't saved halfway through being typed.
 */
const pending = new Map<string, { timer?: number; send: () => void }>();
/** What to focus after the next render, instead of what had focus before it. */
let nextFocus: string | undefined;
/** Set while the page is rebuilt, which takes focus away from inputs without the user leaving them. */
let rendering = false;
/**
 * A render waits while a pointer is down, so that the click lands on the element it started on, and while
 * text is being composed (e.g. with an IME), which replacing the input would break.
 */
const held = { pointer: false, composition: false };
let renderWaiting = false;

window.addEventListener('message', (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  if (message.type === 'focusCommand') {
    showCommand(message.name);
    return;
  }
  if (message.ack) unanswered = Math.max(0, unanswered - 1);
  if (unanswered > 0) return;
  followCards(message.model);
  model = message.model;
  requestRender();
});

window.addEventListener('pointerdown', () => (held.pointer = true), true);
for (const type of ['pointerup', 'pointercancel']) {
  window.addEventListener(
    type,
    () => {
      held.pointer = false;
      // The click comes after pointerup.
      setTimeout(resumeRender);
    },
    true,
  );
}
// Leaving the form, for another editor or the sidebar, saves what's been typed.
window.addEventListener('blur', () => {
  held.pointer = false;
  flushAll();
  resumeRender();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushAll();
});

app.addEventListener('compositionstart', () => (held.composition = true));
app.addEventListener('compositionend', (event) => {
  held.composition = false;
  if (event.target instanceof HTMLInputElement) onTextInput(event.target);
  resumeRender();
});

app.addEventListener('click', (event) => {
  const target = (event.target as Element).closest<HTMLElement>('[data-action]');
  if (!target || target.hasAttribute('disabled')) return;
  flushAll();
  act(target.dataset.action!, target);
});

app.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (target.dataset.action === 'toggle' && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault();
    act('toggle', target);
  } else if (target instanceof HTMLInputElement && target.dataset.scope?.startsWith('draft-')) {
    const draft = target.dataset.scope === 'draft-command' ? 'command' : 'group';
    if (event.key === 'Enter' && target.type === 'text') act(`add-${draft}`, target);
    if (event.key === 'Escape') act(`cancel-${draft}`, target);
  } else if (target instanceof HTMLInputElement && target.type === 'text' && target.dataset.key) {
    if (event.key === 'Enter') flush(target.dataset.key);
    // Escape takes back what hasn't been saved.
    if (event.key === 'Escape') discard(target);
  }
});

app.addEventListener('input', (event) => {
  const composing = (event as InputEvent).isComposing;
  if (event.target instanceof HTMLInputElement && event.target.type === 'text' && !composing) onTextInput(event.target);
});

app.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') onCheckbox(event.target);
});

// Leaving a field saves its change. A value that isn't valid goes back to the saved one.
app.addEventListener('focusout', (event) => {
  const input = event.target;
  if (rendering || !(input instanceof HTMLInputElement) || input.type !== 'text' || !input.dataset.key) return;
  flush(input.dataset.key);
  if (input.dataset.scope?.startsWith('draft-')) return;
  if (input.dataset.field === 'env') {
    // Within the environment, a row can be mid-change while another is edited.
    const rows = input.closest('.env');
    if (!rows?.contains(event.relatedTarget as Node | null) && hasErrors(`${envKey(input)}:`)) discard(input);
  } else if (errors.has(input.dataset.key)) {
    discard(input);
  }
});

vscode.postMessage({ type: 'ready' });

function send(edit: ConfigEdit): void {
  unanswered++;
  vscode.postMessage({ type: 'edit', edit });
}

function act(action: string, target: HTMLElement): void {
  if (!model) return;
  const index = Number(target.dataset.index);
  switch (action) {
    case 'toggle': {
      const card = target.dataset.card!;
      ui.expanded = ui.expanded.includes(card) ? ui.expanded.filter((key) => key !== card) : [...ui.expanded, card];
      break;
    }
    case 'open-json':
      vscode.postMessage({ type: 'openJson' });
      return;
    case 'new-command':
      ui.commandDraft = { name: '', command: '', cwd: '', autoStart: false, groups: [] };
      nextFocus = 'draft-command:name';
      break;
    case 'cancel-command':
      ui.commandDraft = undefined;
      clearErrors('draft-command:');
      nextFocus = 'new-command';
      break;
    case 'add-command':
      if (!addCommand()) return;
      break;
    case 'new-group':
      ui.groupDraft = { name: '', commands: [] };
      nextFocus = 'draft-group:name';
      break;
    case 'cancel-group':
      ui.groupDraft = undefined;
      clearErrors('draft-group:');
      nextFocus = 'new-group';
      break;
    case 'add-group':
      if (!addGroup()) return;
      break;
    case 'move-up':
    case 'move-down':
      move(target.dataset.kind as 'command' | 'group', index, action === 'move-up' ? index - 1 : index + 1, action);
      break;
    case 'remove': {
      // The extension asks the user to confirm, so the card stays until it answers.
      const current = target.dataset.kind === 'command' ? model.commands[index].label : model.groups[index].name;
      send(target.dataset.kind === 'command' ? { kind: 'removeCommand', index, current } : { kind: 'removeGroup', index, current });
      return;
    }
    case 'remove-env': {
      // Read from the rows on screen, which may hold changes the model doesn't have yet.
      const command = model.commands[index];
      const rows = target.closest('.env');
      const { env, valid } = rows ? readEnv(rows, Number(target.dataset.row)) : { env: [], valid: false };
      if (!command || !valid) return;
      cancel(`command:${index}:env`);
      send({ kind: 'setEnv', index, current: command.label, env });
      patchCommand(index, { env });
      nextFocus = `command:${index}:env:${env.length}:key`;
      break;
    }
  }
  render();
}

function addCommand(): boolean {
  const draft = ui.commandDraft;
  if (!model || !draft) return false;
  const name = draft.name.trim();
  setError('draft-command:name', nameError(name, model.commands.map((command) => command.label), 'command'));
  setError('draft-command:command', draft.command.trim() ? undefined : 'Enter the command line to run.');
  if (errors.has('draft-command:name') || errors.has('draft-command:command')) {
    nextFocus = errors.has('draft-command:name') ? 'draft-command:name' : 'draft-command:command';
    render();
    return false;
  }
  send({ kind: 'addCommand', command: { ...draft, name }, groups: draft.groups });
  model = {
    ...model,
    commands: [
      ...model.commands,
      { name, label: name, command: draft.command, cwd: draft.cwd, env: [], autoStart: draft.autoStart, editable: true, problems: [] },
    ],
    groups: model.groups.map((group) => (draft.groups.includes(group.name) ? { ...group, commands: [...group.commands, name] } : group)),
  };
  ui.commandDraft = undefined;
  nextFocus = `command:${model.commands.length - 1}:header`;
  return true;
}

function addGroup(): boolean {
  const draft = ui.groupDraft;
  if (!model || !draft) return false;
  const name = draft.name.trim();
  setError('draft-group:name', nameError(name, model.groups.map((group) => group.name), 'group'));
  if (errors.has('draft-group:name')) {
    nextFocus = 'draft-group:name';
    render();
    return false;
  }
  // In the order of the commands, which is how they're listed in the form.
  const commands = model.commands.map((command) => command.label).filter((label) => draft.commands.includes(label));
  send({ kind: 'addGroup', name, commands });
  model = { ...model, groups: [...model.groups, { name, commands, editable: true, problems: [] }] };
  ui.groupDraft = undefined;
  nextFocus = `group:${model.groups.length - 1}:header`;
  return true;
}

function move(kind: 'command' | 'group', from: number, to: number, button: string): void {
  if (!model) return;
  if (kind === 'command') {
    send({ kind: 'moveCommand', index: from, current: model.commands[from].label, to });
    model = { ...model, commands: moved(model.commands, from, to) };
  } else {
    send({ kind: 'moveGroup', index: from, current: model.groups[from].name, to });
    model = { ...model, groups: moved(model.groups, from, to) };
  }
  ui.expanded = ui.expanded.map((card) => (card === `${kind}:${from}` ? `${kind}:${to}` : card === `${kind}:${to}` ? `${kind}:${from}` : card));
  const count = kind === 'command' ? model.commands.length : model.groups.length;
  // Keep focus on the button that moved the card, unless it can't move further that way.
  const blocked = (button === 'move-up' && to === 0) || (button === 'move-down' && to === count - 1);
  nextFocus = `${kind}:${to}:${blocked ? 'header' : button}`;
}

function onTextInput(input: HTMLInputElement): void {
  if (!model) return;
  const { key, scope, field } = input.dataset as Record<string, string>;
  const index = Number(input.dataset.index);
  const value = input.value;
  if (scope === 'draft-command' && ui.commandDraft) {
    ui.commandDraft[field as 'name' | 'command' | 'cwd'] = value;
    clearError(input);
  } else if (scope === 'draft-group' && ui.groupDraft) {
    ui.groupDraft.name = value;
    clearError(input);
  } else if (scope === 'command' && field === 'env') {
    onEnvInput(input, index);
  } else if (scope === 'command' && model.commands[index]) {
    // The edit is for the command the user is looking at, wherever it is when the edit is sent.
    const command = model.commands[index];
    const current = command.label;
    // A command without a name goes by its command line.
    const named = command.name.trim() !== '';
    const error =
      field === 'name'
        ? nameError(value.trim(), otherLabels(index), 'command')
        : field !== 'command'
          ? undefined
          : !value.trim()
            ? 'Enter the command line to run.'
            : !named && otherLabels(index).includes(value.trim())
              ? 'Another command has this name. Give this one a name first.'
              : undefined;
    showError(input, error);
    const identity = field === 'name' || (field === 'command' && !named);
    if (error) cancel(key);
    else schedule(key, () => updateCommand(current, field as 'name' | 'command' | 'cwd', value), identity ? undefined : TYPING_DELAY_MS);
  } else if (scope === 'group' && model.groups[index]) {
    const current = model.groups[index].name;
    const error = nameError(value.trim(), model.groups.filter((_, at) => at !== index).map((group) => group.name), 'group');
    showError(input, error);
    if (error) cancel(key);
    else schedule(key, () => renameGroup(current, value.trim()));
  }
  vscode.setState(ui);
}

function updateCommand(current: string, field: 'name' | 'command' | 'cwd', value: string): void {
  const index = model?.commands.findIndex((command) => command.label === current) ?? -1;
  const command = model?.commands[index];
  if (!command) return;
  send({ kind: 'updateCommand', index, current, field, value: field === 'name' ? value.trim() : value });
  if (field === 'cwd') {
    patchCommand(index, { cwd: value });
    return;
  }
  const label = field === 'name' ? value.trim() : command.name.trim() || value.trim();
  patchCommand(index, field === 'name' ? { name: label, label } : { command: value, label });
  if (label !== current) renameMemberLocally(current, label);
}

function renameGroup(current: string, name: string): void {
  const index = model?.groups.findIndex((group) => group.name === current) ?? -1;
  if (!model || index < 0) return;
  send({ kind: 'renameGroup', index, current, name });
  model = { ...model, groups: model.groups.map((other, at) => (at === index ? { ...other, name } : other)) };
}

/** Changes are sent once every row of the environment is valid. */
function onEnvInput(input: HTMLInputElement, index: number): void {
  const command = model?.commands[index];
  const rows = input.closest('.env');
  if (!command || !rows) return;
  const { env, valid } = readEnv(rows);
  const key = envKey(input);
  if (!valid) {
    cancel(key);
    return;
  }
  const current = command.label;
  schedule(
    key,
    () => {
      const at = model?.commands.findIndex((other) => other.label === current) ?? -1;
      if (at < 0) return;
      send({ kind: 'setEnv', index: at, current, env });
      patchCommand(at, { env });
    },
    TYPING_DELAY_MS,
  );
}

/** The environment as its rows on screen have it, leaving out blank rows. Marks names that are missing or taken. */
function readEnv(rows: Element, skipRow?: number): { env: Array<[string, EnvValue]>; valid: boolean } {
  const env: Array<[string, EnvValue]> = [];
  const seen = new Set<string>();
  let valid = true;
  rows.querySelectorAll<HTMLElement>('.env-row').forEach((row, at) => {
    const keyInput = row.querySelector<HTMLInputElement>('[data-part="key"]')!;
    const valueInput = row.querySelector<HTMLInputElement>('[data-part="value"]')!;
    const key = keyInput.value.trim();
    if (at === skipRow || (!key && !valueInput.value)) {
      showError(keyInput, undefined);
      return;
    }
    const error = !key ? 'Enter a name.' : seen.has(key) ? 'Another variable already has this name.' : undefined;
    showError(keyInput, error);
    valid &&= !error;
    seen.add(key);
    env.push([key, rawValue(valueInput)]);
  });
  return { env, valid };
}

/** A number or true/false in the config stays one as long as it isn't changed. */
function rawValue(input: HTMLInputElement): EnvValue {
  const raw: unknown = input.dataset.raw === undefined ? undefined : JSON.parse(input.dataset.raw);
  return (typeof raw === 'number' || typeof raw === 'boolean') && String(raw) === input.value ? raw : input.value;
}

function onCheckbox(input: HTMLInputElement): void {
  if (!model) return;
  const { scope, field, name } = input.dataset as Record<string, string>;
  const index = Number(input.dataset.index);
  const checked = input.checked;
  const toggled = (names: readonly string[]) => (checked ? [...names, name] : names.filter((other) => other !== name));
  if (scope === 'draft-command' && ui.commandDraft) {
    if (field === 'autoStart') ui.commandDraft.autoStart = checked;
    else ui.commandDraft.groups = toggled(ui.commandDraft.groups);
  } else if (scope === 'draft-group' && ui.groupDraft) {
    ui.groupDraft.commands = toggled(ui.groupDraft.commands);
  } else if (scope === 'command' && field === 'autoStart') {
    const command = model.commands[index];
    send({ kind: 'setAutoStart', index, current: command.label, value: checked });
    patchCommand(index, { autoStart: checked });
  } else {
    // A command's group, or a group's command.
    const groupIndex = scope === 'group' ? index : model.groups.findIndex((group) => group.name === name);
    const group = model.groups[groupIndex];
    const command = scope === 'group' ? name : model.commands[index].label;
    if (!group) return;
    send({ kind: 'setMember', index: groupIndex, current: group.name, command, member: checked });
    const commands = checked ? [...group.commands, command] : group.commands.filter((other) => other !== command);
    model = { ...model, groups: model.groups.map((other, at) => (at === groupIndex ? { ...other, commands } : other)) };
  }
  vscode.setState(ui);
  render();
}

/** Queues an edit. Without a delay, it waits for the user to leave the field or press Enter. */
function schedule(key: string, sendEdit: () => void, delay?: number): void {
  cancel(key);
  pending.set(key, { timer: delay === undefined ? undefined : window.setTimeout(() => flush(key), delay), send: sendEdit });
}

function cancel(key: string): void {
  const entry = pending.get(key);
  if (entry?.timer !== undefined) clearTimeout(entry.timer);
  pending.delete(key);
}

function flush(key: string | undefined): void {
  // Environment rows share one pending change.
  const pendingKey = key && (pending.has(key) ? key : key.replace(/:env:.*/, ':env'));
  const entry = pendingKey && pending.get(pendingKey);
  if (!pendingKey || !entry) return;
  cancel(pendingKey);
  entry.send();
}

function flushAll(): void {
  for (const key of [...pending.keys()]) flush(key);
}

/** Takes back an input's unsaved change, and shows the saved value again. */
function discard(input: HTMLInputElement): void {
  const key = input.dataset.field === 'env' ? envKey(input) : input.dataset.key!;
  cancel(key);
  clearErrors(input.dataset.field === 'env' ? `${key}:` : key);
  pending.delete(key);
  // The input mustn't keep the discarded value through the render.
  input.dataset.discarded = '';
  requestRender();
}

function envKey(input: HTMLInputElement): string {
  return `command:${input.dataset.index}:env`;
}

/** Whether an input holds something the model doesn't: a change not yet saved, or not valid. */
function isUnsaved(input: HTMLInputElement): boolean {
  const key = input.dataset.key ?? '';
  if (input.dataset.discarded !== undefined) return false;
  if (input.dataset.scope?.startsWith('draft-') || held.composition) return true;
  return errors.has(key) || pending.has(key) || (input.dataset.field === 'env' && pending.has(envKey(input)));
}

function patchCommand(index: number, change: Partial<EditorCommand>): void {
  if (!model) return;
  model = { ...model, commands: model.commands.map((command, at) => (at === index ? { ...command, ...change } : command)) };
}

function renameMemberLocally(from: string, to: string): void {
  if (!model) return;
  model = {
    ...model,
    groups: model.groups.map((group) => ({ ...group, commands: group.commands.map((name) => (name === from ? to : name)) })),
  };
}

function moved<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  result.splice(to, 0, ...result.splice(from, 1));
  return result;
}

/** The names that identify entries, by kind, so that open cards and focus can follow them when they move. */
function namesIn(from: EditorModel, kind: string): string[] | undefined {
  if (kind === 'command') return from.commands.map((command) => command.label);
  if (kind === 'group') return from.groups.map((group) => group.name);
  return undefined;
}

/** Where the entry at `index` of `before` is in `after`: undefined if it's gone, the same place if renamed. */
function follow(kind: string, index: number, before: EditorModel, after: EditorModel): number | undefined {
  const name = namesIn(before, kind)?.[index];
  const names = namesIn(after, kind) ?? [];
  if (!name) return index;
  const at = names.indexOf(name);
  return at >= 0 ? at : names.length === namesIn(before, kind)!.length ? index : undefined;
}

/** Keeps the open cards on their entries when the config changes, e.g. when an entry is removed. */
function followCards(next: EditorModel): void {
  const current = model;
  if (!current) return;
  ui.expanded = ui.expanded.flatMap((card) => {
    const [kind, index] = card.split(':');
    const at = follow(kind, Number(index), current, next);
    return at === undefined ? [] : [`${kind}:${at}`];
  });
}

/** An element's key after the next render, following the entry it belongs to. Undefined if that's gone. */
function followKey(key: string): string | undefined {
  const [kind, index, ...rest] = key.split(':');
  if (!rendered || !model || !namesIn(model, kind)) return key;
  const at = follow(kind, Number(index), rendered, model);
  return at === undefined ? undefined : [kind, String(at), ...rest].join(':');
}

function showCommand(name: string): void {
  const index = model?.commands.findIndex((command) => command.label === name) ?? -1;
  if (index < 0) return;
  const card = `command:${index}`;
  if (!ui.expanded.includes(card)) ui.expanded = [...ui.expanded, card];
  nextFocus = `command:${index}:command`;
  render();
}

function otherLabels(index: number): string[] {
  return (model?.commands ?? []).filter((_, at) => at !== index).map((command) => command.label);
}

function nameError(name: string, taken: readonly string[], kind: 'command' | 'group'): string | undefined {
  if (!name) return 'Enter a name.';
  if (taken.includes(name)) return `Another ${kind} already has this name.`;
  return undefined;
}

function setError(key: string, error: string | undefined): void {
  if (error) errors.set(key, error);
  else errors.delete(key);
}

function hasErrors(prefix: string): boolean {
  return [...errors.keys()].some((key) => key.startsWith(prefix));
}

function clearErrors(prefix: string): void {
  for (const key of [...errors.keys()]) if (key.startsWith(prefix)) errors.delete(key);
}

function clearError(input: HTMLInputElement): void {
  if (input.dataset.key && errors.has(input.dataset.key)) showError(input, undefined);
}

/** Shows or clears an input's error in place, without a render that would interrupt typing. */
function showError(input: HTMLInputElement, error: string | undefined): void {
  const key = input.dataset.key!;
  setError(key, error);
  input.toggleAttribute('aria-invalid', error !== undefined);
  const container = input.closest('.field, .env-row');
  let message = container?.querySelector<HTMLElement>(`.field-error[data-for="${CSS.escape(key)}"]`);
  if (error && !message && container) {
    message = h('div', { class: 'field-error', 'data-for': key, id: `${idFor(key)}-error` });
    container.append(message);
    input.setAttribute('aria-describedby', message.id);
  }
  if (message) {
    if (error) message.textContent = error;
    else message.remove();
  }
}

// Rendering. The page is rebuilt from the model on every change. Focus, and what's being typed, are
// carried over to the new elements by key.

function requestRender(): void {
  if (held.pointer || held.composition) renderWaiting = true;
  else render();
}

function resumeRender(): void {
  if (renderWaiting && !held.pointer && !held.composition) render();
}

function render(): void {
  renderWaiting = false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  const requested = nextFocus;
  const focusKey = requested ?? (active?.dataset.key ? followKey(active.dataset.key) : undefined);
  const typing = !requested && active instanceof HTMLInputElement && active.type === 'text' ? active : undefined;
  nextFocus = undefined;

  rendering = true;
  try {
    app.replaceChildren(page());
  } finally {
    rendering = false;
  }
  rendered = model;
  vscode.setState(ui);

  const element = focusKey ? app.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null;
  if (!element) return;
  if (typing && element instanceof HTMLInputElement) {
    if (isUnsaved(typing)) element.value = typing.value;
    const end = element.value.length;
    element.setSelectionRange(Math.min(typing.selectionStart ?? end, end), Math.min(typing.selectionEnd ?? end, end));
  }
  // Focus moves only where it was asked to, or while the form has it: never away from another editor.
  if (requested || document.hasFocus()) {
    element.focus({ preventScroll: true });
    if (!typing) element.scrollIntoView({ block: 'nearest' });
  }
}

function page(): HTMLElement {
  if (!model) return h('p', { class: 'loading' }, 'Loading…');
  return h(
    'div',
    { class: 'page' },
    h(
      'header',
      { class: 'page-header' },
      h(
        'div',
        {},
        h('h1', {}, 'Terminal Commands'),
        h('p', { class: 'subtitle' }, `${model.folderName} · Changes are saved as you make them.`),
      ),
      h('button', { class: 'button secondary', 'data-action': 'open-json', 'data-key': 'open-json' }, 'Edit as JSON'),
    ),
    model.error ? errorBanner(model.error) : null,
    model.problems.length > 0 ? problemList(model.problems) : null,
    model.error ? null : commandsSection(model),
    model.error ? null : groupsSection(model),
  );
}

function errorBanner(error: string): HTMLElement {
  return h(
    'div',
    { class: 'banner', role: 'alert' },
    icon('warning'),
    h('div', {}, h('strong', {}, "The config can't be edited here until it's fixed. "), error),
  );
}

function problemList(problems: readonly string[]): HTMLElement {
  return h('ul', { class: 'problems', 'aria-label': 'Problems' }, ...problems.map((problem) => h('li', {}, icon('warning'), problem)));
}

function commandsSection(model: EditorModel): HTMLElement {
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'commands-heading' },
    sectionHeader('commands-heading', 'Commands', ui.commandDraft ? null : addButton('new-command', 'Add Command')),
    h('p', { class: 'section-description' }, 'Each command runs in its own terminal, from the sidebar or when the project opens.'),
    ui.commandDraft ? commandDraftCard(ui.commandDraft, model) : null,
    model.commands.length === 0 && !ui.commandDraft ? h('p', { class: 'empty' }, 'No commands yet.') : null,
    h('div', { class: 'cards' }, ...model.commands.map((command, index) => commandCard(command, index, model))),
  );
}

function groupsSection(model: EditorModel): HTMLElement {
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'groups-heading' },
    sectionHeader('groups-heading', 'Groups', ui.groupDraft ? null : addButton('new-group', 'Add Group')),
    h(
      'p',
      { class: 'section-description' },
      'A group is a set of commands to start together, like everything one app needs while you work on it. Check a group in the sidebar to start it whenever the project opens.',
    ),
    ui.groupDraft ? groupDraftCard(ui.groupDraft, model) : null,
    model.groups.length === 0 && !ui.groupDraft ? h('p', { class: 'empty' }, 'No groups yet.') : null,
    h('div', { class: 'cards' }, ...model.groups.map((group, index) => groupCard(group, index, model))),
  );
}

function sectionHeader(id: string, title: string, action: HTMLElement | null): HTMLElement {
  return h('div', { class: 'section-header' }, h('h2', { id }, title), action);
}

function addButton(action: string, label: string): HTMLElement {
  return h('button', { class: 'button secondary', 'data-action': action, 'data-key': action }, icon('add'), label);
}

function commandCard(command: EditorCommand, index: number, model: EditorModel): HTMLElement {
  const card = `command:${index}`;
  const expanded = ui.expanded.includes(card);
  const summary = command.name.trim() ? command.command : '';
  const header = cardHeader({
    kind: 'command',
    index,
    count: model.commands.length,
    expanded,
    title: command.label || 'Command without a name',
    summary,
    tags: command.autoStart ? ['auto-start'] : [],
    problems: command.problems,
    removeLabel: `Delete ${command.label || 'Command'}`,
  });
  if (!expanded) return h('article', { class: 'card' }, header);
  if (!command.editable) return h('article', { class: 'card expanded' }, header, notEditable());

  const membership = model.groups.map((group) => ({ name: group.name, checked: group.commands.includes(command.label) }));
  return h(
    'article',
    { class: 'card expanded' },
    header,
    h(
      'div',
      { class: 'card-body' },
      command.problems.length > 0 ? problemList(command.problems) : null,
      textField({
        key: `${card}:name`,
        scope: 'command',
        index,
        field: 'name',
        label: 'Name',
        hint: 'Shown in the sidebar and on the terminal. Must be unique.',
        value: command.name,
        placeholder: command.label,
      }),
      textField({
        key: `${card}:command`,
        scope: 'command',
        index,
        field: 'command',
        label: 'Command',
        hint: 'Run by your default shell.',
        value: command.command,
        mono: true,
      }),
      textField({
        key: `${card}:cwd`,
        scope: 'command',
        index,
        field: 'cwd',
        label: 'Working directory',
        hint: 'Relative to the workspace folder, or absolute. Leave empty for the workspace folder.',
        value: command.cwd,
        placeholder: 'Workspace folder',
        mono: true,
      }),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-label', id: `${idFor(card)}-env` }, 'Environment'),
        h('div', { class: 'field-hint' }, 'Variables to add to the environment the command inherits.'),
        envEditor(command, index),
      ),
      checkboxField({
        key: `${card}:autoStart`,
        scope: 'command',
        index,
        field: 'autoStart',
        label: 'Start when the project opens',
        hint: "You're asked to allow this the first time, and again when it changes.",
        checked: command.autoStart,
      }),
      membershipField({
        label: 'Groups',
        hint: model.groups.length > 0 ? 'The groups this command is in.' : 'Add a group below to start this command along with others.',
        scope: 'command',
        index,
        field: 'group',
        options: membership,
      }),
    ),
  );
}

function groupCard(group: EditorGroup, index: number, model: EditorModel): HTMLElement {
  const card = `group:${index}`;
  const expanded = ui.expanded.includes(card);
  const header = cardHeader({
    kind: 'group',
    index,
    count: model.groups.length,
    expanded,
    title: group.name || 'Group without a name',
    summary: group.commands.join(', '),
    tags: [],
    problems: group.problems,
    removeLabel: `Delete ${group.name || 'Group'}`,
  });
  if (!expanded) return h('article', { class: 'card' }, header);
  if (!group.editable) return h('article', { class: 'card expanded' }, header, notEditable());

  const labels = model.commands.map((command) => command.label);
  // Names that match no command are listed too, so that they can be unchecked.
  const options = [...labels, ...group.commands.filter((name) => !labels.includes(name))].map((name) => ({
    name,
    checked: group.commands.includes(name),
    missing: !labels.includes(name),
  }));
  return h(
    'article',
    { class: 'card expanded' },
    header,
    h(
      'div',
      { class: 'card-body' },
      group.problems.length > 0 ? problemList(group.problems) : null,
      textField({
        key: `${card}:name`,
        scope: 'group',
        index,
        field: 'name',
        label: 'Name',
        hint: 'Shown in the sidebar. Must be unique.',
        value: group.name,
      }),
      membershipField({ label: 'Commands', hint: 'The commands in the group.', scope: 'group', index, field: 'member', options }),
    ),
  );
}

function commandDraftCard(draft: CommandDraft, model: EditorModel): HTMLElement {
  return draftCard(
    'New command',
    'command',
    textField({
      key: 'draft-command:name',
      scope: 'draft-command',
      field: 'name',
      label: 'Name',
      hint: 'Shown in the sidebar and on the terminal.',
      value: draft.name,
      placeholder: 'web',
    }),
    textField({
      key: 'draft-command:command',
      scope: 'draft-command',
      field: 'command',
      label: 'Command',
      hint: 'Run by your default shell.',
      value: draft.command,
      placeholder: 'pnpm run dev',
      mono: true,
    }),
    textField({
      key: 'draft-command:cwd',
      scope: 'draft-command',
      field: 'cwd',
      label: 'Working directory',
      hint: 'Relative to the workspace folder, or absolute. Leave empty for the workspace folder.',
      value: draft.cwd,
      placeholder: 'Workspace folder',
      mono: true,
    }),
    checkboxField({
      key: 'draft-command:autoStart',
      scope: 'draft-command',
      field: 'autoStart',
      label: 'Start when the project opens',
      checked: draft.autoStart,
    }),
    model.groups.length > 0
      ? membershipField({
          label: 'Groups',
          scope: 'draft-command',
          field: 'group',
          options: model.groups.map((group) => ({ name: group.name, checked: draft.groups.includes(group.name) })),
        })
      : null,
  );
}

function groupDraftCard(draft: GroupDraft, model: EditorModel): HTMLElement {
  return draftCard(
    'New group',
    'group',
    textField({
      key: 'draft-group:name',
      scope: 'draft-group',
      field: 'name',
      label: 'Name',
      hint: 'Shown in the sidebar, e.g. the app the commands are for.',
      value: draft.name,
      placeholder: 'web',
    }),
    membershipField({
      label: 'Commands',
      hint: model.commands.length > 0 ? undefined : 'Add commands above, then pick the ones in the group.',
      scope: 'draft-group',
      field: 'member',
      options: model.commands.map((command) => ({ name: command.label, checked: draft.commands.includes(command.label) })),
    }),
  );
}

function draftCard(title: string, kind: 'command' | 'group', ...fields: Array<HTMLElement | null>): HTMLElement {
  const label = kind === 'command' ? 'Add Command' : 'Add Group';
  return h(
    'article',
    { class: 'card draft', 'aria-label': title },
    h(
      'div',
      { class: 'card-body' },
      h('h3', { class: 'draft-title' }, title),
      ...fields,
      h(
        'div',
        { class: 'draft-actions' },
        h('button', { class: 'button', 'data-action': `add-${kind}`, 'data-key': `add-${kind}` }, label),
        h('button', { class: 'button secondary', 'data-action': `cancel-${kind}`, 'data-key': `cancel-${kind}` }, 'Cancel'),
      ),
    ),
  );
}

function cardHeader(options: {
  kind: 'command' | 'group';
  index: number;
  count: number;
  expanded: boolean;
  title: string;
  summary: string;
  tags: string[];
  problems: readonly string[];
  removeLabel: string;
}): HTMLElement {
  const card = `${options.kind}:${options.index}`;
  const data = { 'data-kind': options.kind, 'data-index': String(options.index) };
  return h(
    'div',
    { class: 'card-header' },
    h(
      'div',
      {
        class: 'card-toggle',
        role: 'button',
        tabindex: '0',
        'aria-expanded': String(options.expanded),
        'data-action': 'toggle',
        'data-card': card,
        'data-key': `${card}:header`,
      },
      icon('chevron', 'icon chevron'),
      h('span', { class: 'card-title' }, options.title),
      options.summary ? h('span', { class: options.kind === 'command' ? 'card-summary mono' : 'card-summary' }, options.summary) : null,
      ...options.tags.map((tag) => h('span', { class: 'tag' }, tag)),
      options.problems.length > 0
        ? h('span', { class: 'problem-badge', title: options.problems.join('\n'), 'aria-label': 'Has problems' }, icon('warning'))
        : null,
    ),
    h(
      'div',
      { class: 'card-actions' },
      iconButton('up', 'Move Up', { ...data, 'data-action': 'move-up', 'data-key': `${card}:move-up`, disabled: options.index === 0 }),
      iconButton('down', 'Move Down', {
        ...data,
        'data-action': 'move-down',
        'data-key': `${card}:move-down`,
        disabled: options.index === options.count - 1,
      }),
      iconButton('trash', options.removeLabel, { ...data, 'data-action': 'remove', 'data-key': `${card}:remove` }),
    ),
  );
}

function notEditable(): HTMLElement {
  return h('div', { class: 'card-body' }, h('p', { class: 'empty' }, "This entry isn't an object, so it can only be fixed as JSON."));
}

interface TextFieldOptions {
  key: string;
  scope: string;
  field: string;
  index?: number;
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
}

function textField(options: TextFieldOptions): HTMLElement {
  const id = idFor(options.key);
  const error = errors.get(options.key);
  const input = h('input', {
    type: 'text',
    id,
    class: options.mono ? 'mono' : undefined,
    spellcheck: 'false',
    placeholder: options.placeholder,
    'data-key': options.key,
    'data-scope': options.scope,
    'data-field': options.field,
    'data-index': options.index?.toString(),
    'aria-describedby': [options.hint ? `${id}-hint` : '', error ? `${id}-error` : ''].join(' ').trim() || undefined,
    'aria-invalid': error ? 'true' : undefined,
  });
  input.value = options.value;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'field-label', for: id }, options.label),
    options.hint ? h('div', { class: 'field-hint', id: `${id}-hint` }, options.hint) : null,
    input,
    error ? h('div', { class: 'field-error', 'data-for': options.key, id: `${id}-error` }, error) : null,
  );
}

function checkboxField(options: {
  key: string;
  scope: string;
  field: string;
  index?: number;
  label: string;
  hint?: string;
  checked: boolean;
}): HTMLElement {
  const id = idFor(options.key);
  const input = h('input', {
    type: 'checkbox',
    id,
    'data-key': options.key,
    'data-scope': options.scope,
    'data-field': options.field,
    'data-index': options.index?.toString(),
    'aria-describedby': options.hint ? `${id}-hint` : undefined,
  });
  input.checked = options.checked;
  return h(
    'div',
    { class: 'field' },
    h('label', { class: 'check' }, input, options.label),
    options.hint ? h('div', { class: 'field-hint check-hint', id: `${id}-hint` }, options.hint) : null,
  );
}

function membershipField(options: {
  label: string;
  hint?: string;
  scope: string;
  field: string;
  index?: number;
  options: Array<{ name: string; checked: boolean; missing?: boolean }>;
}): HTMLElement {
  return h(
    'fieldset',
    { class: 'field' },
    h('legend', { class: 'field-label' }, options.label),
    options.hint ? h('div', { class: 'field-hint' }, options.hint) : null,
    options.options.length > 0
      ? h(
          'div',
          { class: 'check-list' },
          ...options.options.map((option) => {
            const input = h('input', {
              type: 'checkbox',
              'data-key': `${options.scope}:${options.index ?? ''}:${options.field}:${option.name}`,
              'data-scope': options.scope,
              'data-field': options.field,
              'data-index': options.index?.toString(),
              'data-name': option.name,
            });
            input.checked = option.checked;
            return h(
              'label',
              { class: option.missing ? 'check missing' : 'check', title: option.missing ? 'There is no command with this name' : undefined },
              input,
              option.name,
            );
          }),
        )
      : null,
  );
}

function envEditor(command: EditorCommand, index: number): HTMLElement {
  // A blank row at the end adds a variable.
  const rows: Array<readonly [string, EnvValue]> = [...command.env, ['', '']];
  return h(
    'div',
    { class: 'env', role: 'group', 'aria-labelledby': `${idFor(`command:${index}`)}-env` },
    ...rows.map(([key, value], row) => {
      const added = row === command.env.length;
      const keyKey = `command:${index}:env:${row}:key`;
      const error = errors.get(keyKey);
      const input = (part: 'key' | 'value', text: EnvValue, label: string, placeholder: string) => {
        const element = h('input', {
          type: 'text',
          class: 'mono',
          spellcheck: 'false',
          placeholder: added ? placeholder : undefined,
          'aria-label': label,
          'aria-invalid': part === 'key' && error ? 'true' : undefined,
          'data-key': `command:${index}:env:${row}:${part}`,
          'data-scope': 'command',
          'data-field': 'env',
          'data-index': String(index),
          'data-row': String(row),
          'data-part': part,
          // See rawValue().
          'data-raw': typeof text === 'string' ? undefined : JSON.stringify(text),
        });
        element.value = String(text);
        return element;
      };
      return h(
        'div',
        { class: 'env-row' },
        input('key', key, added ? 'New variable name' : 'Variable name', 'NAME'),
        input('value', value, added ? 'New variable value' : `Value of ${key}`, 'value'),
        added
          ? h('span', {})
          : iconButton('close', `Remove ${key}`, {
              'data-action': 'remove-env',
              'data-index': String(index),
              'data-row': String(row),
              'data-key': `command:${index}:env:${row}:remove`,
            }),
        error ? h('div', { class: 'field-error', 'data-for': keyKey }, error) : null,
      );
    }),
  );
}

function iconButton(name: IconName, label: string, attributes: Record<string, string | boolean | undefined>): HTMLElement {
  return h('button', { class: 'icon-button', title: label, 'aria-label': label, ...attributes }, icon(name));
}

const ICONS = {
  chevron: 'M6 4l4 4-4 4',
  up: 'M8 12.5v-9M4.5 7 8 3.5 11.5 7',
  down: 'M8 3.5v9M4.5 9 8 12.5 11.5 9',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v3.5M9 7v3.5',
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  add: 'M8 3.5v9M3.5 8h9',
  warning: 'M8 2.5 14.5 13.5h-13zM8 6.5v3M8 11.5v.01',
};
type IconName = keyof typeof ICONS;

function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | boolean | undefined>,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.filter((child): child is Node | string => child !== null && child !== undefined && child !== false));
  return element;
}

function idFor(key: string): string {
  return `field-${key.replace(/[^\w-]/g, '-')}`;
}
