import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { type HostFile, PROTOCOL, bridgePaths } from '../../../bridge-plugin/hooks/protocol';
import { remove, writeJsonAtomic } from './fsutil';

/** The bridge folder: the setting, else ~/.claude/itemizer/v1. Native separators. */
export function bridgeRoot(): string {
  const configured = vscode.workspace.getConfiguration('claudeItemizer').get<string>('bridgeDirectory')?.trim();
  if (configured) return path.resolve(configured.replace(/^~(?=$|[\\/])/, os.homedir()));
  return path.join(os.homedir(), '.claude', 'itemizer', 'v1');
}

export function nativePaths(root = bridgeRoot()) {
  const p = bridgePaths(root);
  const n = (s: string) => path.normalize(s);
  return {
    root: n(p.root),
    hosts: n(p.hosts),
    host: (id: string) => n(p.host(id)),
    sessions: n(p.sessions),
    session: (sid: string) => n(p.session(sid)),
    presence: (sid: string) => n(p.presence(sid)),
    inboxBatch: (sid: string, b: string) => n(p.inboxBatch(sid, b)),
    control: (sid: string) => n(p.control(sid)),
    outbox: (sid: string) => n(p.outbox(sid)),
    outboxBatch: (sid: string, b: string) => n(p.outboxBatch(sid, b)),
    claims: n(p.claims),
    claim: (nonce: string) => n(p.claim(nonce)),
    claimTaken: (nonce: string) => n(`${p.claims}/${nonce}.taken.json`),
  };
}

export type NativePaths = ReturnType<typeof nativePaths>;

export function workspaceFolders(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
}

/**
 * Tells bridge plugins which folders have an Itemizer window open, so a Claude
 * session in one of them wakes up and reports itself.
 */
export class HostHeartbeat implements vscode.Disposable {
  readonly hostId = `h${process.pid}${Math.random().toString(36).slice(2, 8)}`;
  private timer: NodeJS.Timeout | undefined;
  private file: string | undefined;

  constructor(private readonly log: (s: string) => void) {}

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), 3_000);
  }

  async beat(): Promise<void> {
    const folders = workspaceFolders();
    const file = nativePaths().host(this.hostId);
    if (this.file && this.file !== file) await remove(this.file);
    this.file = file;
    const host: HostFile = { protocol: PROTOCOL, hostId: this.hostId, workspaceFolders: folders, lastSeen: Date.now() };
    await writeJsonAtomic(file, host).catch(err => this.log(`heartbeat failed: ${String(err)}`));
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.file) void remove(this.file);
  }
}
