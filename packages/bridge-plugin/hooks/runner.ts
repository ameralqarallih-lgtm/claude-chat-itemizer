// The bridge's state machine. It knows nothing of `$`: register.ts hands it
// Ports, so the unit tests drive it with an in-memory file system and clock.
//
// One item runs at a time per session. The runner submits an item only while
// the session is idle, binds the next turn.start with the same text to it,
// and finishes it on that turn's turn.complete.
//
// Attachment context: a plugin's own $.prompt.submit made from its poll loop
// does not pass through the plugin's own prompt.submit hook (Claude Code
// 2.1.311), and a row appended at turn.start can land after the turn's first
// model request (seen live in VS Code). So the blocks are appended as a hidden
// user row just before the submit, while the session is idle: the model reads
// them right ahead of the prompt. promptContext stays for a build that routes
// our own submission through our hook.

import {
  type BatchAttachment,
  type BatchFile,
  type BatchItem,
  type BatchItemSettings,
  type ClaimFile,
  type ControlFile,
  type EffortLevel,
  type HostFile,
  type ItemRun,
  type ItemRunStatus,
  type Presence,
  type StatusFile,
  HOST_TTL_MS,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  PROTOCOL,
  TERMINAL_STATUSES,
  attachmentBlock,
  bridgePaths,
  effortSupported,
  isBatchFile,
  isSafeId,
  isWithin,
  normalizePath,
  parseJson,
  pathAttachmentsBlock,
  preview,
} from './protocol.ts';

export interface Ports {
  now(): Promise<number>;
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  list(path: string): Promise<{ name: string; kind: string }[]>;
  exists(path: string): Promise<boolean>;
  /** `$.prompt.submit({ text, asUser: true })`; resolves once the turn starts. */
  submit(text: string): Promise<{ drop?: string }>;
  abort(turnId: string): Promise<void>;
  /** `$.session.append` of hidden user-role text rows the model reads; resolves false when refused. */
  append(blocks: string[]): Promise<boolean>;
  log(text: string): void;
  status(text: string | undefined): void;
  session(): Promise<{ id: string; cwd: string; model?: string; surfaces?: string[] }>;
  /** What the conversation held before this module loaded: a reload or a resumed chat is not new. */
  history?(): Promise<{ turns: number; firstPrompt?: string }>;
}

export interface RunnerOptions {
  /** How often a dormant runner looks for an Itemizer window on its folder. */
  hostCheckMs: number;
  presenceMs: number;
  defaultSettleMs: number;
}

const DEFAULTS: RunnerOptions = { hostCheckMs: 5_000, presenceMs: 2_000, defaultSettleMs: 800 };

export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

interface Active {
  batchId: string;
  seq: number;
  text: string;
  blocks: string[];
  settings: BatchItemSettings;
  phase: 'submitting' | 'entered' | 'running';
  /** Whether `blocks` reached the model yet (prompt context, or a hidden row at turn start). */
  contextDelivered: boolean;
  turnId?: string;
  /** Normalized absolute paths Claude may Read without asking during this item. */
  allowReads: Set<string>;
  warnings: string[];
  requestedModel?: string;
}

interface Batch {
  file: BatchFile;
  status: StatusFile;
  cancelled: boolean;
}

export interface TurnCompleteArgs {
  turnId: string;
  agentId?: string;
  reason: string;
  answer: string;
  model?: string;
}

export interface ToolVerdict {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

export class Runner {
  private readonly paths;
  private readonly opts: RunnerOptions;
  private sessionId = '';
  private cwd = '';
  private model: string | undefined;
  private surfaces: string[] | undefined;
  private startedAt = 0;
  private active = false;
  private ended = false;
  private ticking = false;
  private lastHostCheck = -Infinity;
  private lastPresence = -Infinity;
  private presenceSeq = 0;
  private busy = false;
  private turns = 0;
  private firstPrompt: string | undefined;
  private title: string | undefined;
  private lastActivityAt: number | undefined;
  private lastTurnEndedAt = -Infinity;
  private controlSeq = 0;
  private readonly batches = new Map<string, Batch>();
  private readonly order: string[] = [];
  private current: Active | undefined;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly ports: Ports,
    root: string,
    opts: Partial<RunnerOptions> = {},
  ) {
    this.paths = bridgePaths(root);
    this.opts = { ...DEFAULTS, ...opts };
  }

