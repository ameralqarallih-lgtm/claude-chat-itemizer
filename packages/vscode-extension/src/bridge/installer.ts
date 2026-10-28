// Sets up the itemizer-bridge plugin for Claude sessions that VS Code starts:
// copies the bundled plugin to ~/.claude/itemizer/plugin and names that folder
// in CLAUDE_CODE_PLUGIN_DIRS through the Claude extension's
// claudeCode.environmentVariables setting. Only Claude tabs opened afterwards
// load it.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { PLUGIN_VERSION } from '../../../bridge-plugin/hooks/protocol';
import { exists, remove } from './fsutil';

const ENV_SETTING = 'environmentVariables';
const PLUGIN_DIRS = 'CLAUDE_CODE_PLUGIN_DIRS';
const BRIDGE_DIR = 'ITEMIZER_BRIDGE_DIR';
/** What the plugin folder needs; the rest of the package (typings, tests) stays behind. */
const PLUGIN_FILES = ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.ts', 'hooks/runner.ts', 'hooks/protocol.ts', 'README.md'];

interface EnvEntry {
  name: string;
  value: string;
}

export function installedPluginDir(): string {
  return path.join(os.homedir(), '.claude', 'itemizer', 'plugin');
}

function readEnv(): EnvEntry[] {
  const v = vscode.workspace.getConfiguration('claudeCode').get<EnvEntry[]>(ENV_SETTING);
  return Array.isArray(v) ? v.filter(e => e && typeof e.name === 'string') : [];
}

function sameDir(a: string, b: string): boolean {
  const n = (s: string) => path.resolve(s).toLowerCase().replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a) === n(b) : path.resolve(a) === path.resolve(b);
}

export type BridgeSetup = 'notSetUp' | 'outdated' | 'ready';

export async function setupState(): Promise<BridgeSetup> {
  const dir = installedPluginDir();
  const entry = readEnv().find(e => e.name === PLUGIN_DIRS);
  const named = entry?.value.split(path.delimiter).some(d => d.trim() && sameDir(d.trim(), dir));
  if (!named || !(await exists(path.join(dir, '.claude-plugin', 'plugin.json')))) return 'notSetUp';
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
    return manifest.version === PLUGIN_VERSION ? 'ready' : 'outdated';
  } catch {
    return 'outdated';
  }
}

/** Copies the bundled plugin into place; replaces an older copy. */
export async function copyPlugin(extensionUri: vscode.Uri): Promise<string> {
  const from = path.join(extensionUri.fsPath, 'bridge-plugin');
  const to = installedPluginDir();
  const staging = `${to}.new`;
  await remove(staging);
  for (const rel of PLUGIN_FILES) {
    const src = path.join(from, rel);
    if (!(await exists(src))) continue;
    await fs.mkdir(path.dirname(path.join(staging, rel)), { recursive: true });
    await fs.copyFile(src, path.join(staging, rel));
  }
  await remove(to);
  await fs.rename(staging, to);
  return to;
}

export async function setUpBridge(extensionUri: vscode.Uri, bridgeDir: string | undefined, log: (s: string) => void): Promise<boolean> {
  const dir = installedPluginDir();
  const pick = await vscode.window.showInformationMessage(
    'Set up the Claude bridge?',
    {
      modal: true,
      detail:
        `This copies the itemizer-bridge plugin to ${dir} and adds ${PLUGIN_DIRS} to the user setting claudeCode.environmentVariables, ` +
        'so Claude tabs you open from now on load it. The plugin only acts on Claude sessions in a folder where this extension is open.\n\n' +
        'Claude tabs that are already open keep running without it: open a new Claude tab afterwards.',
    },
    'Set Up',
  );
  if (pick !== 'Set Up') return false;

  await copyPlugin(extensionUri);
  const env = readEnv().filter(e => e.name !== BRIDGE_DIR);
  const existing = env.find(e => e.name === PLUGIN_DIRS);
  if (existing) {
    const parts = existing.value.split(path.delimiter).filter(d => d.trim() && !sameDir(d.trim(), dir));
    existing.value = [...parts, dir].join(path.delimiter);
  } else {
    env.push({ name: PLUGIN_DIRS, value: dir });
  }
  if (bridgeDir) env.push({ name: BRIDGE_DIR, value: bridgeDir });
  await vscode.workspace.getConfiguration('claudeCode').update(ENV_SETTING, env, vscode.ConfigurationTarget.Global);
  log(`bridge set up: ${dir}`);

  const open = await vscode.window.showInformationMessage('Claude bridge set up. Open a new Claude tab to use it.', 'Open Claude Tab');
  if (open) await vscode.commands.executeCommand('claude-vscode.editor.open').then(undefined, () => undefined);
  return true;
}

/** Refreshes the plugin copy after an extension update, when the bridge was set up before. */
export async function refreshInstalledPlugin(extensionUri: vscode.Uri, log: (s: string) => void): Promise<void> {
  if ((await setupState()) !== 'outdated') return;
  await copyPlugin(extensionUri);
  log('bridge plugin updated; new Claude tabs use the new version');
}

export async function removeBridge(log: (s: string) => void): Promise<void> {
  const dir = installedPluginDir();
  const env = readEnv()
    .filter(e => e.name !== BRIDGE_DIR)
    .map(e => (e.name === PLUGIN_DIRS ? { ...e, value: e.value.split(path.delimiter).filter(d => d.trim() && !sameDir(d.trim(), dir)).join(path.delimiter) } : e))
    .filter(e => !(e.name === PLUGIN_DIRS && e.value === ''));
  await vscode.workspace.getConfiguration('claudeCode').update(ENV_SETTING, env, vscode.ConfigurationTarget.Global);
  await remove(dir);
  log('bridge removed');
  void vscode.window.showInformationMessage('Claude bridge removed. Claude tabs opened from now on run without it.');
}
