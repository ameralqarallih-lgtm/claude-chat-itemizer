import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';

import {
  type BatchFile,
  type BatchItem,
  type ClaimFile,
  type ControlFile,
  type ItemRun,
  type StatusFile,
  type SubmitMode,
  PRESENCE_TTL_MS,
  PROTOCOL,
  TERMINAL_STATUSES,
} from '../../../bridge-plugin/hooks/protocol';
import type { AttachmentStore } from '../attachments';
import { exists, readJson, remove, writeJsonAtomic } from '../bridge/fsutil';
import { type NativePaths, nativePaths } from '../bridge/host';
import type { ChatHistory } from '../bridge/history';
import type { SessionRegistry } from '../bridge/sessions';
import type { RunOptions, RunTarget, RunView } from '../shared/messages';
import {
  type ItemizerState,
  batchSettings,
  combinedText,
  displayTitle,
  markSubmitted,
  newId,
  promptText,
  withAttachmentNote,
  resolveSettings,
  strictestPolicy,
} from '../shared/model';
import type { Store } from '../store';

const RUNS_KEY = 'itemizer.runs.v1';
const KEEP_RUNS = 30;
const CLAIM_TTL_MS = 30 * 60 * 1000;

/** One batch file delivered to one Claude session. */
interface Part {
  batchId: string;
  /** Indexes into the run's items. */
  items: number[];
  sessionId?: string;
  claimNonce?: string;
  phase: 'pending' | 'launching' | 'claimable' | 'delivered' | 'done';
}

interface RunRecord extends RunView {
  options: RunOptions;
  parts: Part[];
  /** The batch entries, frozen at submit time, in run item order. */
  entries: BatchItem[];
}

