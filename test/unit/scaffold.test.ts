import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';
import { scaffoldConfig } from '../../src/scaffold';

function commandsOf(text: string): Array<[string, string]> {
  const { commands, problems } = parseConfig(text);
  expect(problems).toEqual([]);
  return commands.map((command) => [command.name, command.command]);
}

describe('scaffoldConfig', () => {
  it('turns long-running scripts into commands, using the lockfile to pick the package manager', () => {
    const packageJson = JSON.stringify({
      scripts: {
        build: 'turbo build',
        'dev:web': 'turbo dev --filter web',
        'dev:api': 'turbo dev --filter api',
        devtools: 'x',
        start: 'node .',
        'watch:css': 'x',
      },
    });
    const text = scaffoldConfig({ packageJson, rootEntries: ['package.json', 'pnpm-lock.yaml'] });
    expect(commandsOf(text)).toEqual([
      ['dev:web', 'pnpm run dev:web'],
      ['dev:api', 'pnpm run dev:api'],
      ['start', 'pnpm run start'],
      ['watch:css', 'pnpm run watch:css'],
    ]);
  });

  it('prefers the packageManager field over lockfiles', () => {
    const packageJson = JSON.stringify({ packageManager: 'yarn@4.1.0', scripts: { dev: 'vite' } });
    const text = scaffoldConfig({ packageJson, rootEntries: ['package-lock.json'] });
    expect(commandsOf(text)).toEqual([['dev', 'yarn run dev']]);
  });

  it('falls back to an example command', () => {
    expect(commandsOf(scaffoldConfig({ rootEntries: [] }))).toEqual([['dev', 'npm run dev']]);
    expect(commandsOf(scaffoldConfig({ packageJson: '{ not json', rootEntries: ['bun.lock'] }))).toEqual([
      ['dev', 'bun run dev'],
    ]);
  });

  it('writes autoStart explicitly so the option is discoverable', () => {
    expect(scaffoldConfig({ rootEntries: [] })).toContain('"autoStart": false');
  });
});
