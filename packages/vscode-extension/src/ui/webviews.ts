import * as vscode from 'vscode';

import type { AttachmentStore } from '../attachments';
import type { Controller } from '../controller';
import type { EditorTarget } from '../shared/messages';
import { displayTitle } from '../shared/model';
import type { Store } from '../store';

export type Route = 'sidebar' | 'editor';

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export function webviewOptions(extensionUri: vscode.Uri, attachments: AttachmentStore): vscode.WebviewOptions {
  const roots = [vscode.Uri.joinPath(extensionUri, 'dist')];
  const att = attachments.rootUri();
  if (att) roots.push(att);
  return { enableScripts: true, localResourceRoots: roots };
}

export function html(webview: vscode.Webview, extensionUri: vscode.Uri, route: Route): string {
  const n = nonce();
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${css}">
<title>Chat Itemizer</title>
</head>
<body data-route="${route}">
<div id="root"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly attachments: AttachmentStore,
    private readonly controller: Controller,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri, this.attachments);
    view.webview.html = html(view.webview, this.extensionUri, 'sidebar');
    const sub = this.controller.attach(view.webview);
    view.onDidDispose(() => {
      sub.dispose();
      this.view = undefined;
    });
  }

  async reveal(): Promise<vscode.Webview | undefined> {
    if (!this.view) await vscode.commands.executeCommand('claudeItemizer.sidebar.focus');
    else this.view.show(true);
    return this.view?.webview;
  }
}

/** One editor tab that shows whichever item, category or the defaults the person opened. */
export class EditorPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly attachments: AttachmentStore,
    private readonly controller: Controller,
    private readonly store: Store,
  ) {
    store.onDidChange(() => this.retitle());
  }

  open(target: EditorTarget): void {
    this.controller.setEditorTarget(target);
    if (this.panel) {
      this.panel.reveal(undefined, false);
      this.retitle();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'claudeItemizer.editor',
      'Chat Item',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { ...webviewOptions(this.extensionUri, this.attachments), retainContextWhenHidden: true },
    );
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    panel.webview.html = html(panel.webview, this.extensionUri, 'editor');
    const sub = this.controller.attach(panel.webview);
    panel.onDidDispose(() => {
      sub.dispose();
      this.panel = undefined;
      this.controller.setEditorTarget(undefined);
    });
    this.panel = panel;
    this.retitle();
  }

  close(): void {
    this.panel?.dispose();
  }

  private retitle(): void {
    if (!this.panel) return;
    const t = this.controller.currentEditorTarget;
    const s = this.store.state;
    this.panel.title =
      t?.kind === 'item' && s.items[t.id]
        ? `Edit: ${displayTitle(s.items[t.id]!)}`
        : t?.kind === 'category' && s.categories[t.id]
          ? `Category: ${s.categories[t.id]!.name}`
          : t?.kind === 'defaults'
            ? 'Itemizer Defaults'
            : 'Chat Item';
  }
}