  get sessionIdForTests(): string {
    return this.sessionId;
  }

  isActive(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    const s = await this.ports.session();
    this.sessionId = s.id;
    this.cwd = s.cwd;
    this.model = s.model;
    this.startedAt = await this.ports.now();
    await this.seedFromHistory();
  }

  /** Claude Code's title for the conversation, from a hook that carries it. */
  setTitle(title: string | undefined): void {
    const t = title?.trim();
    if (t && t !== this.title) {
      this.title = preview(t, 80);
      this.lastPresence = -Infinity; // report it on the next tick
    }
  }

  private async seedFromHistory(): Promise<void> {
    const h = await this.ports.history?.().catch(() => undefined);
    if (!h) return;
    this.turns = Math.max(this.turns, h.turns);
    if (this.firstPrompt === undefined && h.firstPrompt?.trim()) this.firstPrompt = preview(h.firstPrompt, 80);
  }

  /** One pass of the poll loop; register.ts calls it about once a second. */
  async tick(): Promise<void> {
    if (this.ended || this.ticking) return;
    this.ticking = true;
    try {
      const now = await this.ports.now();
      const s = await this.ports.session();
      this.model = s.model;
      this.surfaces = s.surfaces;
      if (s.id !== this.sessionId) await this.onSessionChanged(s.id, s.cwd, now);

      if (!this.active) {
        if (now - this.lastHostCheck < this.opts.hostCheckMs) return;
        this.lastHostCheck = now;
        const ownInbox = (await this.inboxBatchNames()).length > 0;
        if (!ownInbox && !(await this.hostWantsUs(now))) return;
        this.active = true;
        this.ports.log(`active for ${this.cwd}`);
        await this.recover();
      }

      if (now - this.lastPresence >= this.opts.presenceMs) await this.writePresence(now);
      // Inbox first: a cancel written right after its batch must find the batch.
      await this.scanInbox();
      await this.readControl();
      await this.maybeStartNext(now);
    } finally {
      this.ticking = false;
    }
  }

  // ---------- hooks ----------

  /** prompt.submit: the hidden context for our own submission, else undefined. */
  promptContext(text: string, origin: { kind: string; name?: string }): string[] | undefined {
    const c = this.current;
    if (!c || c.phase !== 'submitting' || c.contextDelivered) return undefined;
    if (origin.kind !== 'plugin' || origin.name !== PLUGIN_NAME) return undefined;
    if (!sameText(text, c.text)) return undefined;
    c.phase = 'entered';
    c.contextDelivered = true;
    return c.blocks;
  }

  async onTurnStart(turnId: string, text: string): Promise<void> {
    const now = await this.ports.now();
    this.busy = true;
    this.turns += 1;
    this.lastActivityAt = now;
    if (this.firstPrompt === undefined && text.trim() !== '') this.firstPrompt = preview(text, 80);

    const c = this.current;
    if (c && c.turnId === undefined) {
      let bound = false;
      if (sameText(text, c.text)) bound = true;
      else if (c.phase === 'entered') {
        // Another plugin rewrote our text on its way in: the next turn is still ours.
        c.warnings.push('The prompt text was changed by another plugin; matched by order.');
        bound = true;
      }
      if (bound) {
        this.bind(c, turnId, now);
        if (!c.contextDelivered && c.blocks.length > 0) {
          c.contextDelivered = true;
          const ok = await this.ports.append(c.blocks).catch(() => false);
          if (!ok) c.warnings.push('The attachments could not be added to the conversation.');
        }
      }
    }
    if (this.active) await this.writePresence(now);
  }

