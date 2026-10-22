import { describe, expect, it } from 'vitest';
import { applyConfigEdit, readEditorModel } from '../../src/configDocument';
import type { ConfigEdit } from '../../src/editorProtocol';

/** A config written by hand: a command per line, comments, trailing commas. */
const handWritten = `{
  // Commands for the monorepo.
  "commands": [
    { "name": "web", "command": "pnpm dev" }, // the site
    { "name": "api", "command": "pnpm api", "autoStart": true },

    // Shared services
    { "name": "db", "command": "docker compose up db" },
  ],
  "groups": [
    { "name": "web", "commands": ["web", "api", "db"] },
    { "name": "backend", "commands": ["api", "db"] }
  ]
}
`;

/** A config as Create Config writes it. */
const scaffolded = `{
  "commands": [
    {
      "name": "dev",
      "command": "pnpm run dev",
      "autoStart": false
    }
  ]
}
`;

function edit(text: string, change: ConfigEdit): string {
  const result = applyConfigEdit(text, change);
  if (result === undefined) throw new Error(`The edit didn't apply: ${JSON.stringify(change)}`);
  return result;
}

describe('readEditorModel', () => {
  it('reads commands and groups as written', () => {
    const model = readEditorModel(handWritten, 'acme');
    expect(model.error).toBeUndefined();
    expect(model.problems).toEqual([]);
    expect(model.commands.map((command) => [command.label, command.autoStart])).toEqual([
      ['web', false],
      ['api', true],
      ['db', false],
    ]);
    expect(model.groups).toEqual([
      { name: 'web', commands: ['web', 'api', 'db'], editable: true, problems: [] },
      { name: 'backend', commands: ['api', 'db'], editable: true, problems: [] },
    ]);
  });

  it('keeps entries that are not valid yet, with their problems', () => {
    const model = readEditorModel(
      '{ "commands": [{ "name": "a", "command": "" }, { "command": "pnpm dev", "env": { "PORT": 3000, "X": null } }, 1], "extra": 1 }',
      'acme',
    );
    expect(model.problems).toEqual(['Unknown property "extra".']);
    expect(model.commands).toEqual([
      expect.objectContaining({ name: 'a', label: 'a', editable: true, problems: ['"command" must be a non-empty string.'] }),
      expect.objectContaining({ name: '', label: 'pnpm dev', env: [['PORT', 3000]], editable: true }),
      expect.objectContaining({ editable: false, problems: ['must be an object.'] }),
    ]);
  });

  it('reports a config that cannot be edited', () => {
    expect(readEditorModel('{ "commands": [ }', 'acme')).toEqual({
      folderName: 'acme',
      error: 'Invalid JSON on line 1: ValueExpected',
      problems: [],
      commands: [],
      groups: [],
    });
    expect(readEditorModel('[]', 'acme').error).toBe('The config must be an object with a "commands" array.');
  });
});

