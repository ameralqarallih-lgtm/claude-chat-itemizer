// What the extension host and its webviews say to each other.

import type { ItemRun, ModelInfo, SubmitMode } from '../../../bridge-plugin/hooks/protocol';
import type { Defaults, ItemizerState, ItemPatch, SettingKey } from './model';

export type { ModelInfo };

/** A Claude session the bridge plugin reports, as the pickers show it. */
export interface SessionView {
  sessionId: string;
  cwd: string;
  model?: string;
  state: 'idle' | 'busy';
  turns: number;
  firstPrompt?: string;
  /** Claude Code's title for the chat, as its tab shows it. */
  title?: string;
  lastActivityAt: number;
  pluginVersion: string;
  isCompatible: boolean;
  /**
   * False for a Claude process no tab shows (the spare VS Code keeps warm for
   * the next tab), when the sessions report surfaces at all. Prompts sent to
   * one wait unseen, so pickers and Quick skip it.
   */
  hasTab: boolean;
}

export type BridgeStatus =
  | { kind: 'notSetUp' }
  | { kind: 'waiting'; detail: string }
  | { kind: 'connected'; sessions: number }
  | { kind: 'outdated'; detail: string };

export type RunTarget = { kind: 'session'; sessionId: string } | { kind: 'active' } | { kind: 'newTab' } | { kind: 'prefill' };

export interface RunOptions {
  stopOnError: boolean;
  titleAsHeading: boolean;
  hideAfter: boolean;
  /** Combined mode: whose settings the one message uses. */
  combinedFrom: 'first' | 'defaults';
  concurrency: number;
}

export interface RunItemView {
  itemIds: string[];
  title: string;
  run: ItemRun;
  sessionId?: string;
}

export type RunState = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stalled';

export interface RunView {
  id: string;
  createdAt: number;
  mode: SubmitMode;
  quick: boolean;
  state: RunState;
  detail?: string;
  items: RunItemView[];
}

/** An earlier Claude chat of this workspace that is not running now; sending to it reopens it. */
export interface RecentChat {
  sessionId: string;
  title?: string;
  firstPrompt?: string;
  lastUsedAt: number;
}

export interface Snapshot {
  state: ItemizerState;
  sessions: SessionView[];
  /** Earlier chats of this workspace, newest first, not counting the live ones. */
  recentChats: RecentChat[];
  bridge: BridgeStatus;
  runs: RunView[];
  catalog: ModelInfo[];
  /** Webview URIs for image attachment thumbnails, by attachment id. */
  thumbnails: Record<string, string>;
  allowLoosening: boolean;
  hasWorkspace: boolean;
  /** The chat Send to resolves to right now: the picked one if it is live, else the most recently used. */
  resolvedTargetId?: string;
  /** What the editor panel shows. */
  editorTarget?: EditorTarget;
}

export type EditorTarget = { kind: 'item'; id: string } | { kind: 'category'; id: string } | { kind: 'defaults' };

/** Requests from a webview; the host answers each with a Response of the same id. */
export type Op =
  | { op: 'ready' }
  | { op: 'item.create'; categoryId?: string }
  | { op: 'item.update'; id: string; patch: ItemPatch }
  | { op: 'item.setSetting'; id: string; key: SettingKey; value: Defaults[SettingKey] | undefined }
  | { op: 'item.delete'; ids: string[] }
  | { op: 'item.duplicate'; ids: string[] }
  | { op: 'item.move'; id: string; toCategoryId: string; beforeId: string | null }
  | { op: 'category.create'; name?: string }
  | { op: 'category.update'; id: string; patch: { name?: string; color?: string; collapsed?: boolean } }
  | { op: 'category.setSetting'; id: string; key: SettingKey; value: Defaults[SettingKey] | undefined }
  | { op: 'category.delete'; id: string; moveTo: string | null }
  | { op: 'category.move'; id: string; beforeId: string | null }
  | { op: 'defaults.set'; key: SettingKey; value: Defaults[SettingKey] }
  | { op: 'view.set'; hideSubmitted: boolean }
  | { op: 'target.set'; sessionId: string | null }
  | { op: 'selection.set'; ids: string[] }
  | { op: 'attachment.pick'; itemId: string }
  | { op: 'attachment.addBytes'; itemId: string; name: string; mime: string; base64: string }
  | { op: 'attachment.addText'; itemId: string; text: string }
  | { op: 'attachment.addUris'; itemId: string; uris: string[] }
  | { op: 'attachment.remove'; itemId: string; attachmentId: string }
  | { op: 'attachment.open'; itemId: string; attachmentId: string }
  | { op: 'editor.open'; target: EditorTarget }
  | { op: 'editor.close' }
  | { op: 'run.start'; itemIds: string[]; mode: SubmitMode; target: RunTarget; options: RunOptions }
  | { op: 'run.quick'; itemIds: string[] }
  | { op: 'run.cancel'; runId: string; abortCurrent: boolean }
  | { op: 'run.dismiss'; runId: string }
  | { op: 'run.clearFinished' }
  | { op: 'bridge.setUp' }
  | { op: 'claude.newTab' }
  | { op: 'ui.openSubmit'; itemIds: string[] }
  | { op: 'io.export' }
  | { op: 'io.import' }
  | { op: 'confirm'; message: string; confirm: string };

export interface Request {
  type: 'request';
  id: number;
  body: Op;
}

export interface Response {
  type: 'response';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Machine-readable reason, e.g. `noSession` for a quick submit with no chat to send to. */
  code?: string;
}

export type HostMessage = { type: 'snapshot'; snapshot: Snapshot } | Response | { type: 'openSubmit'; itemIds: string[] };
