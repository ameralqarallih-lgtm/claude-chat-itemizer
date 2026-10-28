import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { type ModelInfo, MODEL_CATALOG, PLUGIN_VERSION } from '../../bridge-plugin/hooks/protocol';
import type { AttachmentStore } from './attachments';
import { type BridgeSetup, setUpBridge, setupState } from './bridge/installer';
import { bridgeRoot } from './bridge/host';
import type { SessionRegistry } from './bridge/sessions';
import { exportItems, importItems } from './io';
import { type RunCoordinator, UserError } from './run/coordinator';
import type { BridgeStatus, EditorTarget, HostMessage, Op, Request, RunOptions, Snapshot } from './shared/messages';
import {
  type Attachment,
  createCategory,
  createItem,
  deleteCategory,
  deleteItems,
  displayTitle,
  duplicateItems,
  moveCategory,
  moveItem,
  referencedFiles,
  setCategorySetting,
  setItemSetting,
  updateCategory,
  updateItem,
} from './shared/model';
import type { Store } from './store';

const QUICK_OPTIONS: RunOptions = { stopOnError: true, titleAsHeading: true, hideAfter: false, combinedFrom: 'first', concurrency: 1 };

/** Serves every webview's requests and keeps them all showing the same snapshot. */
export class Controller implements vscode.Disposable {
  private readonly views = new Set<vscode.Webview>();
  private selection: string[] = [];
  private setup: BridgeSetup = 'notSetUp';
  private editorTarget: EditorTarget | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private pending: NodeJS.Timeout | undefined;
  /** Opens or reveals the editor panel; set by extension.ts. */
  openEditor: (target: EditorTarget) => void = () => undefined;
  /** Asks the sidebar to open its submit dialog; set by extension.ts. */
  showSubmitDialog: (itemIds: string[]) => void = () => undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: Store,
    private readonly attachments: AttachmentStore,
    private readonly sessions: SessionRegistry,
    private readonly runs: RunCoordinator,
    private readonly log: (s: string) => void,
  ) {
    const refresh = () => this.broadcastSoon();
    this.disposables.push(
      store.onDidChange(refresh),
      sessions.onDidChange(refresh),
      runs.onDidChange(refresh),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeCode.environmentVariables') || e.affectsConfiguration('claudeItemizer')) void this.refreshSetup();
      }),
    );
    void this.refreshSetup();
  }

  get selected(): string[] {
    return this.selection.filter(id => this.store.state.items[id]);
  }

  get currentEditorTarget(): EditorTarget | undefined {
    return this.editorTarget;
  }

  setEditorTarget(t: EditorTarget | undefined): void {
    this.editorTarget = t;
    this.broadcastSoon();
  }

  attach(webview: vscode.Webview): vscode.Disposable {
    this.views.add(webview);
    const sub = webview.onDidReceiveMessage((m: Request) => void this.handle(webview, m));
    return new vscode.Disposable(() => {
      this.views.delete(webview);
      sub.dispose();
    });
  }

  post(webview: vscode.Webview, msg: HostMessage): void {
    void webview.postMessage(msg);
  }

  postAll(msg: HostMessage): void {
    for (const v of this.views) this.post(v, msg);
  }

  async refreshSetup(): Promise<void> {
    this.setup = await setupState();
    this.broadcastSoon();
  }

  private broadcastSoon(): void {
    if (this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      for (const v of this.views) this.post(v, { type: 'snapshot', snapshot: this.snapshot(v) });
    }, 16);
  }

  private bridgeStatus(): BridgeStatus {
    const live = this.sessions.list();
    const incompatible = live.find(s => !s.isCompatible);
    if (incompatible) return { kind: 'outdated', detail: `A Claude chat runs bridge ${incompatible.pluginVersion}; this extension needs ${PLUGIN_VERSION}. Open a new Claude tab.` };
    if (live.length > 0) return { kind: 'connected', sessions: live.length };
    if (this.setup === 'notSetUp') return { kind: 'notSetUp' };
    if (this.setup === 'outdated') return { kind: 'outdated', detail: 'The installed bridge plugin is older than this extension. Set it up again.' };
    return { kind: 'waiting', detail: 'No Claude chat in this folder is connected. Open a new Claude tab: tabs opened before the bridge was set up do not load it.' };
  }

  private catalog(): ModelInfo[] {
    const extra = vscode.workspace.getConfiguration('claudeItemizer').get<ModelInfo[]>('modelCatalogOverrides', []) ?? [];
    const out = [...MODEL_CATALOG];
    for (const m of extra) {
      if (!m || typeof m.id !== 'string') continue;
      const entry: ModelInfo = { id: m.id, label: m.label || m.id, efforts: Array.isArray(m.efforts) ? m.efforts : MODEL_CATALOG[0]!.efforts };
      const at = out.findIndex(x => x.id === m.id);
      if (at >= 0) out[at] = entry;
      else out.push(entry);
    }
    return out;
  }

  private snapshot(webview: vscode.Webview): Snapshot {
    const state = this.store.state;
    const thumbnails: Record<string, string> = {};
    if (this.attachments.available) {
      for (const item of Object.values(state.items)) {
        for (const a of item.attachments) {
          if (a.kind !== 'image' || a.source.mode !== 'copy') continue;
          thumbnails[a.id] = webview.asWebviewUri(vscode.Uri.file(this.attachments.absPath(a))).toString();
        }
      }
    }
    return {
      state,
      sessions: this.sessions.list(),
      bridge: this.bridgeStatus(),
      runs: this.runs.views(),
      catalog: this.catalog(),
      thumbnails,
      allowLoosening: vscode.workspace.getConfiguration('claudeItemizer').get<boolean>('allowLooseningPolicies', false),
      hasWorkspace: this.attachments.available,
      editorTarget: this.editorTarget,
      resolvedTargetId: this.resolvedTarget(),
    };
  }

  private resolvedTarget(): string | undefined {
    const picked = this.store.state.view.targetSessionId;
    if (picked) return this.sessions.targetable().some(s => s.sessionId === picked) ? picked : undefined;
    return this.sessions.mostRecentlyActive()?.sessionId;
  }

  private async handle(webview: vscode.Webview, m: Request): Promise<void> {
    if (!m || m.type !== 'request') return;
    try {
      const result = await this.execute(webview, m.body);
      this.post(webview, { type: 'response', id: m.id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof UserError)) this.log(`${m.body.op} failed: ${message}`);
      this.post(webview, { type: 'response', id: m.id, ok: false, error: message, code: err instanceof UserError ? err.code : undefined });
    }
  }

  async execute(webview: vscode.Webview, op: Op): Promise<unknown> {
    const now = Date.now();
    const s = this.store;
    switch (op.op) {
      case 'ready':
        this.post(webview, { type: 'snapshot', snapshot: this.snapshot(webview) });
        return undefined;
      case 'item.create': {
        const { state, id } = createItem(s.state, op.categoryId, now);
        s.update(() => state);
        this.openEditor({ kind: 'item', id });
        return id;
      }
      case 'item.update':
        s.update(st => updateItem(st, op.id, op.patch, now));
        return undefined;
      case 'item.setSetting':
        s.update(st => setItemSetting(st, op.id, op.key, op.value, now));
        return undefined;
      case 'item.delete':
        s.update(st => deleteItems(st, op.ids));
        this.selection = this.selection.filter(id => !op.ids.includes(id));
        if (this.editorTarget?.kind === 'item' && op.ids.includes(this.editorTarget.id)) this.setEditorTarget(undefined);
        return undefined;
      case 'item.duplicate': {
        let ids: string[] = [];
        s.update(st => {
          const r = duplicateItems(st, op.ids, now);
          ids = r.ids;
          return r.state;
        });
        return ids;
      }
      case 'item.move':
        s.update(st => moveItem(st, op.id, op.toCategoryId, op.beforeId));
        return undefined;
      case 'category.create': {
        const { state, id } = createCategory(s.state, op.name ?? 'New category');
        s.update(() => state);
        return id;
      }
      case 'category.update':
        s.update(st => updateCategory(st, op.id, op.patch));
        return undefined;
      case 'category.setSetting':
        s.update(st => setCategorySetting(st, op.id, op.key, op.value));
        return undefined;
      case 'category.delete':
        s.update(st => deleteCategory(st, op.id, op.moveTo));
        if (this.editorTarget?.kind === 'category' && this.editorTarget.id === op.id) this.setEditorTarget(undefined);
        return undefined;
      case 'category.move':
        s.update(st => moveCategory(st, op.id, op.beforeId));
        return undefined;
      case 'defaults.set':
        s.update(st => ({ ...st, defaults: { ...st.defaults, [op.key]: op.value } }));
        return undefined;
      case 'view.set':
        s.update(st => ({ ...st, view: { ...st.view, hideSubmitted: op.hideSubmitted } }));
        return undefined;
      case 'target.set':
        s.update(st => {
          const view = { ...st.view };
          if (op.sessionId) view.targetSessionId = op.sessionId;
          else delete view.targetSessionId;
          return { ...st, view };
        });
        return undefined;
      case 'selection.set':
        this.selection = op.ids;
        return undefined;
      case 'attachment.pick': {
        const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Attach' });
        if (uris?.length) await this.addAttachments(op.itemId, uris.map(u => () => this.attachments.addFile(u)));
        return undefined;
      }
      case 'attachment.addBytes':
        await this.addAttachments(op.itemId, [() => this.attachments.addBytes(op.name, Buffer.from(op.base64, 'base64'), op.mime)]);
        return undefined;
      case 'attachment.addText': {
        const n = (s.state.items[op.itemId]?.attachments.filter(a => a.name.startsWith('pasted-text-')).length ?? 0) + 1;
        await this.addAttachments(op.itemId, [() => this.attachments.addBytes(`pasted-text-${n}.txt`, Buffer.from(op.text, 'utf8'), 'text/plain')]);
        return undefined;
      }
      case 'attachment.addUris': {
        const uris = op.uris.map(u => vscode.Uri.parse(u)).filter(u => u.scheme === 'file');
        await this.addAttachments(op.itemId, uris.map(u => () => this.attachments.addFile(u)));
        return undefined;
      }
      case 'attachment.remove': {
        const item = s.state.items[op.itemId];
        if (item) s.update(st => updateItem(st, op.itemId, { attachments: item.attachments.filter(a => a.id !== op.attachmentId) }, now));
        return undefined;
      }
      case 'attachment.open': {
        const a = s.state.items[op.itemId]?.attachments.find(x => x.id === op.attachmentId);
        if (a) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.attachments.absPath(a)));
        return undefined;
      }
      case 'editor.open':
        this.openEditor(op.target);
        return undefined;
      case 'run.start':
        return this.runs.submit(op.itemIds, op.mode, op.target, op.options);
      case 'run.quick':
        return this.runs.submit(op.itemIds, 'sequential', { kind: 'active' }, QUICK_OPTIONS, true);
      case 'run.cancel':
        await this.runs.cancel(op.runId, op.abortCurrent);
        return undefined;
      case 'run.dismiss':
        this.runs.dismiss(op.runId);
        return undefined;
      case 'run.clearFinished':
        this.runs.clearFinished();
        return undefined;
      case 'bridge.setUp': {
        const root = bridgeRoot();
        const defaultRoot = path.join(os.homedir(), '.claude', 'itemizer', 'v1');
        await setUpBridge(this.context.extensionUri, path.resolve(root) === path.resolve(defaultRoot) ? undefined : root, this.log);
        await this.refreshSetup();
        return undefined;
      }
      case 'claude.newTab':
        await vscode.commands.executeCommand('claude-vscode.editor.open');
        return undefined;
      case 'ui.openSubmit':
        this.showSubmitDialog(op.itemIds);
        return undefined;
      case 'io.export':
        await exportItems(s, this.attachments);
        return undefined;
      case 'io.import':
        await importItems(s, this.attachments);
        return undefined;
      case 'confirm': {
        const pick = await vscode.window.showWarningMessage(op.message, { modal: true }, op.confirm);
        return pick === op.confirm;
      }
    }
  }

  private async addAttachments(itemId: string, makers: (() => Promise<Attachment>)[]): Promise<void> {
    if (!this.attachments.available) throw new UserError('Open a folder or workspace to add attachments.');
    const added: Attachment[] = [];
    for (const make of makers) {
      try {
        added.push(await make());
      } catch (err) {
        void vscode.window.showWarningMessage(err instanceof Error ? err.message : String(err));
      }
    }
    if (!added.length) return;
    this.store.update(st => {
      const item = st.items[itemId];
      return item ? updateItem(st, itemId, { attachments: [...item.attachments, ...added] }, Date.now()) : st;
    });
  }

  /** Deletes stored attachment copies nothing refers to. */
  async collectGarbage(): Promise<void> {
    const keep = referencedFiles(this.store.state);
    for (const f of this.runs.filesInUse()) keep.add(f);
    const n = await this.attachments.collect(keep);
    if (n) this.log(`removed ${n} unused attachment file(s)`);
  }

  describeSelection(): string {
    const ids = this.selected;
    return ids.length === 1 ? `“${displayTitle(this.store.state.items[ids[0]!]!)}”` : `${ids.length} items`;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
