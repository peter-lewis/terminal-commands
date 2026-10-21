import * as vscode from 'vscode';
import { commandKey } from './configStore';

/** Task type of the tasks that run configured commands. Declared in package.json. */
export const TASK_TYPE = 'terminalCommand';

export type CommandStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

/** Everything needed to run one command. */
export interface LaunchSpec {
  /** Identifies the command across config reloads. */
  readonly key: string;
  readonly name: string;
  readonly folder: vscode.WorkspaceFolder;
  readonly commandLine: string;
  /** Absolute working directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface CommandState {
  readonly status: CommandStatus;
  /** Exit code of the last run, when it ended by itself rather than through Stop. */
  readonly exitCode?: number;
  readonly hasTerminal: boolean;
}

export function isActive(status: CommandStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping';
}

/**
 * Builds the task that runs a command. The task system gives each command a dedicated terminal that is
 * reused by later runs and stays open after the command exits, and it reports exactly when the
 * process starts and ends. `definition` must be passed through when resolving a task from tasks.json.
 */
export function taskFor(spec: LaunchSpec, reveal: boolean, definition?: vscode.TaskDefinition): vscode.Task {
  const task = new vscode.Task(
    definition ?? { type: TASK_TYPE, name: spec.name },
    spec.folder,
    spec.name,
    'Terminal Commands',
    new vscode.ShellExecution(spec.commandLine, { cwd: spec.cwd, env: { ...spec.env } }),
    [],
  );
  // Long-running: also lets VS Code reconnect to the task after a window reload.
  task.isBackground = true;
  task.presentationOptions = {
    reveal: reveal ? vscode.TaskRevealKind.Always : vscode.TaskRevealKind.Never,
    focus: false,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: false,
    echo: true,
    close: false,
  };
  return task;
}

/** Key of the configured command a task runs, or undefined if the task isn't one of ours. */
function keyOf(task: vscode.Task): string | undefined {
  const { definition, scope } = task;
  if (definition.type !== TASK_TYPE || typeof definition.name !== 'string') return undefined;
  if (typeof scope !== 'object' || !('uri' in scope)) return undefined;
  return commandKey(scope.uri, definition.name);
}

/**
 * A Ctrl+C sent while a command's process is still starting up can be lost. Processes younger than
 * this get their Ctrl+C late, and once more if they are still running a second later.
 */
const INTERRUPT_GRACE_MS = 500;
const INTERRUPT_RETRY_MS = 1000;
/** How long Restart waits for Ctrl+C to end the command before terminating it. */
const RESTART_TIMEOUT_MS = 10000;
/** How long to wait for VS Code to finish ending a task before running it again. */
const TASK_END_TIMEOUT_MS = 5000;
const CTRL_C = '\x03';
/** 128 + SIGINT: interrupted with Ctrl+C, which is how dev servers are normally stopped. */
const INTERRUPTED_EXIT_CODE = 130;

interface Run {
  /** For the log. */
  name: string;
  status: CommandStatus;
  exitCode?: number;
  execution?: vscode.TaskExecution;
  terminal?: vscode.Terminal;
  /** The command's current process, while it runs. */
  processId?: number;
  /** When the current process started (Date.now()). */
  startedAt: number;
  stopRequested: boolean;
  /** The task has been launched and its process hasn't started yet. */
  launching: boolean;
  /** Incremented by every start and abandoned start, so a superseded start knows to give up. */
  generation: number;
}

/**
 * Runs each command as a task in its own terminal and tracks its status from the task events. That
 * includes runs started elsewhere, e.g. from "Tasks: Run Task" or reconnected after a window reload.
 */
export class CommandRunner implements vscode.Disposable {
  private readonly runs = new Map<string, Run>();
  private readonly changeEmitter = new vscode.EventEmitter<string>();
  private readonly disposables: vscode.Disposable[];

  /** Fires with the key of a command whose state changed. */
  readonly onDidChangeState = this.changeEmitter.event;

  constructor(private readonly log: vscode.LogOutputChannel) {
    this.disposables = [
      this.changeEmitter,
      vscode.tasks.onDidStartTaskProcess((event) => void this.handleProcessStart(event)),
      vscode.tasks.onDidEndTaskProcess((event) => this.handleProcessEnd(event)),
      vscode.tasks.onDidEndTask((event) => this.handleTaskEnd(event)),
      vscode.window.onDidCloseTerminal((terminal) => this.handleTerminalClosed(terminal)),
    ];
    for (const execution of vscode.tasks.taskExecutions) this.adopt(execution);
  }

  getState(key: string): CommandState {
    const run = this.runs.get(key);
    return { status: run?.status ?? 'stopped', exitCode: run?.exitCode, hasTerminal: run?.terminal !== undefined };
  }

  getTerminal(key: string): vscode.Terminal | undefined {
    return this.runs.get(key)?.terminal;
  }

