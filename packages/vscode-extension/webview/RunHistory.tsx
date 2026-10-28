import type { ItemRunStatus } from '../../bridge-plugin/hooks/protocol';
import type { RunItemView, RunView, Snapshot } from '../src/shared/messages';
import { send } from './api';
import { Icon, type IconName } from './icons';
import { modelLabel, runLabel } from './labels';

/** What the person has opened or closed; anything not listed uses the default. */
export interface HistoryUi {
  open: boolean;
  groups: Record<string, boolean>;
  runs: Record<string, boolean>;
}

export const DEFAULT_HISTORY_UI: HistoryUi = { open: true, groups: {}, runs: {} };

type GroupKey = 'running' | 'today' | 'yesterday' | 'earlier';
const GROUP_LABELS: Record<GroupKey, string> = { running: 'Running', today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' };
/** Finished runs from before today start folded. */
const GROUP_OPEN_BY_DEFAULT: Record<GroupKey, boolean> = { running: true, today: true, yesterday: false, earlier: false };

const isLive = (r: RunView) => r.state === 'running' || r.state === 'starting';

function groupOf(run: RunView, now: Date): GroupKey {
  if (isLive(run)) return 'running';
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (run.createdAt >= day) return 'today';
  if (run.createdAt >= day - 86_400_000) return 'yesterday';
  return 'earlier';
}

export function RunHistory({
  snap,
  ui,
  onUi,
  onSelect,
}: {
  snap: Snapshot;
  ui: HistoryUi;
  onUi: (next: HistoryUi) => void;
  onSelect: (itemIds: string[]) => void;
}) {
  const runs = snap.runs;
  if (runs.length === 0) return null;

  const now = new Date();
  const groups = new Map<GroupKey, RunView[]>();
  for (const run of runs) {
    const key = groupOf(run, now);
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  const live = runs.filter(isLive).length;
  const finished = runs.length - live;
  const groupOpen = (k: GroupKey) => ui.groups[k] ?? GROUP_OPEN_BY_DEFAULT[k];
  const runOpen = (r: RunView) => ui.runs[r.id] ?? isLive(r);

  return (
    <section className="history" aria-label="Run history">
      <div className="history-header">
        <button className="disclosure" aria-expanded={ui.open} onClick={() => onUi({ ...ui, open: !ui.open })}>
          <Icon name="chev" size={12} className="chev" />
          <span>Runs</span>
          <span className="count">{runs.length}</span>
          {live > 0 && (
            <span className="status running">
              <span className="spin" /> {live} running
            </span>
          )}
        </button>
        {ui.open && finished > 0 && (
          <button className="link small" onClick={() => send({ op: 'run.clearFinished' })} title="Remove every finished run from the list">
            Clear finished
          </button>
        )}
      </div>
      {ui.open &&
        (['running', 'today', 'yesterday', 'earlier'] as const).map(key => {
          const list = groups.get(key);
          if (!list?.length) return null;
          const open = groupOpen(key);
          return (
            <div key={key} className="history-group">
              <button className="disclosure group" aria-expanded={open} onClick={() => onUi({ ...ui, groups: { ...ui.groups, [key]: !open } })}>
                <Icon name="chev" size={11} className="chev" />
                <span>{GROUP_LABELS[key]}</span>
                <span className="count">{list.length}</span>
              </button>
              {open &&
                list.map(run => (
                  <RunRow
                    key={run.id}
                    run={run}
                    snap={snap}
                    open={runOpen(run)}
                    onToggle={() => onUi({ ...ui, runs: { ...ui.runs, [run.id]: !runOpen(run) } })}
                    onSelect={onSelect}
                  />
                ))}
            </div>
          );
        })}
    </section>
  );
}

const RUN_ICON: Record<RunView['state'], IconName> = {
  starting: 'bolt',
  running: 'bolt',
  completed: 'check',
  failed: 'warn',
  stalled: 'warn',
  cancelled: 'x',
};

function RunRow({ run, snap, open, onToggle, onSelect }: { run: RunView; snap: Snapshot; open: boolean; onToggle: () => void; onSelect: (ids: string[]) => void }) {
  const live = isLive(run);
  const done = run.items.filter(i => !['queued', 'submitting', 'running'].includes(i.run.status)).length;
  const itemIds = [...new Set(run.items.flatMap(i => i.itemIds))].filter(id => snap.state.items[id]);
  const warnings = run.items.flatMap(i => i.run.warnings ?? []);
  return (
    <div className={`run-row ${run.state} ${open ? 'open' : ''}`}>
      <div className="run-row-header">
        <button className="disclosure run" aria-expanded={open} onClick={onToggle} title={new Date(run.createdAt).toLocaleString()}>
          <Icon name="chev" size={11} className="chev" />
          {live ? <span className="spin" /> : <Icon name={RUN_ICON[run.state]} size={12} className={`run-icon ${run.state}`} />}
          <span className="run-title">{runLabel(run)}</span>
          <span className="run-time">{new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </button>
        {live ? (
          <span className="run-actions">
            <button className="button secondary small" title="Stop the item Claude is working on and cancel the rest" onClick={() => send({ op: 'run.cancel', runId: run.id, abortCurrent: true })}>
              Stop
            </button>
            <button className="button secondary small" title="Let the current item finish, then cancel the rest" onClick={() => send({ op: 'run.cancel', runId: run.id, abortCurrent: false })}>
              Cancel
            </button>
          </span>
        ) : (
          <button className="icon-button" aria-label="Remove from history" title="Remove from history" onClick={() => send({ op: 'run.dismiss', runId: run.id })}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>
      {live && (
        <div className="bar">
          <i style={{ width: `${Math.round((done / Math.max(1, run.items.length)) * 100)}%` }} />
        </div>
      )}
      {open && (
        <div className="run-items">
          {run.detail && <div className="run-detail problem">{run.detail}</div>}
          {run.items.map(item => (
            <RunItemLine key={item.run.seq} item={item} snap={snap} live={live} />
          ))}
          {warnings.map((w, k) => (
            <div key={k} className="run-detail">
              <Icon name="info" size={11} /> {w}
            </div>
          ))}
          {!live && itemIds.length > 0 && (
            <button className="link small" onClick={() => onSelect(itemIds)} title="Select these items in the list, for sending again">
              Select these items
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<ItemRunStatus, string> = {
  queued: 'queued',
  submitting: 'starting',
  running: 'running',
  done: 'done',
  failed: 'failed',
  interrupted: 'stopped',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

function RunItemLine({ item, snap, live }: { item: RunItemView; snap: Snapshot; live: boolean }) {
  const r = item.run;
  const kind = r.status === 'done' ? 'done' : r.status === 'running' || r.status === 'submitting' ? 'running' : ['failed', 'unknown', 'interrupted'].includes(r.status) ? 'failed' : r.status === 'cancelled' ? 'cancelled' : 'queued';
  const waiting = live && r.status === 'submitting' && r.startedAt && Date.now() - r.startedAt > 30_000;
  const note = r.error ?? (r.status === 'done' ? r.answerPreview : r.reason);
  const firstId = item.itemIds.find(id => snap.state.items[id]);
  return (
    <div className="run-item">
      <span className={`status ${kind}`}>
        {kind === 'running' ? <span className="spin" /> : null}
        {STATUS_TEXT[r.status]}
      </span>
      <div className="run-item-text">
        <button
          className="run-item-title"
          disabled={!firstId}
          title={firstId ? 'Open this item' : 'This item was deleted'}
          onClick={() => firstId && send({ op: 'editor.open', target: { kind: 'item', id: firstId } })}
        >
          {item.title || 'Untitled item'}
        </button>
        {r.appliedModel && <span className="run-item-model">{modelLabel(r.appliedModel, snap.catalog)}</span>}
        {note && (
          <div className={`run-item-note ${kind === 'failed' ? 'problem' : ''}`} title={note}>
            {note}
          </div>
        )}
        {waiting && <div className="run-item-note problem">Waiting for the Claude chat to start it. Make sure its tab is open, or press Stop and send it elsewhere.</div>}
      </div>
    </div>
  );
}
