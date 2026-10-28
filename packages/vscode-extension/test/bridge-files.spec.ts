// The two halves of the file protocol on a real disk: the extension's writers
// and readers (native paths, atomic writes) against the plugin's Runner (the
// same code Claude Code loads), with Node file access standing in for `$.fs`.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BatchFile, type Presence, type StatusFile, PROTOCOL, bridgePaths } from '../../bridge-plugin/hooks/protocol';
import { type Ports, Runner } from '../../bridge-plugin/hooks/runner';
import { listDir, readJson, writeJsonAtomic } from '../src/bridge/fsutil';

let root: string;
let workspace: string;

function nodePorts(submitted: string[], sessionId = 'sess-a', appended: string[][] = []): Ports {
  return {
    now: async () => Date.now(),
    read: p => fs.readFile(p, 'utf8'),
    write: async (p, t) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, t, 'utf8');
    },
    list: async p => (await fs.readdir(p, { withFileTypes: true })).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
    exists: async p =>
      fs.stat(p).then(
        () => true,
        () => false,
      ),
    submit: async text => {
      submitted.push(text);
      return {};
    },
    abort: async () => undefined,
    append: async blocks => {
      appended.push(blocks);
      return true;
    },
    log: () => undefined,
    status: () => undefined,
    session: async () => ({ id: sessionId, cwd: path.join(workspace, 'sub'), model: 'claude-sonnet-5-5' }),
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'itemizer-bridge-'));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'itemizer-ws-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe('bridge files on disk', () => {
  it('a batch the extension writes is run and reported back', async () => {
    const native = bridgePaths(root);
    // The extension's heartbeat, with native separators.
    await writeJsonAtomic(path.normalize(native.host('h1')), { protocol: PROTOCOL, hostId: 'h1', workspaceFolders: [workspace], lastSeen: Date.now() });

    const submitted: string[] = [];
    const appended: string[][] = [];
    const runner = new Runner(nodePorts(submitted, 'sess-a', appended), root, { hostCheckMs: 0, presenceMs: 0 });
    await runner.start();
    await runner.tick();
    expect(runner.isActive()).toBe(true);

    // The extension finds the session through its presence file.
    const presence = await readJson<Presence>(path.normalize(native.presence('sess-a')));
    expect(presence?.cwd).toBe(path.join(workspace, 'sub'));
    expect(await listDir(path.normalize(native.sessions))).toEqual(['sess-a']);

    const text = path.join(workspace, 'notes.txt');
    await fs.writeFile(text, 'remember the edge cases');
    const batch: BatchFile = {
      protocol: PROTOCOL,
      batchId: 'r1',
      hostId: 'h1',
      createdAt: Date.now(),
      mode: 'sequential',
      options: { stopOnError: true, settleMs: 0 },
      items: [
        {
          seq: 0,
          itemIds: ['i1'],
          title: 'One',
          text: '## One\n\nfirst',
          settings: { toolPolicy: 'inherit', model: 'opus' },
          attachments: [{ name: 'notes.txt', kind: 'text', mime: 'text/plain', size: 23, absPath: text, delivery: 'inline' }],
        },
        { seq: 1, itemIds: ['i2'], title: 'Two', text: 'second', settings: { toolPolicy: 'inherit' }, attachments: [] },
      ],
    };
    await writeJsonAtomic(path.normalize(native.inboxBatch('sess-a', 'r1')), batch);

    await runner.tick();
    expect(submitted).toEqual(['## One\n\nfirst']);
    expect(appended[0]?.[0]).toContain('remember the edge cases');
    await runner.onTurnStart('t1', '## One\n\nfirst');
    expect(runner.stepOverride('t1', undefined, 'claude-sonnet-5-5')).toEqual({ model: 'opus' });
    await runner.onTurnComplete({ turnId: 't1', reason: 'answer', answer: 'did one', model: 'claude-opus-5-5' });

    await runner.tick();
    expect(submitted).toEqual(['## One\n\nfirst', 'second']);
    await runner.onTurnStart('t2', 'second');
    await runner.onTurnComplete({ turnId: 't2', reason: 'answer', answer: 'did two' });

    const status = await readJson<StatusFile>(path.normalize(native.outboxBatch('sess-a', 'r1')));
    expect(status?.state).toBe('completed');
    expect(status?.items.map(i => [i.status, i.appliedModel])).toEqual([
      ['done', 'claude-opus-5-5'],
      ['done', undefined],
    ]);
  });

  it('a cancel the extension writes stops the rest of the batch', async () => {
    const native = bridgePaths(root);
    await writeJsonAtomic(path.normalize(native.host('h1')), { protocol: PROTOCOL, hostId: 'h1', workspaceFolders: [workspace], lastSeen: Date.now() });
    const submitted: string[] = [];
    const runner = new Runner(nodePorts(submitted), root, { hostCheckMs: 0, presenceMs: 0 });
    await runner.start();
    const items = ['a', 'b', 'c'].map((t, seq) => ({ seq, itemIds: [t], text: t, settings: { toolPolicy: 'inherit' as const }, attachments: [] }));
    await writeJsonAtomic(path.normalize(native.inboxBatch('sess-a', 'r2')), {
      protocol: PROTOCOL,
      batchId: 'r2',
      hostId: 'h1',
      createdAt: 1,
      mode: 'sequential',
      options: { stopOnError: true, settleMs: 0 },
      items,
    });
    await runner.tick();
    await writeJsonAtomic(path.normalize(native.control('sess-a')), { seq: 5, commands: [{ seq: 5, kind: 'cancel', batchId: 'r2' }] });
    await runner.tick();
    await runner.onTurnStart('t1', 'a');
    await runner.onTurnComplete({ turnId: 't1', reason: 'answer', answer: '' });
    const status = await readJson<StatusFile>(path.normalize(native.outboxBatch('sess-a', 'r2')));
    expect(status?.items.map(i => i.status)).toEqual(['done', 'cancelled', 'cancelled']);
    expect(status?.state).toBe('cancelled');
  });

  it('a session in another folder stays dormant', async () => {
    const native = bridgePaths(root);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'itemizer-other-'));
    await writeJsonAtomic(path.normalize(native.host('h1')), { protocol: PROTOCOL, hostId: 'h1', workspaceFolders: [other], lastSeen: Date.now() });
    const runner = new Runner(nodePorts([]), root, { hostCheckMs: 0, presenceMs: 0 });
    await runner.start();
    await runner.tick();
    expect(runner.isActive()).toBe(false);
    expect(await listDir(path.normalize(native.sessions))).toEqual([]);
    await fs.rm(other, { recursive: true, force: true });
  });
});