  /** Starts the command unless it is already active. Resolves once the task has been launched. */
  async start(spec: LaunchSpec, options: { reveal?: boolean } = {}): Promise<void> {
    const run = this.runFor(spec.key, spec.name);
    if (isActive(run.status)) {
      if (options.reveal) run.terminal?.show(true);
      return;
    }
    if (!(await isDirectory(spec.cwd))) {
      void vscode.window.showErrorMessage(`Can't start "${spec.name}": ${spec.cwd} is not a directory.`);
      return;
    }
    if (isActive(run.status)) return;
    const active = vscode.tasks.taskExecutions.find((execution) => keyOf(execution.task) === spec.key);
    if (active && !run.execution) {
      // Running already, though not started here, e.g. from "Tasks: Run Task".
      this.adopt(active);
      if (options.reveal) run.terminal?.show(true);
      return;
    }
    const generation = ++run.generation;
    run.stopRequested = false;
    this.update(spec.key, run, { status: 'starting', exitCode: undefined });

    // A task VS Code is still winding down can't be run again until it has ended.
    const ended = !active || (await this.waitForTaskToEnd(spec.key, TASK_END_TIMEOUT_MS));
    if (run.generation !== generation) return;
    if (!ended) {
      this.log.warn(`${spec.name}: the previous run hasn't ended; not starting it again`);
      this.update(spec.key, run, { status: 'failed' });
      return;
    }
    this.log.debug(`${spec.name}: running \`${spec.commandLine}\` in ${spec.cwd}`);
    run.launching = true;
    try {
      const execution = await vscode.tasks.executeTask(taskFor(spec, options.reveal ?? false));
      if (run.generation === generation && isActive(run.status)) run.execution ??= execution;
    } catch (error) {
      run.launching = false;
      this.log.error(`${spec.name}: couldn't start: ${String(error)}`);
      void vscode.window.showErrorMessage(`Couldn't start "${spec.name}": ${String(error)}`);
      if (run.generation === generation) this.update(spec.key, run, { status: 'failed' });
    }
  }

  /** Interrupts the command with Ctrl+C. Its terminal stays open so the output can still be read. */
  stop(key: string): void {
    const run = this.runs.get(key);
    if (!run || !isActive(run.status)) return;
    this.log.debug(`${run.name}: stopping (was ${run.status})`);
    if (run.status === 'starting' && !run.launching && run.processId === undefined) {
      // Not launched yet: abandon the start.
      run.generation++;
      this.update(key, run, { status: 'stopped' });
      return;
    }
    run.stopRequested = true;
    // A command whose process hasn't started yet is interrupted once it has (see handleProcessStart).
    if (!run.launching) this.interrupt(run);
    this.update(key, run, { status: 'stopping' });
  }

  stopAll(): void {
    for (const key of this.runs.keys()) this.stop(key);
  }

  async restart(spec: LaunchSpec, options: { reveal?: boolean } = {}): Promise<void> {
    if (isActive(this.getState(spec.key).status)) {
      this.stop(spec.key);
      if (!(await this.waitUntilInactive(spec.key, RESTART_TIMEOUT_MS))) {
        this.log.debug(`${spec.name}: didn't stop on Ctrl+C; terminating it`);
        this.runs.get(spec.key)?.execution?.terminate();
        await this.waitUntilInactive(spec.key, TASK_END_TIMEOUT_MS);
      }
    }
    await this.start(spec, options);
  }

  /** Ends the command's process if it is running, and closes its terminal. */
  kill(key: string): void {
    const run = this.runs.get(key);
    if (!run || (!isActive(run.status) && !run.terminal)) return;
    this.log.debug(`${run.name}: killing`);
    if (!run.terminal && !run.execution) {
      // Still being launched; it is interrupted as soon as its process starts.
      this.stop(key);
      return;
    }
    const active = isActive(run.status);
    if (active) run.stopRequested = true;
    // Closing a task's terminal ends its process as well. That also covers a process that is just
    // exiting, which terminate() would no longer find, leaving the terminal open.
    if (run.terminal) run.terminal.dispose();
    else run.execution?.terminate();
    if (active) this.update(key, run, { status: 'stopping' });
  }

  /** Shows the command's terminal. Returns false if it has none. */
  show(key: string, preserveFocus: boolean): boolean {
    const terminal = this.runs.get(key)?.terminal;
    terminal?.show(preserveFocus);
    return terminal !== undefined;
  }

  dispose(): void {
    // Running tasks are left alone; they belong to the window.
    for (const disposable of this.disposables) disposable.dispose();
  }

  private runFor(key: string, name: string): Run {
    let run = this.runs.get(key);
    if (!run) {
      run = { name, status: 'stopped', startedAt: 0, stopRequested: false, launching: false, generation: 0 };
      this.runs.set(key, run);
    }
    run.name = name;
    return run;
  }

