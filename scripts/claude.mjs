#!/usr/bin/env node
// Runs the Claude Code CLI with the given arguments. Looks for, in order:
// $CLAUDE_BIN, `claude` on PATH, then the newest binary bundled with the
// Claude Code VS Code extension.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  const exts = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(exts)) return undefined;
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const found = readdirSync(exts)
    .filter(d => d.startsWith('anthropic.claude-code-'))
    .map(d => join(exts, d, 'resources', 'native-binary', bin))
    .filter(existsSync)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return found[0];
}

const claude = findClaude();
if (!claude) {
  console.error('Claude Code CLI not found. Install it, or set CLAUDE_BIN to its path.');
  process.exit(2);
}
const r = spawnSync(claude, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
