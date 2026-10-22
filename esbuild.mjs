import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode'],
  // jsonc-parser's UMD build hides its requires from bundlers; its ESM build bundles cleanly.
  mainFields: ['module', 'main'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  // The config editor's form, which runs in a webview. Its stylesheet comes out as dist/webview.css.
  {
    ...common,
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    external: [],
  },
];
if (tests) {
  const testFiles = readdirSync('test/integration').filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  builds.push({
    ...common,
    entryPoints: testFiles.map((file) => `test/integration/${file}`),
    outdir: 'out/test/integration',
    external: ['vscode', 'mocha'],
  });
}

const contexts = await Promise.all(builds.map((options) => esbuild.context(options)));
if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
