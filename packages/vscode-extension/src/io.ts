import * as vscode from 'vscode';

import type { AttachmentStore } from './attachments';
import { type ItemizerState, mergeStates, normalizeState } from './shared/model';
import type { Store } from './store';

interface ExportFile {
  format: 'claude-chat-itemizer';
  version: 1;
  exportedAt: number;
  state: ItemizerState;
  /** Stored attachment copies, base64, by file name. */
  blobs: Record<string, string>;
}

export async function exportItems(store: Store, attachments: AttachmentStore): Promise<void> {
  const uri = await vscode.window.showSaveDialog({
    filters: { 'Chat items': ['json'] },
    saveLabel: 'Export',
    defaultUri: vscode.workspace.workspaceFolders?.[0] ? vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'chat-items.json') : undefined,
  });
  if (!uri) return;
  const state = store.state;
  const blobs: Record<string, string> = {};
  for (const item of Object.values(state.items)) {
    for (const a of item.attachments) {
      if (a.source.mode !== 'copy' || blobs[a.source.file]) continue;
      try {
        blobs[a.source.file] = (await attachments.readCopy(a.source.file)).toString('base64');
      } catch {
        // a missing copy exports as a broken attachment
      }
    }
  }
  const file: ExportFile = { format: 'claude-chat-itemizer', version: 1, exportedAt: Date.now(), state, blobs };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(file, null, 2), 'utf8'));
  void vscode.window.showInformationMessage(`Exported ${Object.keys(state.items).length} chat items.`);
}

export async function importItems(store: Store, attachments: AttachmentStore): Promise<void> {
  const [uri] =
    (await vscode.window.showOpenDialog({ filters: { 'Chat items': ['json'] }, canSelectMany: false, openLabel: 'Import' })) ?? [];
  if (!uri) return;
  let file: ExportFile;
  try {
    file = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as ExportFile;
  } catch {
    void vscode.window.showErrorMessage('That file is not valid JSON.');
    return;
  }
  if (file.format !== 'claude-chat-itemizer' || !file.state) {
    void vscode.window.showErrorMessage('That file is not a Chat Itemizer export.');
    return;
  }
  const how = await vscode.window.showQuickPick(
    [
      { label: 'Add to my items', description: 'Keeps what you have; imported categories with the same name are merged', value: 'merge' },
      { label: 'Replace my items', description: 'Deletes every current item and category first', value: 'replace' },
    ],
    { title: 'Import chat items' },
  );
  if (!how) return;

  if (attachments.available) {
    for (const [name, base64] of Object.entries(file.blobs ?? {})) {
      await attachments.addBytes(name, Buffer.from(base64, 'base64')).catch(() => undefined);
    }
  }
  // addBytes stores by content hash, so the exported file names still match.
  const incoming = normalizeState(file.state);
  if (how.value === 'replace') {
    store.replace(incoming);
  } else {
    store.update(current => mergeStates(current, incoming));
  }
  void vscode.window.showInformationMessage(`Imported ${Object.keys(incoming.items).length} chat items.`);
}
