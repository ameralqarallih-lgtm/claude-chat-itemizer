import * as vscode from 'vscode';

import { AttachmentStore } from './attachments';
import { HostHeartbeat } from './bridge/host';
import { refreshInstalledPlugin, removeBridge } from './bridge/installer';
import { SessionRegistry } from './bridge/sessions';
import { Controller } from './controller';
import { exportItems, importItems } from './io';
import { RunCoordinator, UserError } from './run/coordinator';
import { createCategory, createItem } from './shared/model';
import { Store } from './store';
import { EditorPanel, SidebarProvider } from './ui/webviews';

/** What activate returns: the pieces the smoke test drives. Not a public API. */
export interface ItemizerInternals {
  store: Store;
  runs: RunCoordinator;
  sessions: SessionRegistry;
  controller: Controller;
}

export function activate(context: vscode.ExtensionContext): ItemizerInternals {
  const channel = vscode.window.createOutputChannel('Chat Itemizer');
  const log = (s: string) => channel.appendLine(`[${new Date().toLocaleTimeString()}] ${s}`);

  const store = new Store(context.workspaceState);
  const attachments = new AttachmentStore(context.storageUri);
  const heartbeat = new HostHeartbeat(log);
  const sessions = new SessionRegistry();
  const runs = new RunCoordinator(context.workspaceState, store, attachments, sessions, heartbeat.hostId, log);
  const controller = new Controller(context, store, attachments, sessions, runs, log);
  const sidebar = new SidebarProvider(context.extensionUri, attachments, controller);
  const editor = new EditorPanel(context.extensionUri, attachments, controller, store);
  controller.openEditor = target => editor.open(target);
  controller.showSubmitDialog = itemIds =>
    void sidebar.reveal().then(webview => webview && controller.post(webview, { type: 'openSubmit', itemIds }));

  heartbeat.start();
  sessions.start();
  runs.start();

  const command = (id: string, fn: () => unknown) => vscode.commands.registerCommand(id, fn);
  const requireSelection = (): string[] | undefined => {
    const ids = controller.selected;
    if (ids.length === 0) void vscode.window.showInformationMessage('Select chat items in the Chat Itemizer sidebar first.');
    return ids.length ? ids : undefined;
  };

  context.subscriptions.push(
    channel,
    store,
    heartbeat,
    sessions,
    runs,
    controller,
    vscode.window.registerWebviewViewProvider('claudeItemizer.sidebar', sidebar, { webviewOptions: { retainContextWhenHidden: true } }),
    command('claudeItemizer.newItem', () => {
      const { state, id } = createItem(store.state, undefined, Date.now());
      store.update(() => state);
      editor.open({ kind: 'item', id });
    }),
    command('claudeItemizer.newCategory', async () => {
      const name = await vscode.window.showInputBox({ prompt: 'Category name', value: 'New category' });
      if (name !== undefined) store.update(s => createCategory(s, name).state);
    }),
    command('claudeItemizer.editDefaults', () => editor.open({ kind: 'defaults' })),
    command('claudeItemizer.submitSelected', () => {
      const ids = requireSelection();
      if (ids) controller.showSubmitDialog(ids);
    }),
    command('claudeItemizer.quickSubmit', async () => {
      const ids = requireSelection();
      if (!ids) return;
      try {
        await runs.submit(ids, 'sequential', { kind: 'active' }, { stopOnError: true, titleAsHeading: true, hideAfter: false, combinedFrom: 'first', concurrency: 1 }, true);
      } catch (err) {
        if (err instanceof UserError && err.code === 'noSession') controller.showSubmitDialog(ids);
        else void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    command('claudeItemizer.export', () => exportItems(store, attachments)),
    command('claudeItemizer.import', () => importItems(store, attachments)),
    command('claudeItemizer.setUpBridge', async () => {
      await vscode.commands.executeCommand('claudeItemizer.sidebar.focus');
      const webview = await sidebar.reveal();
      if (webview) await controller.execute(webview, { op: 'bridge.setUp' });
    }),
    command('claudeItemizer.removeBridge', async () => {
      await removeBridge(log);
      await controller.refreshSetup();
    }),
    command('claudeItemizer.showLog', () => channel.show()),
  );

  void refreshInstalledPlugin(context.extensionUri, log).then(() => controller.refreshSetup());
  setTimeout(() => void controller.collectGarbage(), 30_000);
  log(`activated; bridge host ${heartbeat.hostId}`);
  return { store, runs, sessions, controller };
}

export function deactivate(): void {
  // Disposables in context.subscriptions stop the heartbeat and timers.
}