describe('applyConfigEdit', () => {
  it('adds a command in the style of the others, keeping comments and trailing commas', () => {
    const result = edit(handWritten, {
      kind: 'addCommand',
      command: { name: 'worker', command: 'pnpm worker', cwd: 'apps/worker', autoStart: true },
      groups: ['backend'],
    });
    expect(result).toBe(`{
  // Commands for the monorepo.
  "commands": [
    { "name": "web", "command": "pnpm dev" }, // the site
    { "name": "api", "command": "pnpm api", "autoStart": true },

    // Shared services
    { "name": "db", "command": "docker compose up db" },
    { "name": "worker", "command": "pnpm worker", "cwd": "apps/worker", "autoStart": true },
  ],
  "groups": [
    { "name": "web", "commands": ["web", "api", "db"] },
    { "name": "backend", "commands": ["api", "db", "worker"] }
  ]
}
`);
  });

  it('adds a command spread over lines when the others are', () => {
    expect(
      edit(scaffolded, { kind: 'addCommand', command: { name: 'api', command: 'pnpm api', cwd: '', autoStart: false }, groups: [] }),
    ).toBe(`{
  "commands": [
    {
      "name": "dev",
      "command": "pnpm run dev",
      "autoStart": false
    },
    {
      "name": "api",
      "command": "pnpm api"
    }
  ]
}
`);
  });

  it('creates the commands in an empty file', () => {
    const command = { name: 'web', command: 'pnpm dev', cwd: '', autoStart: false };
    expect(edit('', { kind: 'addCommand', command, groups: [] })).toBe(`{
  "commands": [
    { "name": "web", "command": "pnpm dev" }
  ]
}
`);
  });

  it('adds the groups array with the first group', () => {
    expect(edit(scaffolded, { kind: 'addGroup', name: 'all', commands: ['dev'] })).toBe(`{
  "commands": [
    {
      "name": "dev",
      "command": "pnpm run dev",
      "autoStart": false
    }
  ],
  "groups": [
    { "name": "all", "commands": ["dev"] }
  ]
}
`);
  });

  it('sets and clears fields in place', () => {
    const withCwd = edit(handWritten, { kind: 'updateCommand', index: 1, current: 'api', field: 'cwd', value: 'apps/api' });
    expect(withCwd).toContain('{ "name": "api", "command": "pnpm api", "cwd": "apps/api", "autoStart": true },');
    const withoutCwd = edit(withCwd, { kind: 'updateCommand', index: 1, current: 'api', field: 'cwd', value: '' });
    expect(withoutCwd).toBe(handWritten);

    const changed = edit(handWritten, { kind: 'updateCommand', index: 0, current: 'web', field: 'command', value: 'pnpm next' });
    expect(changed).toContain('{ "name": "web", "command": "pnpm next" }, // the site');
    expect(edit(scaffolded, { kind: 'setAutoStart', index: 0, current: 'dev', value: true })).toContain('"autoStart": true');
  });

  it('sets the environment on one line, or over lines like the entry', () => {
    const env = [['PORT', 3000], ['DEBUG', 'app:*']] as const;
    expect(edit(handWritten, { kind: 'setEnv', index: 0, current: 'web', env })).toContain(
      '{ "name": "web", "command": "pnpm dev", "env": { "PORT": 3000, "DEBUG": "app:*" } }, // the site',
    );
    const expanded = edit(scaffolded, { kind: 'setEnv', index: 0, current: 'dev', env });
    expect(expanded).toContain(`      "command": "pnpm run dev",
      "env": {
        "PORT": 3000,
        "DEBUG": "app:*"
      },
      "autoStart": false`);
    expect(edit(expanded, { kind: 'setEnv', index: 0, current: 'dev', env: [] })).toBe(scaffolded);
  });

  it('renames a command in the groups that list it', () => {
    const result = edit(handWritten, { kind: 'updateCommand', index: 1, current: 'api', field: 'name', value: 'server' });
    expect(result).toContain('{ "name": "server", "command": "pnpm api", "autoStart": true },');
    expect(result).toContain('{ "name": "web", "commands": ["web", "server", "db"] },');
    expect(result).toContain('{ "name": "backend", "commands": ["server", "db"] }');
  });

  it('follows a command without a name to its new command line', () => {
    const text = '{ "commands": [{ "command": "pnpm dev" }], "groups": [{ "name": "g", "commands": ["pnpm dev"] }] }';
    expect(edit(text, { kind: 'updateCommand', index: 0, current: 'pnpm dev', field: 'command', value: 'pnpm start' })).toBe(
      '{ "commands": [{ "command": "pnpm start" }], "groups": [{ "name": "g", "commands": ["pnpm start"] }] }',
    );
  });

  it('removes a command from the list and its groups, with its comments', () => {
    const result = edit(handWritten, { kind: 'removeCommand', index: 0, current: 'web' });
    expect(result).toBe(`{
  // Commands for the monorepo.
  "commands": [
    { "name": "api", "command": "pnpm api", "autoStart": true },

    // Shared services
    { "name": "db", "command": "docker compose up db" },
  ],
  "groups": [
    { "name": "web", "commands": ["api", "db"] },
    { "name": "backend", "commands": ["api", "db"] }
  ]
}
`);
  });

  it('moves a command with its comments', () => {
    const result = edit(handWritten, { kind: 'moveCommand', index: 2, current: 'db', to: 0 });
    expect(result).toContain(`  "commands": [

    // Shared services
    { "name": "db", "command": "docker compose up db" },
    { "name": "web", "command": "pnpm dev" }, // the site
    { "name": "api", "command": "pnpm api", "autoStart": true },
  ],`);
  });

  it('edits groups and their commands', () => {
    let result = edit(handWritten, { kind: 'setMember', index: 1, current: 'backend', command: 'web', member: true });
    expect(result).toContain('{ "name": "backend", "commands": ["api", "db", "web"] }');
    result = edit(result, { kind: 'setMember', index: 1, current: 'backend', command: 'api', member: false });
    expect(result).toContain('{ "name": "backend", "commands": ["db", "web"] }');
    result = edit(result, { kind: 'renameGroup', index: 1, current: 'backend', name: 'services' });
    expect(result).toContain('{ "name": "services", "commands": ["db", "web"] }');
    result = edit(result, { kind: 'moveGroup', index: 1, current: 'services', to: 0 });
    expect(result).toContain(`  "groups": [
    { "name": "services", "commands": ["db", "web"] },
    { "name": "web", "commands": ["web", "api", "db"] }
  ]`);
    result = edit(result, { kind: 'removeGroup', index: 0, current: 'services' });
    expect(result).toContain(`  "groups": [
    { "name": "web", "commands": ["web", "api", "db"] }
  ]`);
  });

  it('refuses edits to entries that have changed, and edits that would make the config invalid', () => {
    const refused: ConfigEdit[] = [
      { kind: 'updateCommand', index: 0, current: 'api', field: 'cwd', value: 'x' },
      { kind: 'updateCommand', index: 0, current: 'web', field: 'name', value: 'api' },
      { kind: 'updateCommand', index: 0, current: 'web', field: 'command', value: '  ' },
      { kind: 'addCommand', command: { name: 'db', command: 'x', cwd: '', autoStart: false }, groups: [] },
      { kind: 'addGroup', name: 'web', commands: [] },
      { kind: 'addGroup', name: 'new', commands: ['nope'] },
      { kind: 'setEnv', index: 0, current: 'web', env: [['A', '1'], ['A', '2']] },
      { kind: 'moveCommand', index: 0, current: 'web', to: 3 },
      { kind: 'setMember', index: 0, current: 'backend', command: 'web', member: true },
    ];
    for (const change of refused) expect(applyConfigEdit(handWritten, change), JSON.stringify(change)).toBeUndefined();
    expect(applyConfigEdit('{ "commands": [ }', { kind: 'removeCommand', index: 0, current: 'x' })).toBeUndefined();
  });

  it('changes one environment variable at a time, keeping comments and values the form does not show', () => {
    const text = `{
  "commands": [
    {
      "name": "api",
      "command": "pnpm api",
      "env": {
        // The port the API listens on.
        "PORT": 4000,
        "BROKEN": null,
        "DEBUG": "api:*"
      }
    }
  ]
}
`;
    expect(edit(text, { kind: 'setEnv', index: 0, current: 'api', env: [['PORT', 4000], ['LOG', 'debug']] })).toBe(`{
  "commands": [
    {
      "name": "api",
      "command": "pnpm api",
      "env": {
        // The port the API listens on.
        "PORT": 4000,
        "BROKEN": null,
        "LOG": "debug"
      }
    }
  ]
}
`);
  });

  it('keeps comments and trailing commas in containers on one line', () => {
    const empty = '{ "commands": [{ "name": "web", "command": "x" }], "groups": [{ "name": "g", "commands": [ /* none yet */ ] }] }';
    expect(edit(empty, { kind: 'setMember', index: 0, current: 'g', command: 'web', member: true })).toBe(
      '{ "commands": [{ "name": "web", "command": "x" }], "groups": [{ "name": "g", "commands": [ /* none yet */ "web" ] }] }',
    );
    const trailing = '{ "commands": [{ "name": "web", "command": "x", }] }';
    expect(edit(trailing, { kind: 'setAutoStart', index: 0, current: 'web', value: true })).toBe(
      '{ "commands": [{ "name": "web", "command": "x", "autoStart": true, }] }',
    );
  });

  it('keeps the comments of a file that has nothing else', () => {
    const command = { name: 'web', command: 'x', cwd: '', autoStart: false };
    expect(edit('// Our commands\n', { kind: 'addCommand', command, groups: [] })).toBe(`// Our commands
{
  "commands": [
    { "name": "web", "command": "x" }
  ]
}
`);
  });

  it('indents like the top level, whatever the comments look like', () => {
    const command = { name: 'web', command: 'x', cwd: '', autoStart: false };
    expect(edit('/**\n * Our commands.\n */\n{\n    "commands": []\n}\n', { kind: 'addCommand', command, groups: [] })).toBe(
      '/**\n * Our commands.\n */\n{\n    "commands": [\n        { "name": "web", "command": "x" }\n    ]\n}\n',
    );
  });

  it('edits the last of two properties with the same name, which is the one that counts', () => {
    const text = '{ "commands": [], "commands": [{ "name": "web", "command": "x" }] }';
    expect(edit(text, { kind: 'setAutoStart', index: 0, current: 'web', value: true })).toBe(
      '{ "commands": [], "commands": [{ "name": "web", "command": "x", "autoStart": true }] }',
    );
  });

  it("keeps a command without a name from taking another command's name", () => {
    const text = '{ "commands": [{ "command": "pnpm dev" }, { "name": "pnpm start", "command": "x" }] }';
    expect(
      applyConfigEdit(text, { kind: 'updateCommand', index: 0, current: 'pnpm dev', field: 'command', value: 'pnpm start' }),
    ).toBeUndefined();
  });

  it('removes entries that are not objects', () => {
    expect(edit('{ "commands": [1, { "command": "x" }] }', { kind: 'removeCommand', index: 0, current: '' })).toBe(
      '{ "commands": [{ "command": "x" }] }',
    );
  });

  it('keeps a byte order mark and Windows line endings', () => {
    const text = '﻿{\r\n  "commands": [\r\n    { "name": "web", "command": "pnpm dev" }\r\n  ]\r\n}\r\n';
    expect(edit(text, { kind: 'addGroup', name: 'all', commands: ['web'] })).toBe(
      '﻿{\r\n  "commands": [\r\n    { "name": "web", "command": "pnpm dev" }\r\n  ],\r\n  "groups": [\r\n    { "name": "all", "commands": ["web"] }\r\n  ]\r\n}\r\n',
    );
  });
});