  /** turn.step: the model and effort this request should use, when they differ from the session's. */
  stepOverride(turnId: string, agentId: string | undefined, sessionModel: string): { model?: string; effort?: EffortLevel } | undefined {
    const c = this.current;
    if (agentId !== undefined || !c || c.turnId !== turnId || c.settings.quick) return undefined;
    const out: { model?: string; effort?: EffortLevel } = {};
    if (c.settings.model) out.model = c.settings.model;
    const effort = c.settings.effort;
    if (effort) {
      const target = c.settings.model ?? sessionModel;
      if (effortSupported(target, effort)) out.effort = effort;
      else if (!c.warnings.some(w => w.startsWith('Effort'))) c.warnings.push(`Effort ${effort} is not supported by ${target}; the turn ran without it.`);
    }
    c.requestedModel = out.model;
    return out.model || out.effort ? out : undefined;
  }

  async onTurnComplete(args: TurnCompleteArgs): Promise<void> {
    if (args.agentId !== undefined) return;
    const now = await this.ports.now();
    this.busy = false;
    this.lastTurnEndedAt = now;
    this.lastActivityAt = now;
    const c = this.current;
    if (c && c.turnId === args.turnId) {
      const status: ItemRunStatus = args.reason === 'answer' ? 'done' : args.reason === 'aborted' ? 'interrupted' : 'failed';
      await this.finish(c, status, now, {
        reason: args.reason,
        answerPreview: preview(args.answer, 300),
        appliedModel: args.model ?? c.requestedModel,
      });
    }
    if (this.active) await this.writePresence(now);
  }

  /** Whether tool.check should resolve the call's path before asking toolDecision. */
  wantsRealPath(tool: string): boolean {
    return tool === 'Read' && this.current?.phase === 'running' && this.current.allowReads.size > 0;
  }

  /** tool.check: a verdict for the running item, or undefined to leave the engine's. */
  toolDecision(tool: string, input: unknown, realPath?: string): ToolVerdict | undefined {
    const c = this.current;
    if (!c || c.phase !== 'running') return undefined;
    const filePath = typeof (input as { file_path?: unknown })?.file_path === 'string' ? (input as { file_path: string }).file_path : undefined;

    if (tool === 'Read' && c.allowReads.size > 0) {
      const candidates = [realPath, filePath].filter((p): p is string => typeof p === 'string').map(normalizePath);
      if (candidates.some(p => c.allowReads.has(p))) return { decision: 'allow', reason: 'A file attached to this chat item.' };
    }
    if (c.settings.quick) return undefined;
    if (c.settings.toolPolicy === 'readOnly') {
      if (EDIT_TOOLS.includes(tool)) return { decision: 'deny', reason: 'This chat item is read-only (Claude Chat Itemizer): report the change instead of making it.' };
      if (tool === 'Bash') return { decision: 'ask', reason: 'This chat item is read-only (Claude Chat Itemizer). Allow this command?' };
    }
    if (c.settings.toolPolicy === 'autoAcceptEdits' && EDIT_TOOLS.includes(tool) && filePath && isWithin(realPath ?? filePath, this.cwd)) {
      return { decision: 'allow', reason: 'This chat item auto-accepts edits inside the workspace (Claude Chat Itemizer).' };
    }
    return undefined;
  }

  async onSessionEnd(reason: string): Promise<void> {
    const now = await this.ports.now();
    if (reason === 'clear') {
      await this.closeSession(now, 'cleared');
      return; // the process goes on under a new id; tick() picks it up
    }
    await this.closeSession(now, reason);
    this.ended = true;
  }

  /** /itemizer-run <nonce>: takes a batch the extension left for a new conversation. */
  async adoptClaim(nonce: string): Promise<string> {
    if (!isSafeId(nonce)) return 'Itemizer: that claim id is not valid.';
    const path = this.paths.claim(nonce);
    let claim: ClaimFile | undefined;
    try {
      claim = parseJson<ClaimFile>(await this.ports.read(path));
    } catch {
      return 'Itemizer: no such claim. It may have expired; submit the items again from the Itemizer sidebar.';
    }
    const now = await this.ports.now();
    if (!claim || !isBatchFile(claim.batch)) return 'Itemizer: the claim file could not be read.';
    if (claim.expiresAt < now) return 'Itemizer: this claim has expired; submit the items again from the Itemizer sidebar.';
    if (await this.ports.exists(joinTaken(this.paths.claims, nonce))) return 'Itemizer: this claim was already taken by another conversation.';

    await this.ports.write(joinTaken(this.paths.claims, nonce), JSON.stringify({ sessionId: this.sessionId, takenAt: now }));
    await this.ports.write(this.paths.inboxBatch(this.sessionId, claim.batch.batchId), JSON.stringify(claim.batch));
    this.active = true;
    await this.writePresence(now);
    // Not maybeStartNext: a prompt submitted from inside the command's own hook
    // would wait on the turn that hook holds. The next tick sends it.
    await this.scanInbox();
    const n = claim.batch.items.length;
    return `Itemizer: running ${n} chat item${n === 1 ? '' : 's'} in this conversation.`;
  }

