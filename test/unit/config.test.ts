import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config';

describe('parseConfig', () => {
  it('reads commands with every field', () => {
    const { commands, problems } = parseConfig(`{
      "commands": [
        {
          "name": "web",
          "command": "pnpm run dev:web",
          "cwd": "apps/web",
          "env": { "PORT": 3000, "DEBUG": true, "MODE": "dev" },
          "autoStart": true
        }
      ]
    }`);
    expect(problems).toEqual([]);
    expect(commands).toEqual([
      {
        name: 'web',
        command: 'pnpm run dev:web',
        cwd: 'apps/web',
        env: { PORT: '3000', DEBUG: 'true', MODE: 'dev' },
        autoStart: true,
        offset: expect.any(Number),
      },
    ]);
  });

  it('applies defaults', () => {
    const { commands } = parseConfig('{ "commands": [{ "command": "  npm start  " }] }');
    expect(commands).toEqual([
      { name: 'npm start', command: '  npm start  ', env: {}, autoStart: false, offset: expect.any(Number) },
    ]);
  });

  it('accepts comments, trailing commas and a byte order mark', () => {
    const { commands, problems } = parseConfig(`﻿{
      // the API
      "commands": [{ "name": "api", "command": "pnpm dev", },],
    }`);
    expect(problems).toEqual([]);
    expect(commands.map((command) => command.name)).toEqual(['api']);
  });

  it('records where each entry starts', () => {
    const text = '{ "commands": [ {"command": "a"}, {"command": "b"} ] }';
    const { commands } = parseConfig(text);
    expect(commands.map((command) => text.slice(command.offset, command.offset + 3))).toEqual(['{"c', '{"c']);
    expect(commands[1].offset).toBe(text.indexOf('{"command": "b"}'));
  });

  it('treats an empty file as having no commands', () => {
    expect(parseConfig('')).toEqual({ commands: [], problems: ['The config must be an object with a "commands" array.'] });
  });

  it('reports syntax errors with their line', () => {
    const { commands, problems } = parseConfig('{\n  "commands": [\n    { "command": "a" }\n    { "command": "b" }\n  ]\n}');
    expect(commands).toEqual([]);
    expect(problems).toEqual(['Invalid JSON on line 4: CommaExpected']);
  });

  it('reports a missing or malformed commands array', () => {
    expect(parseConfig('{}').problems).toEqual(['Missing the "commands" array.']);
    expect(parseConfig('{ "commands": {} }').problems).toEqual(['"commands" must be an array.']);
    expect(parseConfig('[]').problems).toEqual(['The config must be an object with a "commands" array.']);
  });

  it('skips invalid entries but keeps the rest', () => {
    const { commands, problems } = parseConfig(`{
      "commands": [
        "npm start",
        { "name": "no-command" },
        { "name": "bad-env", "command": "x", "env": { "A": null } },
        { "name": "bad-auto", "command": "x", "autoStart": "yes" },
        { "name": "", "command": "x" },
        { "name": "bad-cwd", "command": "x", "cwd": 1 },
        { "name": "ok", "command": "x" }
      ]
    }`);
    expect(commands.map((command) => command.name)).toEqual(['ok']);
    expect(problems).toEqual([
      'commands[0]: must be an object.',
      'commands[1] "no-command": "command" must be a non-empty string.',
      'commands[2] "bad-env": "env.A" must be a string, number or boolean.',
      'commands[3] "bad-auto": "autoStart" must be true or false.',
      'commands[4]: "name" must be a non-empty string.',
      'commands[5] "bad-cwd": "cwd" must be a string.',
    ]);
  });

  it('keeps entries with unknown properties but reports them', () => {
    const { commands, problems } = parseConfig('{ "commands": [{ "command": "x", "autostart": true }], "extra": 1 }');
    expect(commands.map((command) => command.autoStart)).toEqual([false]);
    expect(problems).toEqual(['Unknown property "extra".', 'commands[0]: unknown property "autostart".']);
  });

  it('rejects duplicate names, including derived ones', () => {
    const { commands, problems } = parseConfig(`{
      "commands": [
        { "name": "web", "command": "a" },
        { "name": "web", "command": "b" },
        { "command": "c" },
        { "command": "c" }
      ]
    }`);
    expect(commands.map((command) => command.command)).toEqual(['a', 'c']);
    expect(problems).toEqual([
      'commands[1] "web": another command already has this name.',
      'commands[3]: another command already has this name.',
    ]);
  });

  it('allows a $schema property', () => {
    expect(parseConfig('{ "$schema": "./schema.json", "commands": [] }').problems).toEqual([]);
  });
});
