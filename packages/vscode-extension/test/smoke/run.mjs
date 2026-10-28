// Starts VS Code with this extension in a throwaway profile and folder, other
// extensions disabled, and runs test/smoke/suite.ts inside it.
// VSCODE_EXECUTABLE picks the VS Code to use; otherwise @vscode/test-electron
// downloads one.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '..', '..');

await esbuild.build({
  entryPoints: [join(here, 'suite.ts')],
  outfile: join(ext, 'dist-test', 'suite.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'warning',
});

const tmp = mkdtempSync(join(tmpdir(), 'itemizer-smoke-'));
// The test runner splits paths with spaces on Windows: run a staged copy.
const staged = join(tmp, 'extension');
for (const part of ['package.json', 'dist', 'dist-test', 'media', 'bridge-plugin']) cpSync(join(ext, part), join(staged, part), { recursive: true });
const workspace = join(tmp, 'workspace');
const userData = join(tmp, 'user-data');
const bridge = join(tmp, 'bridge');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(userData, 'User'), { recursive: true });
writeFileSync(join(userData, 'User', 'settings.json'), JSON.stringify({ 'claudeItemizer.bridgeDirectory': bridge, 'security.workspace.trust.enabled': false }));

try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    extensionDevelopmentPath: staged,
    extensionTestsPath: join(staged, 'dist-test', 'suite.js'),
    launchArgs: [workspace, '--disable-extensions', `--user-data-dir=${userData}`, '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { SMOKE_BRIDGE: bridge },
  });
  console.log('smoke test passed');
} catch (err) {
  console.error(`smoke test failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