  private update(key: string, run: Run, patch: Pick<Run, 'status'> & Partial<Pick<Run, 'exitCode'>>): void {
    Object.assign(run, patch);
    this.changeEmitter.fire(key);
  }

  /** Tracks a task that is already running, e.g. one VS Code reconnected to after a window reload. */
  private adopt(execution: vscode.TaskExecution): void {
    const key = keyOf(execution.task);
    if (key === undefined) return;
    const run = this.runFor(key, execution.task.name);
    run.execution = execution;
    run.launching = false;
    // Task terminals are titled with the command's name. (The task's own name may have gained a prefix
    // when VS Code reconnected to it.)
    run.terminal ??= vscode.window.terminals.find((terminal) => terminal.name === execution.task.definition.name);
    this.log.debug(`${run.name}: found it already running`);
    this.update(key, run, { status: 'running' });
  }

  /** Sends Ctrl+C to the command, holding it back while the process is still starting up. */
  private interrupt(run: Run): void {
    const processId = run.processId;
    const send = () => {
      if (run.processId !== processId) return;
      if (run.terminal) {
        this.log.debug(`${run.name}: sending Ctrl+C`);
        run.terminal.sendText(CTRL_C, false);
      } else {
        // There's no terminal to type into, so end it the hard way.
        run.execution?.terminate();
      }
    };
    const wait = run.startedAt + INTERRUPT_GRACE_MS - Date.now();
    if (wait <= 0) {
      send();
    } else {
      setTimeout(send, wait);
      setTimeout(send, wait + INTERRUPT_RETRY_MS);
    }
  }

  private waitUntilInactive(key: string, timeoutMs: number): Promise<boolean> {
    return this.waitFor(() => !isActive(this.getState(key).status), timeoutMs);
  }

  private waitForTaskToEnd(key: string, timeoutMs: number): Promise<boolean> {
    const ended = () => !vscode.tasks.taskExecutions.some((execution) => keyOf(execution.task) === key);
    if (ended()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(ended()), timeoutMs);
      const subscription = vscode.tasks.onDidEndTask(() => {
        if (ended()) finish(true);
      });
      function finish(result: boolean): void {
        clearTimeout(timer);
        subscription.dispose();
        resolve(result);
      }
    });
  }

  private waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
    if (condition()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), timeoutMs);
      const subscription = this.onDidChangeState(() => {
        if (condition()) finish(true);
      });
      function finish(result: boolean): void {
        clearTimeout(timer);
        subscription.dispose();
        resolve(result);
      }
    });
  }

  private async handleProcessStart(event: vscode.TaskProcessStartEvent): Promise<void> {
    const key = keyOf(event.execution.task);
    if (key === undefined) return;
    const run = this.runFor(key, event.execution.task.name);
    run.execution = event.execution;
    run.processId = event.processId;
    run.startedAt = Date.now();
    run.launching = false;
    this.log.debug(`${run.name}: process ${event.processId} started`);
    if (!run.stopRequested) this.update(key, run, { status: 'running', exitCode: undefined });

    const terminal = await terminalWithProcess(event.processId);
    if (run.processId !== event.processId) return;
    if (terminal && terminal !== run.terminal) {
      run.terminal = terminal;
      this.changeEmitter.fire(key);
    }
    if (run.stopRequested) this.interrupt(run);
  }

  private handleProcessEnd(event: vscode.TaskProcessEndEvent): void {
    const key = keyOf(event.execution.task);
    const run = key === undefined ? undefined : this.runs.get(key);
    if (key === undefined || !run) return;
    const { exitCode } = event;
    this.log.debug(`${run.name}: process ended with exit code ${exitCode}`);
    const requested = run.stopRequested;
    run.stopRequested = false;
    run.processId = undefined;
    const failed = !requested && exitCode !== undefined && exitCode !== 0 && exitCode !== INTERRUPTED_EXIT_CODE;
    this.update(key, run, { status: failed ? 'failed' : 'stopped', exitCode: requested ? undefined : exitCode });
  }

  private handleTaskEnd(event: vscode.TaskEndEvent): void {
    const key = keyOf(event.execution.task);
    const run = key === undefined ? undefined : this.runs.get(key);
    if (key === undefined || !run) return;
    run.execution = undefined;
    if (!run.launching) return;
    // The task launched by start() ended without its process ever starting, e.g. because the shell
    // couldn't be launched.
    run.launching = false;
    this.update(key, run, { status: run.stopRequested ? 'stopped' : 'failed' });
  }

  private handleTerminalClosed(terminal: vscode.Terminal): void {
    for (const [key, run] of this.runs) {
      if (run.terminal !== terminal) continue;
      run.terminal = undefined;
      this.changeEmitter.fire(key);
    }
  }
}

async function terminalWithProcess(processId: number): Promise<vscode.Terminal | undefined> {
  for (const terminal of vscode.window.terminals) {
    if ((await terminal.processId) === processId) return terminal;
  }
  return undefined;
}

async function isDirectory(fsPath: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}
