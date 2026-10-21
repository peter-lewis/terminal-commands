export interface ScaffoldInput {
  /** Text of the folder's package.json, if it has one. */
  readonly packageJson?: string;
  /** Names of the entries in the folder's root, used to detect the package manager. */
  readonly rootEntries: readonly string[];
}

/** Script names that usually start something long-running: dev, dev:web, start, serve, watch:css, ... */
const LONG_RUNNING_SCRIPT = /^(dev|start|serve|watch)\b/;

/**
 * Builds the initial contents of a config file. Long-running package.json scripts become commands, so a
 * monorepo with `dev:*` scripts gets a useful config straight away.
 */
export function scaffoldConfig(input: ScaffoldInput): string {
  const manifest = parseManifest(input.packageJson);
  const packageManager = detectPackageManager(manifest.packageManager, input.rootEntries);
  const scripts = manifest.scripts.filter((script) => LONG_RUNNING_SCRIPT.test(script));
  const commands = (scripts.length > 0 ? scripts : ['dev']).map((script) => ({
    name: script,
    command: `${packageManager} run ${script}`,
    autoStart: false,
  }));
  return `${JSON.stringify({ commands }, null, 2)}\n`;
}

interface Manifest {
  readonly packageManager?: string;
  readonly scripts: readonly string[];
}

function parseManifest(text: string | undefined): Manifest {
  if (!text) return { scripts: [] };
  try {
    const manifest: unknown = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object') return { scripts: [] };
    const { packageManager, scripts } = manifest as { packageManager?: unknown; scripts?: unknown };
    return {
      packageManager: typeof packageManager === 'string' ? packageManager : undefined,
      scripts: scripts && typeof scripts === 'object' ? Object.keys(scripts) : [],
    };
  } catch {
    return { scripts: [] };
  }
}

function detectPackageManager(declared: string | undefined, rootEntries: readonly string[]): string {
  // The "packageManager" field looks like "pnpm@9.1.0".
  const name = declared?.split('@')[0];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;
  const entries = new Set(rootEntries);
  if (entries.has('pnpm-lock.yaml')) return 'pnpm';
  if (entries.has('yarn.lock')) return 'yarn';
  if (entries.has('bun.lock') || entries.has('bun.lockb')) return 'bun';
  return 'npm';
}
