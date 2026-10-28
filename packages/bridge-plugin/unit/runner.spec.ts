import { beforeEach, describe, expect, it } from 'vitest';

import { type BatchFile, type BatchItem, type StatusFile, PLUGIN_NAME, PROTOCOL, bridgePaths } from '../hooks/protocol.ts';
import { type Ports, Runner } from '../hooks/runner.ts';

const ROOT = 'C:/Users/me/.claude/itemizer/v1';
const CWD = 'C:\\work\\acme';
const P = bridgePaths(ROOT);

class World {
  files = new Map<string, string>();
  clock = 1_000_000;
  sessionId = 'sess-1';
  submitted: string[] = [];
  aborted: string[] = [];
  appended: string[][] = [];
  submitResult: { drop?: string } = {};

  ports(): Ports {
    const key = (p: string) => p.replace(/\\/g, '/');
    return {
      now: async () => this.clock,
      read: async p => {
        const v = this.files.get(key(p));
        if (v === undefined) throw new Error(`ENOENT ${p}`);
        return v;
      },
      write: async (p, t) => void this.files.set(key(p), t),
      list: async p => {
        const dir = `${key(p)}/`;
        const names = new Set<string>();
        for (const k of this.files.keys()) if (k.startsWith(dir)) names.add(k.slice(dir.length).split('/')[0]!);
        if (names.size === 0) throw new Error(`ENOENT ${p}`);
        return [...names].map(name => ({ name, kind: 'file' }));
      },
      exists: async p => this.files.has(key(p)),
      submit: async text => {
        this.submitted.push(text);
        return this.submitResult;
      },
      abort: async id => void this.aborted.push(id),
      append: async blocks => {
        this.appended.push(blocks);
        return true;
      },
      log: () => undefined,
      status: () => undefined,
      session: async () => ({ id: this.sessionId, cwd: CWD, model: 'claude-sonnet-5-5' }),
    };
  }

  json<T>(p: string): T {
    return JSON.parse(this.files.get(p)!) as T;
  }

  host(folders = ['c:/work/acme'], lastSeen = this.clock): void {
    this.files.set(P.host('h1'), JSON.stringify({ protocol: PROTOCOL, hostId: 'h1', workspaceFolders: folders, lastSeen }));
  }

  batch(items: Partial<BatchItem>[], batchId = 'b1', opts: Partial<BatchFile['options']> = {}): BatchFile {
    const file: BatchFile = {
      protocol: PROTOCOL,
      batchId,
      hostId: 'h1',
      createdAt: this.clock,
      mode: 'sequential',
      options: { stopOnError: true, settleMs: 0, ...opts },
      items: items.map((it, seq) => ({
        seq,
        itemIds: [`i${seq}`],
        text: `prompt ${seq}`,
        settings: { toolPolicy: 'inherit' },
        attachments: [],
        ...it,
      })),
    };
    this.files.set(P.inboxBatch(this.sessionId, batchId), JSON.stringify(file));
    return file;
  }

  status(batchId = 'b1', sid = this.sessionId): StatusFile {
    return this.json<StatusFile>(P.outboxBatch(sid, batchId));
  }
}

const ORIGIN = { kind: 'plugin', name: PLUGIN_NAME };

/** Plays the engine's side of one submitted prompt: submit hook, turn.start, a step, turn.complete. */
async function playTurn(w: World, r: Runner, opts: { reason?: string; turnId?: string } = {}) {
  const text = w.submitted.at(-1)!;
  const blocks = r.promptContext(text, ORIGIN);
  const turnId = opts.turnId ?? `t${w.submitted.length}`;
  await r.onTurnStart(turnId, text);
  const step = r.stepOverride(turnId, undefined, 'claude-sonnet-5-5');
  await r.onTurnComplete({ turnId, reason: opts.reason ?? 'answer', answer: 'ok, done', model: step?.model ?? 'claude-sonnet-5-5' });
  return { blocks, step, turnId };
}

