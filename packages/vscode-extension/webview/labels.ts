import type { EffortLevel } from '../../bridge-plugin/hooks/protocol';
import type { ModelInfo, RunView, SessionView, Snapshot } from '../src/shared/messages';
import type { AttachmentDelivery, EffortChoice, ToolPolicy } from '../src/shared/model';

export const EFFORT_LABELS: Record<EffortChoice, string> = {
  session: "Chat's effort",
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const POLICY_LABELS: Record<ToolPolicy, string> = {
  inherit: 'Claude tab decides',
  readOnly: 'Read-only',
  autoAcceptEdits: 'Auto-accept edits',
};

export const DELIVERY_LABELS: Record<AttachmentDelivery, string> = {
  auto: 'Text inline, images by path',
  pathsOnly: 'Paths only',
};

export function modelLabel(model: string, catalog: readonly ModelInfo[]): string {
  if (model === 'session') return "Chat's model";
  return catalog.find(m => m.id === model)?.label ?? model;
}

/** The short form the item chips use. */
export function modelChip(model: string, catalog: readonly ModelInfo[]): string {
  if (model === 'session') return 'chat model';
  return modelLabel(model, catalog);
}

export function effortSupportedBy(model: string, effort: EffortLevel, catalog: readonly ModelInfo[]): boolean {
  if (model === 'session') return true;
  const base = model.replace(/\[1m\]$/i, '');
  const info = catalog.find(m => m.id === base) ?? catalog.find(m => base.includes(m.id));
  return !info || info.efforts.includes(effort);
}

/** A Claude chat's name: Claude Code's title for it, else its first prompt. */
export function sessionName(s: SessionView): string {
  return s.title ?? (s.firstPrompt ? `“${s.firstPrompt.replace(/^#+\s*/, '')}”` : s.turns > 0 ? 'Untitled chat' : 'New conversation');
}

/** What a Claude chat is doing: working or idle, its model, when it was last used. */
export function sessionMeta(s: SessionView, catalog: readonly ModelInfo[]): string {
  const model = s.model ? modelLabel(s.model, catalog) : '';
  return [s.state === 'busy' ? 'working' : 'idle', model, timeAgo(s.lastActivityAt)].filter(Boolean).join(' · ');
}

/** One line for a native <select>, which cannot wrap. */
export function sessionLabel(s: SessionView, catalog: readonly ModelInfo[]): string {
  return `${sessionName(s)} · ${sessionMeta(s, catalog)}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

export type ItemBadge = { kind: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'sent'; tip: string };

/** What the item's newest run says about it, else whether it was sent before. */
export function itemBadge(snap: Snapshot, itemId: string): ItemBadge | undefined {
  for (const run of snap.runs) {
    const entry = run.items.find(i => i.itemIds.includes(itemId));
    if (!entry) continue;
    const st = entry.run.status;
    const live = run.state === 'running' || run.state === 'starting';
    if (live && (st === 'queued' || st === 'submitting')) return { kind: 'queued', tip: 'Waiting its turn' };
    if (live && st === 'running') return { kind: 'running', tip: 'Claude is working on it' };
    if (st === 'failed' || st === 'unknown' || st === 'interrupted')
      return { kind: 'failed', tip: entry.run.error ?? entry.run.reason ?? 'It did not finish' };
    if (st === 'cancelled' && live) return { kind: 'cancelled', tip: entry.run.reason ?? 'Cancelled' };
    break;
  }
  const item = snap.state.items[itemId];
  if (item?.submittedAt) return { kind: 'sent', tip: `Sent ${timeAgo(item.submittedAt)}` };
  return undefined;
}

export function runLabel(run: RunView): string {
  const n = run.items.length;
  const finished = run.items.filter(i => ['done', 'failed', 'interrupted', 'cancelled', 'unknown'].includes(i.run.status)).length;
  const how = run.quick ? 'Quick submit' : run.mode === 'combined' ? 'One message' : run.mode === 'newConversationPerItem' ? 'New conversation each' : 'One conversation';
  if (run.mode === 'combined') {
    const label = run.state === 'running' || run.state === 'starting' ? `Sending ${run.items[0]?.itemIds.length ?? 0} items as one message` : `${run.items[0]?.itemIds.length ?? 0} items as one message: ${run.state}`;
    return `${label} · ${how}`;
  }
  if (run.state === 'running' || run.state === 'starting') return `Running ${Math.min(finished + 1, n)} of ${n} · ${how}`;
  const state = run.state === 'completed' ? 'Finished' : run.state === 'cancelled' ? 'Cancelled' : run.state === 'stalled' ? 'Stopped' : 'Finished with problems';
  return `${state} · ${finished} of ${n} · ${how}`;
}
