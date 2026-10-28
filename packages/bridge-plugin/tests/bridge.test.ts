// Runs under `claude plugin test`: the engine loads hooks/register.ts and these
// hooks sit beneath it, standing in for the engine's own behaviour.
import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

const ROOT = 'C:/bridge';
const CWD = 'C:/work/acme';

/** The engine hands hooks native paths (backslashes on Windows); the store keys by forward slashes. */
class Files extends Map<string, string> {
  private k(p: string) {
    return p.split('\\').join('/');
  }
  override get(p: string) {
    return super.get(this.k(p));
  }
  override set(p: string, v: string) {
    return super.set(this.k(p), v);
  }
  override has(p: string) {
    return super.has(this.k(p));
  }
}

function world(on: On) {
  const files = new Files();
  on('fs.read', (_, e) => (files.has(e.path) ? { value: files.get(e.path)! } : { deny: `ENOENT ${e.path}` }));
  on('fs.write', (_, e) => {
    files.set(e.path, e.text);
    return { value: undefined };
  });
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }));
  on('fs.list', (_, e) => {
    const dir = `${e.path.split('\\').join('/')}/`;
    const names = new Set<string>();
    for (const k of files.keys()) if (k.startsWith(dir)) names.add(k.slice(dir.length).split('/')[0]!);
    if (names.size === 0) return { deny: `ENOENT ${e.path}` };
    return { value: [...names].map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) };
  });
  on('fs.stat', (_, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false, realPath: e.path } }));
  on('session.id', () => ({ value: 'sess-1' }));
  on('session.cwd', () => ({ value: CWD }));
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }));
  on('command.register', (_, e) => ({ value: { command: e.name } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('session.end', (_, e) => ({ sessionId: e.sessionId }));
  mock.env(on, { ITEMIZER_BRIDGE_DIR: ROOT });
  const clock = mock.clock(on, { now: 1_000_000 });
  const session = mock.session(on);
  return { files, clock, session };
}

const batch = {
  protocol: 1,
  batchId: 'b1',
  hostId: 'h1',
  createdAt: 1,
  mode: 'newConversationPerItem',
  options: { stopOnError: true, settleMs: 0 },
  items: [
    {
      seq: 0,
      itemIds: ['i1'],
      title: 'Fix the bug',
      text: 'Fix the bug in parser.ts',
      settings: { model: 'opus', effort: 'high', toolPolicy: 'readOnly' },
      attachments: [
        { name: 'notes.md', kind: 'text', mime: 'text/markdown', size: 5, absPath: 'C:/store/notes.md', delivery: 'inline' },
        { name: 'shot.png', kind: 'image', mime: 'image/png', size: 9, absPath: 'C:/store/shot.png', delivery: 'path' },
      ],
    },
  ],
};

const END = { reason: 'other', sessionId: 'sess-1', resume: { sessionId: 'sess-1' } } as never;

test('a claimed item is sent with its attachments, on its own model, read-only', async ($, on) => {
  const { files, clock, session } = world(on);
  files.set('C:/store/notes.md', 'hello');
  files.set(`${ROOT}/claims/n1.json`, JSON.stringify({ protocol: 1, nonce: 'n1', expiresAt: 9_999_999, batch }));

  const submitted: { text: string; origin: unknown }[] = [];
  on('prompt.submit', (_, e) => {
    submitted.push({ text: e.text, origin: e.origin });
    return { text: e.text, context: e.context };
  });
  const steps: { model: string; effort?: unknown }[] = [];
  on('turn.start', (_, e) => ({ turnId: e.turnId }));
  on('turn.step', async function* (_, e) {
    steps.push({ model: e.model, effort: e.effort });
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null };
  });
  on('turn.complete', (_, e) => ({ text: e.answer }));
  on('tool.check', () => ({ decision: 'ask' as const }));

  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true });

  const out = await $.command.run({ command: 'itemizer-run', args: 'n1', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } });
  expect(out.text).toMatch(/running 1 chat item/);
  expect(submitted).toHaveLength(0); // never from inside the command's own hook

  await clock.advance(1_500); // the bridge's poll loop sends it
  expect(submitted[0]).toEqual({ text: 'Fix the bug in parser.ts', origin: { kind: 'plugin', name: 'itemizer-bridge', asUser: true } });

  // The plugin's own submit does not pass through its prompt.submit hook, so the
  // attachments arrive as a hidden row as the turn starts.
  await $.turn.start({ text: 'Fix the bug in parser.ts', turnId: 't1' });
  const rows = JSON.stringify(session.appended().map(r => r.message.content));
  expect(rows).toContain('itemizer-attachment name=\\"notes.md\\"');
  expect(rows).toContain('hello');
  expect(rows).toContain('C:/store/shot.png');

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 1 })) {
    // drain
  }
  expect(steps[0]).toEqual({ model: 'opus', effort: 'high' });

  expect((await $.tool.check({ tool: 'Read', input: { file_path: 'C:/store/shot.png' }, tool_use_id: 'u1' })).decision).toBe('allow');
  expect((await $.tool.check({ tool: 'Edit', input: { file_path: `${CWD}/a.ts`, old_string: 'a', new_string: 'b' }, tool_use_id: 'u2' })).decision).toBe('deny');
  expect((await $.tool.check({ tool: 'Grep', input: { pattern: 'x' }, tool_use_id: 'u3' })).decision).toBe('ask');

  await $.turn.complete({ turnId: 't1', answer: 'Fixed it.', durationMs: 5, isAborted: false, reason: 'answer' });
  const status = JSON.parse(files.get(`${ROOT}/sessions/sess-1/outbox/b1.json`)!);
  expect(status.state).toBe('completed');
  expect(status.items[0].status).toBe('done');
  expect(status.items[0].answerPreview).toBe('Fixed it.');

  // After the item, the session's own model is back.
  steps.length = 0;
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-sonnet-5-5', effort: 'medium', messageCount: 3 })) {
    // drain
  }
  expect(steps[0]).toEqual({ model: 'claude-sonnet-5-5', effort: 'medium' });
  await $.session.end(END);
});

test('a prompt the person typed passes through untouched', async ($, on) => {
  world(on);
  const seen: { context?: readonly string[] }[] = [];
  on('prompt.submit', (_, e) => {
    seen.push({ context: e.context });
    return { text: e.text };
  });
  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true });
  await $.prompt.submit({ text: 'hello', wait: false, origin: { kind: 'composer' } });
  expect(seen[0]?.context).toBeUndefined();
  await $.session.end(END);
});

test('the bridge wakes for an Itemizer window on its folder and reports itself', async ($, on) => {
  const { files, clock } = world(on);
  await $.session.start({ cwd: CWD, surface: 'vscode', isInteractive: true });
  await clock.advance(1_500);
  expect(files.has(`${ROOT}/sessions/sess-1/presence.json`)).toBe(false);

  files.set(`${ROOT}/hosts/h1.json`, JSON.stringify({ protocol: 1, hostId: 'h1', workspaceFolders: ['c:\\work\\acme'], lastSeen: clock.now() }));
  await clock.advance(6_000);
  const presence = JSON.parse(files.get(`${ROOT}/sessions/sess-1/presence.json`)!);
  expect(presence).toMatchObject({ sessionId: 'sess-1', cwd: CWD, state: 'idle', pluginVersion: '0.3.0' });
  await $.session.end(END);
});
