import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

import type { BatchAttachment } from '../../bridge-plugin/hooks/protocol';
import { type Attachment, type AttachmentDelivery, type AttachmentKind, newId } from './shared/model';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Text larger than this goes to Claude as a path to read instead of inline context. */
const INLINE_TEXT_LIMIT = 200 * 1024;

const IMAGE = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' } as const;
const TEXT_EXT = new Set(
  'txt md markdown json jsonc yaml yml toml ini cfg conf csv tsv xml html htm css scss less js mjs cjs jsx ts tsx mts cts py rb go rs java kt kts c h cc cpp hpp cs fs swift php sh bash zsh ps1 psm1 bat cmd sql graphql gql proto vue svelte astro log env gitignore dockerfile makefile gradle properties lua r dart scala clj ex exs erl hs ml tf hcl'.split(
    ' ',
  ),
);

export function classify(name: string, mime?: string): { kind: AttachmentKind; mime: string } {
  const ext = path.extname(name).slice(1).toLowerCase();
  if (ext in IMAGE) return { kind: 'image', mime: IMAGE[ext as keyof typeof IMAGE] };
  if (mime?.startsWith('image/')) return { kind: 'image', mime };
  if (ext === 'pdf' || mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (TEXT_EXT.has(ext) || TEXT_EXT.has(path.basename(name).toLowerCase()) || mime?.startsWith('text/')) {
    return { kind: 'text', mime: mime && mime.startsWith('text/') ? mime : 'text/plain' };
  }
  return { kind: 'binary', mime: mime || 'application/octet-stream' };
}

/** Text when the first 8 KB holds no NUL byte. */
function looksLikeText(buf: Buffer): boolean {
  return !buf.subarray(0, 8192).includes(0);
}

/** Attachment copies, stored once per content hash under the workspace's storage folder. */
export class AttachmentStore {
  constructor(private readonly storage: vscode.Uri | undefined) {}

  get available(): boolean {
    return this.storage !== undefined;
  }

  get root(): string {
    if (!this.storage) throw new Error('Open a folder or workspace to store attachments.');
    return path.join(this.storage.fsPath, 'attachments');
  }

  rootUri(): vscode.Uri | undefined {
    return this.storage ? vscode.Uri.joinPath(this.storage, 'attachments') : undefined;
  }

  absPath(a: Attachment): string {
    return a.source.mode === 'copy' ? path.join(this.root, a.source.file) : a.source.path;
  }

  async addBytes(name: string, buf: Buffer, mime?: string): Promise<Attachment> {
    if (buf.byteLength > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is larger than 25 MB.`);
    let { kind, mime: m } = classify(name, mime);
    if (kind === 'binary' && looksLikeText(buf)) ({ kind, mime: m } = { kind: 'text', mime: 'text/plain' });
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const ext = path.extname(name).toLowerCase() || (kind === 'image' ? `.${m.split('/')[1]}` : kind === 'text' ? '.txt' : '');
    const file = `${sha256.slice(0, 32)}${ext}`;
    await fs.mkdir(this.root, { recursive: true });
    const dest = path.join(this.root, file);
    try {
      await fs.access(dest);
    } catch {
      await fs.writeFile(dest, buf);
    }
    return { id: newId('a'), name, kind, mime: m, size: buf.byteLength, addedAt: Date.now(), source: { mode: 'copy', file, sha256 } };
  }

  async addFile(uri: vscode.Uri): Promise<Attachment> {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) throw new Error(`${path.basename(uri.fsPath)} is a folder.`);
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(uri.fsPath)} is larger than 25 MB.`);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return this.addBytes(path.basename(uri.fsPath), Buffer.from(bytes));
  }

  /** A link to the file as it is when the item runs, not a copy. */
  async addReference(uri: vscode.Uri): Promise<Attachment> {
    const stat = await vscode.workspace.fs.stat(uri);
    const name = path.basename(uri.fsPath);
    const { kind, mime } = classify(name);
    return { id: newId('a'), name, kind, mime, size: stat.size, addedAt: Date.now(), source: { mode: 'reference', path: uri.fsPath } };
  }

  /** What the bridge needs for one attachment: where it is and how Claude gets it. */
  toBatch(a: Attachment, delivery: AttachmentDelivery): BatchAttachment {
    const inline = delivery === 'auto' && a.kind === 'text' && a.size <= INLINE_TEXT_LIMIT;
    return { name: a.name, kind: a.kind, mime: a.mime, size: a.size, absPath: this.absPath(a), delivery: inline ? 'inline' : 'path' };
  }

  /** Deletes stored copies no item (and no unfinished run) refers to. */
  async collect(keep: Set<string>): Promise<number> {
    if (!this.storage) return 0;
    let removed = 0;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.root);
    } catch {
      return 0;
    }
    for (const n of names) {
      if (keep.has(n)) continue;
      await fs.rm(path.join(this.root, n), { force: true }).catch(() => undefined);
      removed++;
    }
    return removed;
  }

  async readCopy(file: string): Promise<Buffer> {
    return fs.readFile(path.join(this.root, file));
  }
}
