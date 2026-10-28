// Runs inside a real VS Code extension host (test/smoke/run.mjs starts it).
// The plugin's Runner, on Node file access, stands in for a Claude session:
// everything from the extension's side of a submit down to the files is real.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { type Ports, Runner } from '../../../bridge-plugin/hooks/runner';
import type { ItemizerInternals } from '../../src/extension';
import type { RunOptions } from '../../src/shared/messages';
import { createItem, setItemSetting } from '../../src/shared/model';

const OPTIONS: RunOptions = { stopOnError: true, titleAsHeading: true, hideAfter: true, combinedFrom: 'first', concurrency: 1 };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function run(): Promise<void> {
  const failures: string[] = [];
  const check = (ok: unknown, what: string) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) failures.push(what);
  };

  const root = process.env.SMOKE_BRIDGE!;
  const ext = vscode.extensions.getExtension<ItemizerInternals>('claude-chat-itemizer.claude-chat-itemizer');
  check(ext, 'the extension is installed in the test host');
  const api = await ext!.activate();
  check(api?.store && api.runs, 'activate returns its internals');

  const commands = await vscode.commands.getCommands(true);
  for (const c of ['claudeItemizer.newItem', 'claudeItemizer.submitSelected', 'claudeItemizer.quickSubmit', 'claudeItemizer.setUpBridge', 'claudeItemizer.export']) {
    check(commands.includes(c), `command ${c} is registered`);
  }

  await vscode.commands.executeCommand('claudeItemizer.sidebar.focus');
  await vscode.commands.executeCommand('claudeItemizer.newItem');
  await sleep(1500);
  const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
  check(
    tabs.some(t => t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeItemizer.editor')),
    'New Chat Item opens the editor panel',
  );

  // The heartbeat tells plugins which folders have an Itemizer window.
  const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  await sleep(3500);
  const hosts = await fs.readdir(path.join(root, 'hosts')).catch(() => []);
  const host = hosts.length ? JSON.parse(await fs.readFile(path.join(root, 'hosts', hosts[0]!), 'utf8')) : undefined;
  check(host?.workspaceFolders?.includes(ws), 'the host heartbeat names this workspace');

  // A fake Claude session in this folder.
  const submitted: string[] = [];
  const appended: string[][] = [];
  const ports: Ports = {
    now: async () => Date.now(),
    read: p => fs.readFile(p, 'utf8'),
    write: async (p, t) => {
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, t, 'utf8');
    },
    list: async p => (await fs.readdir(p, { withFileTypes: true })).map(d => ({ name: d.name, kind: d.isDirectory() ? 'dir' : 'file' })),
    exists: p =>
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
    session: async () => ({ id: 'smoke-session', cwd: ws, model: 'claude-sonnet-5-5' }),
  };
  const runner = new Runner(ports, root, { hostCheckMs: 0, presenceMs: 0 });
  await runner.start();
  await runner.tick();
  check(runner.isActive(), 'the bridge wakes for this workspace');
  await api.sessions.refresh();
  check(api.sessions.list().some(s => s.sessionId === 'smoke-session'), 'the extension lists the session');

  const waitFor = async (cond: () => boolean, what: string, ms = 10_000) => {
    const t0 = Date.now();
    while (!cond() && Date.now() - t0 < ms) {
      await runner.tick();
      await sleep(200);
    }
    check(cond(), what);
  };
  const play = async (k: number, turnId: string) => {
    await waitFor(() => submitted.length > k, `item ${k + 1} is sent`);
    await runner.onTurnStart(turnId, submitted[k]!);
    const step = runner.stepOverride(turnId, undefined, 'claude-sonnet-5-5');
    await runner.onTurnComplete({ turnId, reason: 'answer', answer: `answer ${k + 1}`, model: step?.model ?? 'claude-sonnet-5-5' });
    return step;
  };

  // Two items, the first with its own model and a text attachment.
  const note = path.join(ws, 'note.txt');
  await fs.writeFile(note, 'attached words');
  let a = '';
  let b = '';
  api.store.update(s => {
    const one = createItem(s, undefined, Date.now(), { title: 'Alpha', text: 'first task' });
    const two = createItem(one.state, undefined, Date.now(), { title: 'Beta', text: 'second task' });
    a = one.id;
    b = two.id;
    return setItemSetting(setItemSetting(two.state, a, 'model', 'opus', Date.now()), a, 'effort', 'high', Date.now());
  });
  await api.controller.execute(undefined as never, { op: 'attachment.addUris', itemId: a, uris: [vscode.Uri.file(note).toString()] });
  check(api.store.state.items[a]!.attachments.length === 1, 'a file attaches as a stored copy');

  // One conversation, in order.
  const runId = await api.runs.submit([a, b], 'sequential', { kind: 'active' }, OPTIONS);
  const first = await play(0, 't1');
  check(submitted[0] === '## Alpha\n\nfirst task\n\nAttached: note.txt', 'the first item is sent with its title as a heading and its attachment named');
  check(first?.model === 'opus' && first.effort === 'high', 'the first item runs on its own model and effort');
  check(appended[0]?.join('\n').includes('attached words'), 'its attachment reaches the model');
  const second = await play(1, 't2');
  check(second === undefined, 'the second item keeps the chat settings');
  await waitFor(() => api.runs.views().find(r => r.id === runId)?.state === 'completed', 'the run completes');
  check(api.store.state.items[a]!.submittedAt && api.store.state.items[b]!.submittedAt, 'both items get the sent mark');
  check(api.store.state.view.hideSubmitted, '"Hide items after they\'re sent" hides them');
  const inbox = await fs.readdir(path.join(root, 'sessions', 'smoke-session', 'inbox')).catch(() => []);
  check(!inbox.includes(`${runId}.json`), 'the finished batch file is cleaned up');

  // Quick submit: no overrides.
  const quick = await api.runs.submit([a], 'sequential', { kind: 'active' }, OPTIONS, true);
  const q = await play(2, 't3');
  check(q === undefined, 'quick submit keeps the chat model and effort');
  await waitFor(() => api.runs.views().find(r => r.id === quick)?.state === 'completed', 'the quick run completes');

  // All in one message.
  const combined = await api.runs.submit([a, b], 'combined', { kind: 'active' }, OPTIONS);
  await play(3, 't4');
  check(submitted[3]?.includes('## 1. Alpha') && submitted[3]?.includes('## 2. Beta'), 'combined items go in one message');
  await waitFor(() => api.runs.views().find(r => r.id === combined)?.state === 'completed', 'the combined run completes');

  // Send to: a picked chat that is closed is refused, not swapped for another.
  api.store.update(st => ({ ...st, view: { ...st.view, targetSessionId: 'closed-session' } }));
  let refused = '';
  try {
    await api.runs.submit([a], 'sequential', { kind: 'active' }, OPTIONS, true);
  } catch (err) {
    refused = (err as { code?: string }).code ?? '';
  }
  check(refused === 'targetGone', 'Quick refuses when the picked chat is closed');
  api.store.update(st => ({ ...st, view: { ...st.view, targetSessionId: 'smoke-session' } }));
  const pickedRun = await api.runs.submit([b], 'sequential', { kind: 'active' }, OPTIONS, true);
  await play(4, 't5');
  await waitFor(() => api.runs.views().find(r => r.id === pickedRun)?.state === 'completed', 'Quick sends to the picked chat');
  api.store.update(st => {
    const view = { ...st.view };
    delete view.targetSessionId;
    return { ...st, view };
  });

  // Cancel before the item is picked up.
  const cancelled = await api.runs.submit([b, a], 'sequential', { kind: 'active' }, OPTIONS);
  await api.runs.cancel(cancelled, false);
  await waitFor(() => api.runs.views().find(r => r.id === cancelled)?.state === 'cancelled', 'a cancelled run reports cancelled', 15_000);

  await runner.onSessionEnd('other');
  if (failures.length) throw new Error(`${failures.length} smoke check(s) failed:\n${failures.join('\n')}`);
}
