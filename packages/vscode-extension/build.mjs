// Builds the extension host bundle, the webview bundle, and copies the bridge
// plugin in beside them (the VSIX ships it; "Set Up Claude Bridge" installs it).
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

function copyPlugin() {
  const from = join(here, '..', 'bridge-plugin');
  const to = join(here, 'bridge-plugin');
  rmSync(to, { recursive: true, force: true });
  for (const rel of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/runner.ts', 'hooks/protocol.ts', 'README.md']) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    cpSync(join(from, rel), join(to, rel));
  }
}

const common = {
  bundle: true,
  sourcemap: production ? false : 'linked',
  minify: production,
  logLevel: 'info',
};

const host = {
  ...common,
  entryPoints: [join(here, 'src', 'extension.ts')],
  outfile: join(here, 'dist', 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: { webview: join(here, 'webview', 'main.tsx') },
  outdir: join(here, 'dist'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': production ? '"production"' : '"development"' },
};

// The marketplace page shows the extension's own README and CHANGELOG: copies of the repository's.
for (const f of ['README.md', 'CHANGELOG.md', 'LICENSE']) cpSync(join(here, '..', '..', f), join(here, f));

copyPlugin();
if (watch) {
  const contexts = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(contexts.map(c => c.watch()));
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