  // ---------- internals ----------

  private bind(c: Active, turnId: string, now: number): void {
    c.turnId = turnId;
    c.phase = 'running';
    const b = this.batches.get(c.batchId);
    const run = b?.status.items.find(i => i.seq === c.seq);
    if (!b || !run) return;
    run.status = 'running';
    run.turnId = turnId;
    run.startedAt = run.startedAt ?? now;
    void this.writeStatus(b);
  }

  private async hostWantsUs(now: number): Promise<boolean> {
    const entries = await this.safeList(this.paths.hosts);
    for (const e of entries) {
      if (!e.name.endsWith('.json')) continue;
      const host = await this.readJson<HostFile>(`${this.paths.hosts}/${e.name}`);
      if (!host || host.protocol !== PROTOCOL || now - host.lastSeen > HOST_TTL_MS) continue;
      if (host.workspaceFolders.some(f => isWithin(this.cwd, f))) return true;
    }
    return false;
  }

  private async recover(): Promise<void> {
    const outbox = this.paths.outbox(this.sessionId);
    for (const e of await this.safeList(outbox)) {
      if (!e.name.endsWith('.json')) continue;
      const batchId = e.name.slice(0, -5);
      if (this.batches.has(batchId)) continue;
      const status = await this.readJson<StatusFile>(`${outbox}/${e.name}`);
      const file = await this.readJson<BatchFile>(this.paths.inboxBatch(this.sessionId, batchId));
      if (!status || !file || !isBatchFile(file)) continue;
      const b: Batch = { file, status, cancelled: status.state === 'cancelled' };
      this.batches.set(batchId, b);
      this.order.push(batchId);
      if (status.state !== 'running') continue;
      for (const run of status.items) {
        const item = file.items.find(i => i.seq === run.seq);
        if (run.status === 'running' && run.turnId && item && !this.current) {
          // The module reloaded mid-turn: the turn's turn.complete still comes.
          this.current = await this.prepare(file.batchId, item);
          this.current.phase = 'running';
          this.current.turnId = run.turnId;
          this.current.contextDelivered = true;
          this.busy = true;
        } else if (run.status === 'submitting' || run.status === 'running') {
          run.status = 'unknown';
          run.reason = 'The bridge restarted before this item finished. Check the chat.';
        }
      }
      this.updateBatchState(b);
      await this.writeStatus(b);
    }
  }

  private async inboxBatchNames(): Promise<string[]> {
    if (!this.sessionId) return [];
    return (await this.safeList(this.paths.inbox(this.sessionId)))
      .map(e => e.name)
      .filter(n => n.endsWith('.json') && n !== 'control.json');
  }

  private async scanInbox(): Promise<void> {
    for (const name of await this.inboxBatchNames()) {
      const batchId = name.slice(0, -5);
      if (this.batches.has(batchId) || !isSafeId(batchId)) continue;
      const file = await this.readJson<BatchFile>(this.paths.inboxBatch(this.sessionId, batchId));
      if (!file || !isBatchFile(file) || file.batchId !== batchId) continue; // half-written: next tick
      if (await this.ports.exists(this.paths.outboxBatch(this.sessionId, batchId))) {
        await this.recover();
        continue;
      }
      const items = [...file.items].sort((a, b) => a.seq - b.seq);
      const now = await this.ports.now();
      const status: StatusFile = {
        protocol: PROTOCOL,
        batchId,
        sessionId: this.sessionId,
        seq: 0,
        updatedAt: now,
        state: items.length ? 'running' : 'completed',
        items: items.map(i => ({ seq: i.seq, status: 'queued' })),
      };
      const b: Batch = { file: { ...file, items }, status, cancelled: false };
      this.batches.set(batchId, b);
      this.order.push(batchId);
      this.ports.log(`batch ${batchId}: ${items.length} item(s)`);
      await this.writeStatus(b);
    }
  }

