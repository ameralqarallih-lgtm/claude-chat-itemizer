// The file protocol between the Claude Chat Itemizer VS Code extension and the
// itemizer-bridge plugin. Pure TypeScript with no imports: the plugin's hooks
// environment has no Node, and the extension bundles this same file.
//
// Layout under the bridge root (default ~/.claude/itemizer/v1):
//   hosts/<hostId>.json                    extension heartbeat (HostFile)
//   sessions/<sid>/presence.json           plugin heartbeat (Presence)
//   sessions/<sid>/inbox/<batchId>.json    extension -> plugin (BatchFile)
//   sessions/<sid>/inbox/control.json      extension -> plugin (ControlFile)
//   sessions/<sid>/outbox/<batchId>.json   plugin -> extension (StatusFile)
//   claims/<nonce>.json                    extension -> /itemizer-run (ClaimFile)
//
// Ownership: each file has one writer. The plugin cannot rename or delete, so
// its writes are not atomic; readers retry a file that does not parse and
// ignore one whose `seq` is not newer. Only the extension deletes files.

export const PROTOCOL = 1;
export const PLUGIN_NAME = 'itemizer-bridge';
export const PLUGIN_VERSION = '0.3.0';

/** A presence older than this is treated as a closed session. */
export const PRESENCE_TTL_MS = 8_000;
/** A host heartbeat older than this no longer wakes a dormant plugin. */
export const HOST_TTL_MS = 10_000;

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** How the bridge limits tools while an item's turn runs; `inherit` changes nothing. */
export type ToolPolicy = 'inherit' | 'readOnly' | 'autoAcceptEdits';

export type SubmitMode = 'sequential' | 'newConversationPerItem' | 'combined';

export type AttachmentKind = 'image' | 'pdf' | 'text' | 'binary';

export interface BatchAttachment {
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  /** Absolute path the plugin reads (text) or hands to Claude's Read tool (image, pdf). */
  absPath: string;
  /** `inline`: the plugin reads the file and adds it as hidden context. `path`: Claude opens it. */
  delivery: 'inline' | 'path';
}

export interface BatchItemSettings {
  /** Absent: the turn keeps the session's model. */
  model?: string;
  /** Absent: the turn keeps the session's effort. */
  effort?: EffortLevel;
  toolPolicy: ToolPolicy;
  /** Hidden instructions placed before the attachments. */
  preamble?: string;
  /** Quick submit: no overrides at all, the chat's own settings apply. */
  quick?: boolean;
}

export interface BatchItem {
  /** Position in the batch, from 0. */
  seq: number;
  /** The chat items this entry stands for: one, or several for a combined message. */
  itemIds: string[];
  title?: string;
  /** The exact prompt text the plugin submits. */
  text: string;
  settings: BatchItemSettings;
  attachments: BatchAttachment[];
}

export interface BatchOptions {
  stopOnError: boolean;
  /** Wait after a turn ends before sending the next item. */
  settleMs: number;
}

export interface BatchFile {
  protocol: number;
  batchId: string;
  hostId: string;
  createdAt: number;
  mode: SubmitMode;
  options: BatchOptions;
  items: BatchItem[];
}

export type ItemRunStatus =
  | 'queued'
  | 'submitting'
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'cancelled'
  | 'unknown';

export const TERMINAL_STATUSES: readonly ItemRunStatus[] = ['done', 'failed', 'interrupted', 'cancelled', 'unknown'];

export interface ItemRun {
  seq: number;
  status: ItemRunStatus;
  turnId?: string;
  startedAt?: number;
  endedAt?: number;
  /** turn.complete's reason, or what stopped the item. */
  reason?: string;
  appliedModel?: string;
  warnings?: string[];
  answerPreview?: string;
  error?: string;
}

export type BatchState = 'running' | 'completed' | 'failed' | 'cancelled';

export interface StatusFile {
  protocol: number;
  batchId: string;
  sessionId: string;
  seq: number;
  updatedAt: number;
  state: BatchState;
  items: ItemRun[];
}

export interface Presence {
  protocol: number;
  pluginVersion: string;
  sessionId: string;
  cwd: string;
  startedAt: number;
  lastSeen: number;
  seq: number;
  state: 'idle' | 'busy';
  turns: number;
  model?: string;
  /** The first prompt of the conversation, shortened, so the picker can name it. */
  firstPrompt?: string;
  /** The title Claude Code gives the conversation (the tab's label), once it has one. */
  title?: string;
  /** When the last main-loop turn started or ended: "most recently active". */
  lastActivityAt?: number;
  activeBatchIds: string[];
  /**
   * Where the session draws (`vscode`, `terminal`, ...). Empty for a Claude
   * process no tab shows yet, such as the spare VS Code keeps warm for the
   * next tab: a prompt sent there waits unseen. Absent from older plugins.
   */
  surfaces?: string[];
  ended?: { at: number; reason: string };
}

export interface HostFile {
  protocol: number;
  hostId: string;
  workspaceFolders: string[];
  lastSeen: number;
}