export class UserError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class RunCoordinator implements vscode.Disposable {
  private runs: RunRecord[];
  private timer: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  /** Session ids a launch already took, so two launches never claim the same new tab. */
  private readonly claimedSessions = new Set<string>();
  private pressEnterFallback = false;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly store: Store,
    private readonly attachments: AttachmentStore,
    private readonly sessions: SessionRegistry,
    private readonly history: ChatHistory,
    private readonly hostId: string,
    private readonly log: (s: string) => void,
  ) {
    this.runs = memento.get<RunRecord[]>(RUNS_KEY, []);
    for (const r of this.runs) {
      if (r.state !== 'running' && r.state !== 'starting') continue;
      for (const p of r.parts) {
        if (p.phase === 'pending' || p.phase === 'launching') {
          p.phase = 'done';
          this.setItems(r, p, { status: 'unknown', reason: 'VS Code reloaded before this conversation opened.' });
        }
      }
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.poll(), 1_000);
  }

  views(): RunView[] {
    return this.runs.map(({ parts: _p, entries: _e, options: _o, ...view }) => view);
  }

  /** Attachment files that unfinished runs still need. */
  filesInUse(): Set<string> {
    const out = new Set<string>();
    for (const r of this.runs) {
      if (r.state !== 'running' && r.state !== 'starting') continue;
      for (const e of r.entries) for (const a of e.attachments) out.add(a.absPath.split(/[\\/]/).pop()!);
    }
    return out;
  }

  // ---------- starting ----------

  async submit(itemIds: string[], mode: SubmitMode, target: RunTarget, options: RunOptions, quick = false): Promise<string> {
    const state = this.store.state;
    const ids = itemIds.filter(id => state.items[id]);
    if (ids.length === 0) throw new UserError('Select at least one chat item.');
    const cfg = vscode.workspace.getConfiguration('claudeItemizer');
    const allowLoosening = cfg.get<boolean>('allowLooseningPolicies', false);
    const settleMs = cfg.get<number>('settleMs', 800);

    if (target.kind === 'prefill') return this.prefill(ids, mode, options);

    const entries = this.buildEntries(state, ids, mode, options, quick, allowLoosening);
    const runId = newId('r');
    const parts: Part[] =
      mode === 'newConversationPerItem'
        ? entries.map((_, i) => ({ batchId: `${runId}-${i}`, items: [i], phase: 'pending' }))
        : [{ batchId: runId, items: entries.map((_, i) => i), phase: 'pending' }];

    let sessionId: string | undefined;
    if (mode !== 'newConversationPerItem' && target.kind !== 'newTab') {
      const picked = this.store.state.view.targetSessionId;
      const wanted = target.kind === 'session' ? target.sessionId : picked;
      let s = wanted ? this.sessions.targetable().find(x => x.sessionId === wanted) : this.sessions.mostRecentlyActive();
      if (!s && wanted && this.history.get(wanted)) {
        // An earlier chat that is not running: reopen it, then send.
        const reopened = await this.reopen(wanted);
        s = this.sessions.targetable().find(x => x.sessionId === reopened);
      }
      if (!s && target.kind === 'active' && picked) {
        throw new UserError('The chat picked in “Send to” is closed and could not be reopened. Pick another chat there, or choose “Most recently used chat”.', 'targetGone');
      }
      if (!s) {
        throw new UserError(
          target.kind === 'active' ? 'No Claude chat in this workspace is connected to the bridge.' : 'That Claude chat is no longer connected.',
          'noSession',
        );
      }
      sessionId = s.sessionId;
    }

    const run: RunRecord = {
      id: runId,
      createdAt: Date.now(),
      mode,
      quick,
      state: 'starting',
      options,
      entries,
      parts,
      items: entries.map(e => ({ itemIds: e.itemIds, title: e.title ?? '', run: { seq: e.seq, status: 'queued' } })),
    };
    this.runs.unshift(run);
    this.runs = this.runs.slice(0, KEEP_RUNS);
    this.save();

    const fileFor = (p: Part): BatchFile => ({
      protocol: PROTOCOL,
      batchId: p.batchId,
      hostId: this.hostId,
      createdAt: run.createdAt,
      mode,
      options: { stopOnError: options.stopOnError, settleMs },
      items: p.items.map((i, seq) => ({ ...entries[i]!, seq })),
    });

    if (sessionId) {
      await this.deliver(run, parts[0]!, sessionId, fileFor(parts[0]!));
    } else {
      void this.launchAll(run, fileFor);
    }
    run.state = 'running';
    this.save();
    return runId;
  }

  private buildEntries(state: ItemizerState, ids: string[], mode: SubmitMode, options: RunOptions, quick: boolean, allowLoosening: boolean): BatchItem[] {
    const att = (id: string) => {
      const delivery = resolveSettings(state, id).attachmentDelivery.value;
      return state.items[id]!.attachments.map(a => this.attachments.toBatch(a, delivery));
    };
    if (mode === 'combined') {
      const items = ids.map(id => state.items[id]!);
      const from = options.combinedFrom === 'first' ? resolveSettings(state, ids[0]!) : resolveSettings({ ...state, items: {} }, '');
      const settings = quick ? { toolPolicy: 'inherit' as const, quick: true } : batchSettings(from, allowLoosening);
      if (!quick) settings.toolPolicy = strictestPolicy(ids.map(id => batchSettings(resolveSettings(state, id), allowLoosening).toolPolicy));
      return [
        {
          seq: 0,
          itemIds: ids,
          title: `${ids.length} items in one message`,
          text: withAttachmentNote(combinedText(items), items.flatMap(i => i.attachments.map(x => x.name))),
          settings,
          attachments: ids.flatMap(att),
        },
      ];
    }
    return ids.map((id, seq) => {
      const item = state.items[id]!;
      return {
        seq,
        itemIds: [id],
        title: displayTitle(item),
        text: withAttachmentNote(promptText(item, options.titleAsHeading), item.attachments.map(x => x.name)),
        settings: quick ? { toolPolicy: 'inherit', quick: true } : batchSettings(resolveSettings(state, id), allowLoosening),
        attachments: att(id),
      };
    });
  }

  /** No bridge: open Claude tabs with the text typed in; the person presses Enter. */
  private async prefill(ids: string[], mode: SubmitMode, options: RunOptions): Promise<string> {
    const state = this.store.state;
    const texts =
      mode === 'combined' ? [combinedText(ids.map(id => state.items[id]!))] : ids.map(id => promptText(state.items[id]!, options.titleAsHeading));
    for (const text of mode === 'sequential' ? [texts.join('\n\n---\n\n')] : texts) {
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, text);
    }
    void vscode.window.showInformationMessage(
      'The text is typed into a new Claude tab. Press Enter there to send it. Prefill carries no per-item settings or attachments.',
    );
    return '';
  }

  private async deliver(run: RunRecord, part: Part, sessionId: string, file: BatchFile): Promise<void> {
    await writeJsonAtomic(this.paths().inboxBatch(sessionId, part.batchId), file);
    part.sessionId = sessionId;
    part.phase = 'delivered';
    this.claimedSessions.add(sessionId);
    for (const i of part.items) run.items[i]!.sessionId = sessionId;
    this.log(`delivered ${part.batchId} (${part.items.length} item(s)) to ${sessionId}`);
    this.save();
  }

  /** New conversation per item (or one new tab): opens tabs and hands each its batch. */
  private async launchAll(run: RunRecord, fileFor: (p: Part) => BatchFile): Promise<void> {
    const limit = Math.max(1, Math.min(4, run.options.concurrency || 1));
    const stopped = () => run.state !== 'running' && run.state !== 'starting';
    for (const part of run.parts) {
      while (this.inFlight(run) >= limit) {
        if (stopped()) return;
        await sleep(1_000);
      }
      if (stopped() || part.phase !== 'pending') continue;
      part.phase = 'launching';
      this.save();
      try {
        const strategy = vscode.workspace.getConfiguration('claudeItemizer').get<string>('newConversation.strategy', 'openAndClaim');
        const sessionId = strategy === 'openAndClaim' && !this.pressEnterFallback ? await this.openAndClaim() : undefined;
        // Cancelled while the tab opened: cancel() already closed this part.
        if ((part.phase as Part['phase']) !== 'launching') continue;
        if (sessionId) await this.deliver(run, part, sessionId, fileFor(part));
        else await this.offerClaim(run, part, fileFor(part));
      } catch (err) {
        part.phase = 'done';
        this.setItems(run, part, { status: 'failed', error: `Could not open a Claude tab: ${String(err)}` });
        this.save();
      }
    }
  }

  private inFlight(run: RunRecord): number {
    return run.parts.filter(p => p.phase === 'launching' || p.phase === 'claimable' || p.phase === 'delivered').length;
  }

  /**
   * Opens an earlier chat in a Claude tab and waits for its session to report
   * in. Resolves the session id it runs under: the same one when Claude Code
   * resumes in place, else the new session that carries its history.
   */
  private async reopen(sessionId: string): Promise<string> {
    const chat = this.history.get(sessionId);
    await this.sessions.refresh();
    const known = new Set(this.sessions.targetable().map(s => s.sessionId));
    const t0 = Date.now();
    this.log(`reopening chat ${sessionId}`);
    await vscode.commands.executeCommand('claude-vscode.editor.open', sessionId).then(undefined, err => {
      throw new UserError(`Could not open that chat in Claude: ${String(err)}`);
    });
    const timeoutMs = 1000 * vscode.workspace.getConfiguration('claudeItemizer').get<number>('newConversation.timeoutSeconds', 25);
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1_000);
      await this.sessions.refresh();
      const live = this.sessions.targetable();
      const same = live.find(s => s.sessionId === sessionId);
      if (same) return same.sessionId;
      const resumed = live.find(
        s => !known.has(s.sessionId) && s.turns > 0 && !!chat?.firstPrompt && s.firstPrompt === chat.firstPrompt,
      );
      if (resumed) return resumed.sessionId;
    }
    throw new UserError('The chat opened in Claude but did not connect to the bridge in time. Send again once its tab has loaded.', 'targetGone');
  }

  /** Opens a new Claude tab and waits for its session to report in. */
  private async openAndClaim(): Promise<string | undefined> {
    await this.sessions.refresh();
    // Only sessions a tab shows count as known: the spare VS Code keeps warm
    // becomes the new tab's session, and a new spare appears in its place.
    const known = new Set(this.sessions.targetable().map(s => s.sessionId));
    const t0 = Date.now();
    await vscode.commands.executeCommand('claude-vscode.editor.open');
    const timeoutMs = 1000 * vscode.workspace.getConfiguration('claudeItemizer').get<number>('newConversation.timeoutSeconds', 25);
    while (Date.now() - t0 < timeoutMs) {
      await sleep(1_000);
      await this.sessions.refresh();
      const surfacesKnown = this.sessions.list().some(s => !s.hasTab);
      const fresh = this.sessions
        .targetable()
        .filter(s => !known.has(s.sessionId) && !this.claimedSessions.has(s.sessionId) && s.turns === 0)
        // Without the surface signal, only a process started after the open can be the new tab's.
        .find(s => surfacesKnown || (this.sessions.presence(s.sessionId)?.startedAt ?? 0) >= t0 - 2_000);
      if (fresh) {
        this.claimedSessions.add(fresh.sessionId);
        return fresh.sessionId;
      }
    }
    this.pressEnterFallback = true;
    this.log('a new Claude tab did not report in; switching to press-Enter for new conversations');
    void vscode.window.showWarningMessage(
      'The new Claude tab did not connect to the bridge in time. Each new conversation now opens with /itemizer-run typed in: press Enter in that tab to start it.',
    );
    return undefined;
  }

  private async offerClaim(run: RunRecord, part: Part, file: BatchFile): Promise<void> {
    const nonce = newId('n');
    const claim: ClaimFile = { protocol: PROTOCOL, nonce, expiresAt: Date.now() + CLAIM_TTL_MS, batch: file };
    await writeJsonAtomic(this.paths().claim(nonce), claim);
    part.claimNonce = nonce;
    part.phase = 'claimable';
    this.save();
    await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, `/itemizer-run ${nonce}`);
  }

  // ---------- following ----------

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      let changed = false;
      for (const run of this.runs) {
        if (run.state !== 'running') continue;
        for (const part of run.parts) changed = (await this.pollPart(run, part)) || changed;
        changed = this.finishIfDone(run) || changed;
      }
      if (changed) this.save();
    } finally {
      this.polling = false;
    }
  }

  private async pollPart(run: RunRecord, part: Part): Promise<boolean> {
    const p = this.paths();
    if (part.phase === 'claimable' && part.claimNonce) {
      const taken = await readJson<{ sessionId: string }>(p.claimTaken(part.claimNonce));
      if (taken?.sessionId) {
        part.sessionId = taken.sessionId;
        part.phase = 'delivered';
        for (const i of part.items) run.items[i]!.sessionId = taken.sessionId;
        await remove(p.claim(part.claimNonce));
        await remove(p.claimTaken(part.claimNonce));
        return true;
      }
      if (!(await exists(p.claim(part.claimNonce)))) {
        part.phase = 'done';
        this.setItems(run, part, { status: 'cancelled', reason: 'The claim was removed.' });
        return true;
      }
      return false;
    }
    if (part.phase !== 'delivered' || !part.sessionId) return false;

    const status = await readJson<StatusFile>(p.outboxBatch(part.sessionId, part.batchId));
    let changed = false;
    if (status) {
      for (const r of status.items) {
        const idx = part.items[r.seq];
        if (idx === undefined) continue;
        const view = run.items[idx]!;
        if (JSON.stringify(view.run) !== JSON.stringify({ ...r, seq: view.run.seq })) {
          view.run = { ...r, seq: view.run.seq };
          changed = true;
          if (r.status === 'done') this.store.update(s => markSubmitted(s, view.itemIds, r.endedAt ?? Date.now()));
        }
      }
      if (status.state !== 'running') {
        part.phase = 'done';
        await this.cleanUp(part);
        return true;
      }
    }

    // A session that closed with the part unfinished will not finish it.
    const presence = this.sessions.presence(part.sessionId);
    const gone = presence ? !!presence.ended || Date.now() - presence.lastSeen > PRESENCE_TTL_MS * 2 : !this.sessions.get(part.sessionId);
    if (gone && !(await this.recentlyDelivered(part))) {
      part.phase = 'done';
      this.setItems(run, part, { status: 'unknown', reason: 'The Claude session closed before this item finished.' }, true);
      run.state = 'stalled';
      run.detail = 'A Claude chat closed during the run.';
      return true;
    }
    return changed;
  }

  /** Grace period: a just-delivered batch whose presence has not been read yet is not "gone". */
  private async recentlyDelivered(part: Part): Promise<boolean> {
    try {
      const { mtimeMs } = await fs.stat(this.paths().inboxBatch(part.sessionId!, part.batchId));
      return Date.now() - mtimeMs < 15_000;
    } catch {
      return false;
    }
  }

  private finishIfDone(run: RunRecord): boolean {
    if (run.state !== 'running') return false;
    if (!run.parts.every(p => p.phase === 'done')) return false;
    const statuses = run.items.map(i => i.run.status);
    run.state = statuses.some(s => s === 'failed' || s === 'unknown' || s === 'interrupted')
      ? 'failed'
      : statuses.some(s => s === 'cancelled')
        ? 'cancelled'
        : 'completed';
    if (run.options.hideAfter && statuses.some(s => s === 'done')) {
      this.store.update(s => ({ ...s, view: { ...s.view, hideSubmitted: true } }));
    }
    return true;
  }

  private async cleanUp(part: Part): Promise<void> {
    if (!part.sessionId) return;
    const p = this.paths();
    await remove(p.inboxBatch(part.sessionId, part.batchId));
    await remove(p.outboxBatch(part.sessionId, part.batchId));
  }

  // ---------- control ----------

  async cancel(runId: string, abortCurrent: boolean): Promise<void> {
    const run = this.runs.find(r => r.id === runId);
    if (!run || (run.state !== 'running' && run.state !== 'starting')) return;
    for (const part of run.parts) {
      if (part.phase === 'pending' || part.phase === 'launching') {
        part.phase = 'done';
        this.setItems(run, part, { status: 'cancelled', reason: 'Cancelled.' });
      } else if (part.phase === 'claimable' && part.claimNonce) {
        await remove(this.paths().claim(part.claimNonce));
        part.phase = 'done';
        this.setItems(run, part, { status: 'cancelled', reason: 'Cancelled.' });
      } else if (part.phase === 'delivered' && part.sessionId) {
        await this.sendControl(part.sessionId, abortCurrent ? 'abortCurrent' : 'cancel', part.batchId);
      }
    }
    if (run.parts.every(p => p.phase === 'done')) this.finishIfDone(run);
    this.save();
  }

  private async sendControl(sessionId: string, kind: 'cancel' | 'abortCurrent', batchId: string): Promise<void> {
    const file = this.paths().control(sessionId);
    const current = (await readJson<ControlFile>(file)) ?? { seq: 0, commands: [] };
    const seq = Math.max(current.seq, ...current.commands.map(c => c.seq), Date.now());
    const commands = [...current.commands.slice(-20), { seq: seq + 1, kind, batchId }];
    await writeJsonAtomic(file, { seq: seq + 1, commands });
  }

  dismiss(runId: string): void {
    const run = this.runs.find(r => r.id === runId);
    if (!run || run.state === 'running' || run.state === 'starting') return;
    this.runs = this.runs.filter(r => r.id !== runId);
    this.save();
  }

  /** Removes every run that is no longer running from the history. */
  clearFinished(): void {
    const before = this.runs.length;
    this.runs = this.runs.filter(r => r.state === 'running' || r.state === 'starting');
    if (this.runs.length !== before) this.save();
  }

  // ---------- helpers ----------

  private setItems(run: RunRecord, part: Part, patch: Partial<ItemRun>, onlyUnfinished = false): void {
    for (const i of part.items) {
      const view = run.items[i]!;
      if (onlyUnfinished && TERMINAL_STATUSES.includes(view.run.status)) continue;
      view.run = { ...view.run, ...patch, endedAt: Date.now() };
    }
  }

  private paths(): NativePaths {
    return nativePaths();
  }

  private save(): void {
    void this.memento.update(RUNS_KEY, this.runs);
    this.changed.fire();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.changed.dispose();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
