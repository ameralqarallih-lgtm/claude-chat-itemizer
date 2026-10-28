import * as path from 'node:path';
import * as vscode from 'vscode';

import { type Presence, PRESENCE_TTL_MS, PROTOCOL, isWithin } from '../../../bridge-plugin/hooks/protocol';
import type { SessionView } from '../shared/messages';
import { listDir, readJson, remove } from './fsutil';
import { nativePaths, workspaceFolders } from './host';

const STALE_FOLDER_MS = 24 * 60 * 60 * 1000;

/** The live Claude sessions in this workspace that run the bridge plugin. */
export class SessionRegistry implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private sessions: SessionView[] = [];
  private presences = new Map<string, Presence>();
  private lastGc = 0;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** When any presence for this workspace was last seen, live or not: tells "never connected" from "closed". */
  everSeen = false;

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 2_000);
  }

  list(): SessionView[] {
    return this.sessions;
  }

  get(sessionId: string): SessionView | undefined {
    return this.sessions.find(s => s.sessionId === sessionId);
  }

  presence(sessionId: string): Presence | undefined {
    return this.presences.get(sessionId);
  }

  /** Sessions a submission can go to: compatible and shown in a tab. */
  targetable(): SessionView[] {
    return this.sessions.filter(s => s.isCompatible && s.hasTab);
  }

  /**
   * The chat to Quick-submit to: the most recently used one, preferring
   * chats that already have a conversation, then idle ones.
   */
  mostRecentlyActive(): SessionView | undefined {
    const usable = this.targetable();
    const by = (list: SessionView[]) => [...list].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    const used = usable.filter(s => s.turns > 0);
    return by(used.filter(s => s.state === 'idle')) ?? by(used) ?? by(usable.filter(s => s.state === 'idle')) ?? by(usable);
  }

  async refresh(): Promise<void> {
    const p = nativePaths();
    const now = Date.now();
    const folders = workspaceFolders();
    const next: SessionView[] = [];
    const presences = new Map<string, Presence>();
    for (const sid of await listDir(p.sessions)) {
      const pr = await readJson<Presence>(p.presence(sid), 1);
      if (!pr || typeof pr.sessionId !== 'string') continue;
      if (!folders.some(f => isWithin(pr.cwd, f))) continue;
      this.everSeen = true;
      presences.set(pr.sessionId, pr);
      const live = !pr.ended && now - pr.lastSeen < PRESENCE_TTL_MS;
      if (now - this.lastGc > 60_000 && (pr.ended || now - pr.lastSeen > STALE_FOLDER_MS) && now - pr.lastSeen > 60_000) {
        await remove(path.dirname(p.presence(sid)));
        continue;
      }
      if (!live) continue;
      next.push({
        sessionId: pr.sessionId,
        cwd: pr.cwd,
        model: pr.model,
        state: pr.state,
        turns: pr.turns,
        firstPrompt: pr.firstPrompt,
        title: pr.title,
        lastActivityAt: pr.lastActivityAt ?? pr.startedAt,
        pluginVersion: pr.pluginVersion,
        isCompatible: pr.protocol === PROTOCOL,
        hasTab: true,
      });
    }
    if (now - this.lastGc > 60_000) this.lastGc = now;
    // Only trust "no surface" when some session in this workspace does report one.
    const surfacesMeaningful = [...presences.values()].some(pr => !pr.ended && (pr.surfaces?.length ?? 0) > 0);
    for (const s of next) {
      const surfaces = presences.get(s.sessionId)?.surfaces;
      s.hasTab = !surfacesMeaningful || !Array.isArray(surfaces) || surfaces.length > 0;
    }
    next.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    this.presences = presences;
    const before = JSON.stringify(this.sessions);
    this.sessions = next;
    if (JSON.stringify(next) !== before) this.changed.fire();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}