describe('Runner', () => {
  let w: World;
  let r: Runner;

  beforeEach(async () => {
    w = new World();
    r = new Runner(w.ports(), ROOT, { hostCheckMs: 0, presenceMs: 0 });
    await r.start();
  });

  it('stays dormant until an Itemizer window is open on its folder', async () => {
    await r.tick();
    expect(r.isActive()).toBe(false);
    expect(w.files.has(P.presence('sess-1'))).toBe(false);

    w.host(['D:/other']);
    await r.tick();
    expect(r.isActive()).toBe(false);

    w.host(['C:/WORK/acme/']);
    await r.tick();
    expect(r.isActive()).toBe(true);
    expect(w.json<{ cwd: string; state: string }>(P.presence('sess-1'))).toMatchObject({ cwd: CWD, state: 'idle' });
  });

  it('ignores a stale host heartbeat', async () => {
    w.host(['C:/work/acme'], w.clock - 60_000);
    await r.tick();
    expect(r.isActive()).toBe(false);
  });

  it('sends items one at a time, each after the previous turn ends', async () => {
    w.host();
    w.batch([{ text: 'first' }, { text: 'second' }]);
    await r.tick();
    expect(w.submitted).toEqual(['first']);
    expect(w.status().items.map(i => i.status)).toEqual(['submitting', 'queued']);

    await r.tick(); // still busy with the first
    expect(w.submitted).toEqual(['first']);

    await playTurn(w, r);
    expect(w.status().items[0]).toMatchObject({ status: 'done', turnId: 't1', answerPreview: 'ok, done' });

    await r.tick();
    expect(w.submitted).toEqual(['first', 'second']);
    await playTurn(w, r);
    expect(w.status()).toMatchObject({ state: 'completed' });
    expect(w.status().items.map(i => i.status)).toEqual(['done', 'done']);
  });

  it('waits settleMs after a turn before the next item', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }], 'b1', { settleMs: 2_000 });
    await r.tick();
    await playTurn(w, r);
    w.clock += 1_000;
    await r.tick();
    expect(w.submitted).toEqual(['a']);
    w.clock += 1_500;
    await r.tick();
    expect(w.submitted).toEqual(['a', 'b']);
  });

  it("does not take over a turn the person typed meanwhile", async () => {
    w.host();
    w.batch([{ text: 'from the itemizer' }]);
    await r.tick();
    await r.onTurnStart('typed', 'something the person typed');
    expect(r.stepOverride('typed', undefined, 'claude-sonnet-5-5')).toBeUndefined();
    await r.onTurnComplete({ turnId: 'typed', reason: 'answer', answer: '' });
    expect(w.status().items[0]!.status).toBe('submitting');
    await playTurn(w, r);
    expect(w.status().items[0]!.status).toBe('done');
  });

  it('applies the item model and effort to its own turn only', async () => {
    w.host();
    w.batch([{ settings: { model: 'opus', effort: 'high', toolPolicy: 'inherit' } }]);
    await r.tick();
    const { step } = await playTurn(w, r);
    expect(step).toEqual({ model: 'opus', effort: 'high' });
    expect(w.status().items[0]!.appliedModel).toBe('opus');
    expect(r.stepOverride('t1', undefined, 'claude-sonnet-5-5')).toBeUndefined();
  });

  it('leaves subagent steps alone', async () => {
    w.host();
    w.batch([{ settings: { model: 'opus', toolPolicy: 'inherit' } }]);
    await r.tick();
    r.promptContext('prompt 0', ORIGIN);
    await r.onTurnStart('t1', 'prompt 0');
    expect(r.stepOverride('t1', 'agent-7', 'claude-sonnet-5-5')).toBeUndefined();
    expect(r.stepOverride('t1', undefined, 'claude-sonnet-5-5')).toEqual({ model: 'opus' });
  });

  it('drops an effort the model does not take and says so', async () => {
    w.host();
    w.batch([{ settings: { model: 'haiku', effort: 'max', toolPolicy: 'inherit' } }]);
    await r.tick();
    const { step } = await playTurn(w, r);
    expect(step).toEqual({ model: 'haiku' });
    expect(w.status().items[0]!.warnings?.[0]).toMatch(/Effort max is not supported by haiku/);
  });

  it('quick submit overrides nothing', async () => {
    w.host();
    w.batch([{ settings: { model: 'opus', effort: 'high', toolPolicy: 'readOnly', quick: true } }]);
    await r.tick();
    r.promptContext('prompt 0', ORIGIN);
    await r.onTurnStart('t1', 'prompt 0');
    expect(r.stepOverride('t1', undefined, 'claude-sonnet-5-5')).toBeUndefined();
    expect(r.toolDecision('Edit', { file_path: 'C:/work/acme/a.ts' })).toBeUndefined();
  });

  it('attaches text files as context and images as paths Claude may read', async () => {
    w.host();
    w.files.set('C:/store/notes.md', '# Notes\nhello');
    w.batch([
      {
        settings: { toolPolicy: 'inherit', preamble: 'Answer briefly.' },
        attachments: [
          { name: 'notes.md', kind: 'text', mime: 'text/markdown', size: 13, absPath: 'C:/store/notes.md', delivery: 'inline' },
          { name: 'shot.png', kind: 'image', mime: 'image/png', size: 900, absPath: 'C:\\store\\shot.png', delivery: 'path' },
          { name: 'gone.txt', kind: 'text', mime: 'text/plain', size: 1, absPath: 'C:/store/gone.txt', delivery: 'inline' },
        ],
      },
    ]);
    await r.tick();
    const blocks = w.appended[0]!;
    expect(blocks[0]).toBe('Answer briefly.');
    expect(blocks[1]).toContain('<itemizer-attachment name="notes.md"');
    expect(blocks[1]).toContain('# Notes\nhello');
    expect(blocks[2]).toContain('C:\\store\\shot.png');
    expect(blocks[2]).toContain('C:/store/gone.txt');

    await r.onTurnStart('t1', 'prompt 0');
    expect(r.wantsRealPath('Read')).toBe(true);
    expect(r.toolDecision('Read', { file_path: 'c:/STORE/shot.png' })).toMatchObject({ decision: 'allow' });
    expect(r.toolDecision('Read', { file_path: 'C:/store/other.png' })).toBeUndefined();
    await r.onTurnComplete({ turnId: 't1', reason: 'answer', answer: '' });
    expect(w.status().items[0]!.warnings?.[0]).toMatch(/Could not read gone.txt/);
    expect(r.toolDecision('Read', { file_path: 'C:/store/shot.png' })).toBeUndefined();
  });

  it('adds the attachments as a hidden row before it sends the prompt', async () => {
    w.host();
    w.files.set('C:/store/a.txt', 'alpha');
    const order: string[] = [];
    const ports = w.ports();
    const r2 = new Runner(
      {
        ...ports,
        append: async b => {
          order.push('append');
          return ports.append(b);
        },
        submit: async t => {
          order.push('submit');
          return ports.submit(t);
        },
      },
      ROOT,
      { hostCheckMs: 0, presenceMs: 0 },
    );
    await r2.start();
    w.batch([{ attachments: [{ name: 'a.txt', kind: 'text', mime: 'text/plain', size: 5, absPath: 'C:/store/a.txt', delivery: 'inline' }] }]);
    await r2.tick();
    expect(order).toEqual(['append', 'submit']);
    expect(w.appended[0]![0]).toContain('alpha');
    // ...and only once: not again through the prompt hook or at turn start.
    expect(r2.promptContext('prompt 0', ORIGIN)).toBeUndefined();
    await r2.onTurnStart('t1', 'prompt 0');
    expect(w.appended).toHaveLength(1);
  });

  it('sends no hidden row for an item without attachments', async () => {
    w.host();
    w.batch([{ text: 'plain' }]);
    await r.tick();
    expect(w.appended).toHaveLength(0);
  });

  it('names a reloaded chat from its history, then by its title', async () => {
    const ports = w.ports();
    const r2 = new Runner({ ...ports, history: async () => ({ turns: 7, firstPrompt: 'Design the plugin\nwith details' }) }, ROOT, { hostCheckMs: 0, presenceMs: 0 });
    await r2.start();
    w.host();
    await r2.tick();
    expect(w.json<{ turns: number; firstPrompt?: string; title?: string }>(P.presence('sess-1'))).toMatchObject({ turns: 7, firstPrompt: 'Design the plugin with details' });
    r2.setTitle('Claude chat batch plugin architecture');
    await r2.tick();
    expect(w.json<{ title?: string }>(P.presence('sess-1')).title).toBe('Claude chat batch plugin architecture');
  });

  it('reports which surfaces the session draws on', async () => {
    const ports = w.ports();
    const r2 = new Runner({ ...ports, session: async () => ({ ...(await ports.session()), surfaces: [] }) }, ROOT, { hostCheckMs: 0, presenceMs: 0 });
    await r2.start();
    w.host();
    await r2.tick();
    expect(w.json<{ surfaces?: string[] }>(P.presence('sess-1')).surfaces).toEqual([]);
  });

  it('ignores context for a prompt that is not its own', async () => {
    w.host();
    w.batch([{ text: 'same words' }]);
    await r.tick();
    expect(r.promptContext('same words', { kind: 'composer' })).toBeUndefined();
    expect(r.promptContext('same words', { kind: 'plugin', name: 'other' })).toBeUndefined();
  });

  it('enforces a read-only item', async () => {
    w.host();
    w.batch([{ settings: { toolPolicy: 'readOnly' } }]);
    await r.tick();
    r.promptContext('prompt 0', ORIGIN);
    await r.onTurnStart('t1', 'prompt 0');
    expect(r.toolDecision('Edit', { file_path: 'C:/work/acme/a.ts' })?.decision).toBe('deny');
    expect(r.toolDecision('Write', { file_path: 'C:/work/acme/a.ts' })?.decision).toBe('deny');
    expect(r.toolDecision('Bash', { command: 'ls' })?.decision).toBe('ask');
    expect(r.toolDecision('Grep', { pattern: 'x' })).toBeUndefined();
  });

  it('auto-accepts edits inside the workspace only', async () => {
    w.host();
    w.batch([{ settings: { toolPolicy: 'autoAcceptEdits' } }]);
    await r.tick();
    r.promptContext('prompt 0', ORIGIN);
    await r.onTurnStart('t1', 'prompt 0');
    expect(r.toolDecision('Edit', { file_path: 'C:/work/acme/src/a.ts' })?.decision).toBe('allow');
    expect(r.toolDecision('Edit', { file_path: 'C:/Windows/system.ini' })).toBeUndefined();
  });

  it('cancels the rest of a batch from the control file', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    await r.tick();
    w.files.set(P.control('sess-1'), JSON.stringify({ seq: 1, commands: [{ seq: 1, kind: 'cancel', batchId: 'b1' }] }));
    await r.tick();
    expect(w.status().items.map(i => i.status)).toEqual(['submitting', 'cancelled', 'cancelled']);
    await playTurn(w, r);
    expect(w.status()).toMatchObject({ state: 'cancelled' });
    await r.tick();
    expect(w.submitted).toEqual(['a']);
  });

  it('cancels a batch whose cancel arrives before the batch is picked up', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }]);
    w.files.set(P.control('sess-1'), JSON.stringify({ seq: 1, commands: [{ seq: 1, kind: 'cancel', batchId: 'b1' }] }));
    await r.tick();
    expect(w.submitted).toEqual([]);
    expect(w.status()).toMatchObject({ state: 'cancelled' });
  });

  it('aborts the running turn on request', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }]);
    await r.tick();
    r.promptContext('a', ORIGIN);
    await r.onTurnStart('t1', 'a');
    w.files.set(P.control('sess-1'), JSON.stringify({ seq: 2, commands: [{ seq: 2, kind: 'abortCurrent', batchId: 'b1' }] }));
    await r.tick();
    expect(w.aborted).toEqual(['t1']);
  });

  it('stops the batch when the person interrupts an item', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }], 'b1', { stopOnError: false });
    await r.tick();
    await playTurn(w, r, { reason: 'aborted' });
    expect(w.status().items.map(i => i.status)).toEqual(['interrupted', 'cancelled']);
    expect(w.status().state).toBe('cancelled');
  });

  it('keeps going after a failure unless stopOnError', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }], 'b1', { stopOnError: false });
    await r.tick();
    await playTurn(w, r, { reason: 'error' });
    await r.tick();
    await playTurn(w, r);
    expect(w.status().items.map(i => i.status)).toEqual(['failed', 'done']);
    expect(w.status().state).toBe('failed');
  });

  it('fails an item whose prompt a hook dropped', async () => {
    w.host();
    w.submitResult = { drop: 'blocked by policy' };
    w.batch([{ text: 'a' }]);
    await r.tick();
    await new Promise(res => setTimeout(res, 0));
    expect(w.status().items[0]).toMatchObject({ status: 'failed', error: 'The prompt was not sent: blocked by policy' });
  });

  it('picks up a running item again after the plugin reloads', async () => {
    w.host();
    w.batch([{ text: 'a', settings: { model: 'opus', toolPolicy: 'inherit' } }, { text: 'b' }]);
    await r.tick();
    r.promptContext('a', ORIGIN);
    await r.onTurnStart('t1', 'a');

    const again = new Runner(w.ports(), ROOT, { hostCheckMs: 0, presenceMs: 0 });
    await again.start();
    await again.tick();
    expect(again.stepOverride('t1', undefined, 'claude-sonnet-5-5')).toEqual({ model: 'opus' });
    await again.onTurnComplete({ turnId: 't1', reason: 'answer', answer: 'fine' });
    await again.tick();
    expect(w.submitted).toEqual(['a', 'b']);
    expect(w.status().items[0]!.status).toBe('done');
  });

  it('marks an item lost mid-submit as unknown after a reload', async () => {
    w.host();
    w.batch([{ text: 'a' }]);
    await r.tick();
    const again = new Runner(w.ports(), ROOT, { hostCheckMs: 0, presenceMs: 0 });
    await again.start();
    await again.tick();
    expect(w.status().items[0]!.status).toBe('unknown');
    expect(w.status().state).toBe('failed');
  });

  it('takes a claimed batch through /itemizer-run', async () => {
    const file = { ...w.batch([{ text: 'claimed' }], 'b9'), batchId: 'b9' };
    w.files.delete(P.inboxBatch('sess-1', 'b9'));
    w.files.set(P.claim('n1'), JSON.stringify({ protocol: PROTOCOL, nonce: 'n1', expiresAt: w.clock + 60_000, batch: file }));
    expect(await r.adoptClaim('n1')).toMatch(/running 1 chat item/);
    expect(w.submitted).toEqual([]);
    await r.tick();
    expect(w.submitted).toEqual(['claimed']);
    expect(await r.adoptClaim('n1')).toMatch(/already taken/);
    expect(w.json<{ sessionId: string }>(`${P.claims}/n1.taken.json`).sessionId).toBe('sess-1');
  });

  it('refuses an expired or unknown claim', async () => {
    expect(await r.adoptClaim('nope')).toMatch(/no such claim/);
    expect(await r.adoptClaim('../evil')).toMatch(/not valid/);
    const file = w.batch([{ text: 'x' }], 'b8');
    w.files.set(P.claim('old'), JSON.stringify({ protocol: PROTOCOL, nonce: 'old', expiresAt: w.clock - 1, batch: file }));
    expect(await r.adoptClaim('old')).toMatch(/expired/);
  });

  it('closes out work when the conversation is cleared', async () => {
    w.host();
    w.batch([{ text: 'a' }, { text: 'b' }]);
    await r.tick();
    await r.onSessionEnd('clear');
    expect(w.status().items.map(i => i.status)).toEqual(['cancelled', 'cancelled']);
    expect(w.json<{ ended?: { reason: string } }>(P.presence('sess-1')).ended?.reason).toBe('cleared');

    w.sessionId = 'sess-2';
    await r.tick();
    expect(w.json<{ sessionId: string; ended?: unknown }>(P.presence('sess-2'))).toMatchObject({ sessionId: 'sess-2' });
    expect(w.json<{ ended?: unknown }>(P.presence('sess-2')).ended).toBeUndefined();
  });
});