  private async readControl(): Promise<void> {
    const control = await this.readJson<ControlFile>(this.paths.control(this.sessionId));
    if (!control || !Array.isArray(control.commands)) return;
    for (const cmd of control.commands) {
      if (cmd.seq <= this.controlSeq) continue;
      this.controlSeq = cmd.seq;
      const b = this.batches.get(cmd.batchId);
      if (!b) continue;
      if (cmd.kind === 'cancel') await this.cancelBatch(b, 'Cancelled from the Itemizer.');
      if (cmd.kind === 'abortCurrent' && this.current?.batchId === cmd.batchId && this.current.turnId) {
        await this.cancelBatch(b, 'Cancelled from the Itemizer.');
        await this.ports.abort(this.current.turnId).catch(() => undefined);
      }
    }
  }

  private async cancelBatch(b: Batch, reason: string): Promise<void> {
    b.cancelled = true;
    for (const run of b.status.items) {
      if (run.status === 'queued') {
        run.status = 'cancelled';
        run.reason = reason;
      }
    }
    this.updateBatchState(b);
    await this.writeStatus(b);
  }

  private async maybeStartNext(now: number): Promise<void> {
    if (this.current || this.busy) return;
    for (const id of this.order) {
      const b = this.batches.get(id);
      if (!b || b.status.state !== 'running' || b.cancelled) continue;
      if (now - this.lastTurnEndedAt < (b.file.options?.settleMs ?? this.opts.defaultSettleMs)) return;
      const run = b.status.items.find(r => r.status === 'queued');
      const item = run && b.file.items.find(i => i.seq === run.seq);
      if (!run || !item) continue;

      const c = await this.prepare(id, item);
      this.current = c;
      run.status = 'submitting';
      run.startedAt = now;
      if (c.warnings.length) run.warnings = [...c.warnings];
      await this.writeStatus(b);
      this.ports.status(`Itemizer: item ${item.seq + 1} of ${b.file.items.length}`);
      if (c.blocks.length > 0) {
        c.contextDelivered = true;
        const ok = await this.ports.append(c.blocks).catch(() => false);
        if (!ok) {
          c.warnings.push('The attachments could not be added to the conversation.');
          run.warnings = [...c.warnings];
        }
      }
      this.ports
        .submit(item.text)
        .then(r => {
          if (r && typeof r.drop === 'string' && this.current === c) void this.failCurrent(`The prompt was not sent: ${r.drop}`);
        })
        .catch(err => {
          if (this.current === c) void this.failCurrent(`The prompt could not be sent: ${String(err)}`);
        });
      return;
    }
    this.ports.status(undefined);
  }

  private async prepare(batchId: string, item: BatchItem): Promise<Active> {
    const blocks: string[] = [];
    const warnings: string[] = [];
    if (item.settings.preamble?.trim()) blocks.push(item.settings.preamble.trim());
    const byPath: BatchAttachment[] = [];
    for (const a of item.attachments) {
      if (a.delivery === 'path') {
        byPath.push(a);
        continue;
      }
      try {
        blocks.push(attachmentBlock(a, await this.ports.read(a.absPath)));
      } catch {
        warnings.push(`Could not read ${a.name}; it was sent as a path instead.`);
        byPath.push(a);
      }
    }
    if (byPath.length) blocks.push(pathAttachmentsBlock(byPath));
    return {
      batchId,
      seq: item.seq,
      text: item.text,
      blocks,
      settings: item.settings,
      phase: 'submitting',
      contextDelivered: false,
      allowReads: new Set(byPath.map(a => normalizePath(a.absPath))),
      warnings,
    };
  }

  private async failCurrent(error: string): Promise<void> {
    const c = this.current;
    if (!c) return;
    await this.finish(c, 'failed', await this.ports.now(), { error });
  }

