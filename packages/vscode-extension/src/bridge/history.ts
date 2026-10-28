// Earlier Claude chats of this workspace, read from Claude Code's own
// transcripts (~/.claude/projects/<project>/<session id>.jsonl), so Send to
// can offer chats that are closed, or restored but not started yet. Picking
// one reopens it in a Claude tab (the coordinator does that).

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { parseTranscript, projectDirName } from '../shared/transcript';
import { workspaceFolders } from './host';

export interface PastChat {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  /** When the transcript last changed: when the chat was last used. */
  lastUsedAt: number;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 512 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CHATS = 25;
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

async function readEdges(file: string, size: number): Promise<{ head: string; tail: string }> {
  const fh = await fs.open(file, 'r');
  try {
    const headLen = Math.min(size, HEAD_BYTES);
    const head = Buffer.alloc(headLen);
    await fh.read(head, 0, headLen, 0);
    if (size <= HEAD_BYTES) return { head: head.toString('utf8'), tail: head.toString('utf8') };
    const tailLen = Math.min(size, TAIL_BYTES);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    return { head: head.toString('utf8'), tail: tail.toString('utf8') };
  } finally {
    await fh.close();
  }
}

export class ChatHistory implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private chats: PastChat[] = [];
  private readonly cache = new Map<string, { mtimeMs: number; size: number; chat: PastChat }>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 15_000);
  }

  list(): PastChat[] {
    return this.chats;
  }

  get(sessionId: string): PastChat | undefined {
    return this.chats.find(c => c.sessionId === sessionId);
  }

  private async projectDirs(): Promise<string[]> {
    const root = path.join(claudeHome(), 'projects');
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch {
      return [];
    }
    const wanted = new Set(workspaceFolders().map(f => projectDirName(f).toLowerCase()));
    return names.filter(n => wanted.has(n.toLowerCase())).map(n => path.join(root, n));
  }

  async refresh(): Promise<void> {
    const now = Date.now();
    const next: PastChat[] = [];
    for (const dir of await this.projectDirs()) {
      let names: string[] = [];
      try {
        names = (await fs.readdir(dir)).filter(n => SESSION_FILE.test(n));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        let st;
        try {
          st = await fs.stat(file);
        } catch {
          continue;
        }
        if (now - st.mtimeMs > MAX_AGE_MS || st.size === 0) continue;
        const cached = this.cache.get(file);
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          next.push(cached.chat);
          continue;
        }
        try {
          const { head, tail } = await readEdges(file, st.size);
          const info = parseTranscript(head, tail);
          if (!info.firstPrompt && !info.title) continue; // never used
          const chat: PastChat = { sessionId: name.slice(0, -6), ...info, lastUsedAt: st.mtimeMs };
          this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, chat });
          next.push(chat);
        } catch {
          // being written right now: next pass
        }
      }
    }
    next.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const list = next.slice(0, MAX_CHATS);
    const before = JSON.stringify(this.chats);
    this.chats = list;
    if (JSON.stringify(list) !== before) this.changed.fire();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}
