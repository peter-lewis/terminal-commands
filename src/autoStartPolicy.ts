import { createHash } from 'node:crypto';
import type { CommandDefinition } from './config';

/** Value of the `terminalCommands.autoStart` setting. */
export type AutoStartMode = 'prompt' | 'always' | 'never';

/** The user's answer to the auto-start prompt for one workspace folder. */
export interface AutoStartDecision {
  /** Fingerprint of the auto-start commands the user was asked about. */
  readonly fingerprint: string;
  readonly allowed: boolean;
}

/**
 * Identifies exactly what a set of commands would run when auto-started. Any change to what runs, where,
 * or with which environment produces a new fingerprint, which invalidates an earlier decision (like
 * `direnv allow`). Cosmetic fields and command order don't count.
 */
export function autoStartFingerprint(commands: readonly CommandDefinition[]): string {
  const relevant = commands
    .map((command) => ({
      name: command.name,
      command: command.command,
      cwd: command.cwd ?? null,
      env: Object.entries(command.env).sort(([a], [b]) => compare(a, b)),
    }))
    .sort((a, b) => compare(a.name, b.name));
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

export function decideAutoStart(
  mode: AutoStartMode,
  fingerprint: string,
  previous: AutoStartDecision | undefined,
): 'start' | 'skip' | 'ask' {
  if (mode === 'never') return 'skip';
  if (mode === 'always') return 'start';
  if (previous?.fingerprint === fingerprint) return previous.allowed ? 'start' : 'skip';
  return 'ask';
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