  private async finish(c: Active, status: ItemRunStatus, now: number, extra: Partial<ItemRun>): Promise<void> {
    this.current = undefined;
    const b = this.batches.get(c.batchId);
    const run = b?.status.items.find(i => i.seq === c.seq);
    if (!b || !run) return;
    Object.assign(run, extra, { status, endedAt: now });
    if (c.warnings.length) run.warnings = [...c.warnings];
    if (status === 'interrupted') await this.cancelBatch(b, 'Stopped: the previous item was interrupted.');
    else if (status === 'failed' && b.file.options?.stopOnError) await this.cancelBatch(b, 'Stopped after a failed item.');
    this.updateBatchState(b);
    await this.writeStatus(b);
  }

  private updateBatchState(b: Batch): void {
    const all = b.status.items;
    if (!all.every(r => TERMINAL_STATUSES.includes(r.status))) return;
    b.status.state = b.cancelled
      ? 'cancelled'
      : all.some(r => r.status === 'failed' || r.status === 'unknown')
        ? 'failed'
        : 'completed';
  }

  private async onSessionChanged(newId: string, cwd: string, now: number): Promise<void> {
    if (this.sessionId) await this.closeSession(now, 'cleared');
    this.sessionId = newId;
    this.cwd = cwd;
    this.startedAt = now;
    this.turns = 0;
    this.firstPrompt = undefined;
    this.title = undefined;
    this.busy = false;
    this.controlSeq = 0;
    this.lastPresence = -Infinity;
    this.batches.clear();
    this.order.length = 0;
  }

  /** Ends this session id's work: unfinished items are cancelled and the presence says why. */
  private async closeSession(now: number, reason: string): Promise<void> {
    const c = this.current;
    if (c) await this.finish(c, 'cancelled', now, { reason: reason === 'cleared' ? 'The conversation was cleared.' : 'The session ended.' });
    for (const b of this.batches.values()) {
      if (b.status.state === 'running') await this.cancelBatch(b, reason === 'cleared' ? 'The conversation was cleared.' : 'The session ended.');
    }
    if (this.active) await this.writePresence(now, { at: now, reason });
  }

  private async writePresence(now: number, ended?: { at: number; reason: string }): Promise<void> {
    if (!this.sessionId) return;
    this.lastPresence = now;
    const p: Presence = {
      protocol: PROTOCOL,
      pluginVersion: PLUGIN_VERSION,
      sessionId: this.sessionId,
      cwd: this.cwd,
      startedAt: this.startedAt,
      lastSeen: now,
      seq: ++this.presenceSeq,
      state: this.busy || this.current ? 'busy' : 'idle',
      turns: this.turns,
      model: this.model,
      firstPrompt: this.firstPrompt,
      ...(this.title ? { title: this.title } : {}),
      lastActivityAt: this.lastActivityAt,
      activeBatchIds: [...this.batches.values()].filter(b => b.status.state === 'running').map(b => b.file.batchId),
      ...(this.surfaces ? { surfaces: this.surfaces } : {}),
      ...(ended ? { ended } : {}),
    };
    await this.serialWrite(this.paths.presence(this.sessionId), JSON.stringify(p));
  }

  private async writeStatus(b: Batch): Promise<void> {
    b.status.seq += 1;
    b.status.updatedAt = await this.ports.now();
    await this.serialWrite(this.paths.outboxBatch(b.status.sessionId, b.file.batchId), JSON.stringify(b.status));
  }

  /** One write at a time per file, so an older snapshot never lands after a newer one. */
  private serialWrite(path: string, text: string): Promise<void> {
    const prev = this.writes.get(path) ?? Promise.resolve();
    const next = prev.then(() => this.ports.write(path, text)).catch(err => this.ports.log(`write failed ${path}: ${String(err)}`));
    this.writes.set(path, next);
    return next;
  }

  private async safeList(path: string): Promise<{ name: string; kind: string }[]> {
    try {
      return await this.ports.list(path);
    } catch {
      return [];
    }
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    try {
      return parseJson<T>(await this.ports.read(path));
    } catch {
      return undefined;
    }
  }
}

function sameText(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n').trim() === b.replace(/\r\n/g, '\n').trim();
}

function joinTaken(claims: string, nonce: string): string {
  return `${claims}/${nonce}.taken.json`;
}