export interface ControlCommand {
  seq: number;
  kind: 'cancel' | 'abortCurrent';
  batchId: string;
}

export interface ControlFile {
  seq: number;
  commands: ControlCommand[];
}

export interface ClaimFile {
  protocol: number;
  nonce: string;
  expiresAt: number;
  batch: BatchFile;
}

// ---------- paths ----------

/** Joins with `/`, which every file API on Windows also accepts. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter(p => p !== '')
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .join('/');
}

export function bridgePaths(root: string) {
  const session = (sid: string) => joinPath(root, 'sessions', sid);
  return {
    root,
    hosts: joinPath(root, 'hosts'),
    host: (hostId: string) => joinPath(root, 'hosts', `${hostId}.json`),
    sessions: joinPath(root, 'sessions'),
    session,
    presence: (sid: string) => joinPath(session(sid), 'presence.json'),
    inbox: (sid: string) => joinPath(session(sid), 'inbox'),
    inboxBatch: (sid: string, batchId: string) => joinPath(session(sid), 'inbox', `${batchId}.json`),
    control: (sid: string) => joinPath(session(sid), 'inbox', 'control.json'),
    outbox: (sid: string) => joinPath(session(sid), 'outbox'),
    outboxBatch: (sid: string, batchId: string) => joinPath(session(sid), 'outbox', `${batchId}.json`),
    claims: joinPath(root, 'claims'),
    claim: (nonce: string) => joinPath(root, 'claims', `${nonce}.json`),
  };
}

export type BridgePaths = ReturnType<typeof bridgePaths>;

/** For comparing paths only: forward slashes, no trailing slash, case folded on drive-letter paths. */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (out.length > 1) out = out.replace(/\/$/, '');
  if (/^[a-zA-Z]:/.test(out) || out.startsWith('//')) out = out.toLowerCase();
  return out;
}

/** True when `child` is `parent` or lies inside it. */
export function isWithin(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** Ids safe to use as file names. */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

// ---------- models ----------

export interface ModelInfo {
  id: string;
  label: string;
  /** Effort levels the model accepts; empty when it takes none. */
  efforts: readonly EffortLevel[];
}

/**
 * What the pickers offer. Aliases resolve the way `/model` does. The effort
 * lists are the bridge's best knowledge and only gate a warning plus dropping
 * an effort the model would reject; the setting
 * `claudeItemizer.modelCatalogOverrides` can correct them.
 */
export const MODEL_CATALOG: readonly ModelInfo[] = [
  { id: 'opus', label: 'Opus', efforts: EFFORT_LEVELS },
  { id: 'sonnet', label: 'Sonnet', efforts: EFFORT_LEVELS },
  { id: 'haiku', label: 'Haiku', efforts: ['low', 'medium', 'high'] },
  { id: 'fable', label: 'Fable', efforts: EFFORT_LEVELS },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: EFFORT_LEVELS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: EFFORT_LEVELS },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: EFFORT_LEVELS },
];

export function modelInfo(model: string, catalog: readonly ModelInfo[] = MODEL_CATALOG): ModelInfo | undefined {
  const base = model.replace(/\[1m\]$/i, '');
  return catalog.find(m => m.id === base) ?? catalog.find(m => base.includes(m.id));
}

/** Whether `effort` can be sent with `model`; unknown models are assumed to take every level. */
export function effortSupported(model: string, effort: EffortLevel, catalog: readonly ModelInfo[] = MODEL_CATALOG): boolean {
  const info = modelInfo(model, catalog);
  return info === undefined || info.efforts.includes(effort);
}

// ---------- prompt building (shared so the tests pin one wording) ----------

export function attachmentBlock(a: BatchAttachment, content: string): string {
  return `<itemizer-attachment name="${escapeAttr(a.name)}" path="${escapeAttr(a.absPath)}" mime="${escapeAttr(a.mime)}">\n${content}\n</itemizer-attachment>`;
}

export function pathAttachmentsBlock(list: readonly BatchAttachment[]): string {
  const lines = list.map(a => `- ${a.absPath} (${a.kind}, ${a.name})`);
  return [
    'The user attached these files to their next message. Open each one with the Read tool before answering it' +
      (list.some(a => a.kind === 'pdf') ? ' (for a long PDF, read it by pages)' : '') +
      ':',
    ...lines,
  ].join('\n');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Shortens text to one line of at most `max` characters. */
export function preview(text: string, max = 160): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// ---------- parsing ----------

export function parseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

export function isBatchFile(v: unknown): v is BatchFile {
  const b = v as BatchFile;
  return (
    typeof b === 'object' &&
    b !== null &&
    b.protocol === PROTOCOL &&
    typeof b.batchId === 'string' &&
    isSafeId(b.batchId) &&
    Array.isArray(b.items) &&
    b.items.every(i => typeof i.text === 'string' && typeof i.seq === 'number' && Array.isArray(i.attachments))
  );
}
