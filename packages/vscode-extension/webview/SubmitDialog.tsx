import { useEffect, useRef, useState } from 'react';

import type { EffortLevel, SubmitMode } from '../../bridge-plugin/hooks/protocol';
import type { RunOptions, RunTarget, Snapshot } from '../src/shared/messages';
import { displayTitle, resolveSettings } from '../src/shared/model';
import { loadUiState, request, saveUiState } from './api';
import { Icon } from './icons';
import { EFFORT_LABELS, effortSupportedBy, modelLabel, sessionLabel } from './labels';

interface Remembered {
  mode: SubmitMode;
  options: RunOptions;
}

const DEFAULT_OPTIONS: RunOptions = { stopOnError: true, titleAsHeading: true, hideAfter: true, combinedFrom: 'first', concurrency: 1 };

function remembered(): Remembered {
  const s = loadUiState<{ submit?: Remembered }>({});
  return { mode: s.submit?.mode ?? 'sequential', options: { ...DEFAULT_OPTIONS, ...(s.submit?.options ?? {}) } };
}

export function SubmitDialog({ snap, itemIds, onClose, onSubmitted }: { snap: Snapshot; itemIds: string[]; onClose: () => void; onSubmitted: () => void }) {
  const [mode, setMode] = useState<SubmitMode>(() => remembered().mode);
  const [options, setOptions] = useState<RunOptions>(() => remembered().options);
  const connected = snap.sessions.filter(s => s.isCompatible && s.hasTab);
  const [target, setTarget] = useState<string>(
    () => snap.resolvedTargetId ?? connected[0]?.sessionId ?? (snap.bridge.kind === 'notSetUp' ? 'prefill' : 'newTab'),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('input, button, select')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const n = itemIds.length;
  const state = snap.state;
  const set = (patch: Partial<RunOptions>) => setOptions(o => ({ ...o, ...patch }));
  const prefill = target === 'prefill';

  const warnings: { kind: 'warn' | 'info'; text: string }[] = [];
  const effs = itemIds.map(id => ({ id, eff: resolveSettings(state, id) }));
  if (prefill) warnings.push({ kind: 'warn', text: 'Prefill types the text into a new Claude tab for you to send. Item settings and attachments are not applied.' });
  if (mode === 'combined') {
    const models = new Set(effs.map(e => e.eff.model.value));
    const efforts = new Set(effs.map(e => e.eff.effort.value));
    const from = options.combinedFrom === 'first' ? effs[0]?.eff : undefined;
    const label = from ? `${modelLabel(from.model.value, snap.catalog)} · ${EFFORT_LABELS[from.effort.value]}` : `${modelLabel(state.defaults.model, snap.catalog)} · ${EFFORT_LABELS[state.defaults.effort]}`;
    if (models.size > 1 || efforts.size > 1) warnings.push({ kind: 'warn', text: `The items have different settings. The one message uses ${label}.` });
    if (effs.some(e => e.eff.toolPolicy.value === 'readOnly')) warnings.push({ kind: 'info', text: 'One item is read-only, so the whole message runs read-only.' });
  } else if (!prefill) {
    for (const { id, eff } of effs) {
      const title = displayTitle(state.items[id]!);
      const model = eff.model.value;
      const effort = eff.effort.value;
      if (effort !== 'session' && !effortSupportedBy(model, effort as EffortLevel, snap.catalog))
        warnings.push({ kind: 'warn', text: `“${title}”: ${modelLabel(model, snap.catalog)} does not take ${EFFORT_LABELS[effort]} effort. It runs without it.` });
      if (eff.toolPolicy.value === 'readOnly') warnings.push({ kind: 'info', text: `“${title}” is read-only: file edits are refused while it runs.` });
      if (eff.toolPolicy.value === 'autoAcceptEdits' && !snap.allowLoosening)
        warnings.push({ kind: 'warn', text: `“${title}”: Auto-accept edits is off in settings (claudeItemizer.allowLooseningPolicies), so the Claude tab decides.` });
    }
    if (mode === 'sequential' && new Set(effs.map(e => e.eff.model.value)).size > 1)
      warnings.push({ kind: 'warn', text: 'The items use different models. Switching models mid-conversation re-reads the context without the prompt cache, which costs more.' });
  }
  if (!prefill) {
    const media = itemIds.flatMap(id => state.items[id]!.attachments.filter(a => a.kind === 'image' || a.kind === 'pdf'));
    if (media.length) warnings.push({ kind: 'info', text: `${media.length} image or PDF attachment${media.length === 1 ? ' is' : 's are'} sent as file paths. Claude opens them with its Read tool, without asking you.` });
  }

  const needsSession = mode !== 'newConversationPerItem' && !prefill;
  const reachable = (id: string) => connected.some(s => s.sessionId === id) || snap.recentChats.some(c => c.sessionId === id);
  const canSubmit = !busy && n > 0 && (prefill || (snap.bridge.kind !== 'notSetUp' || connected.length > 0)) && !(needsSession && target !== 'newTab' && !reachable(target));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const runTarget: RunTarget = prefill ? { kind: 'prefill' } : mode === 'newConversationPerItem' || target === 'newTab' ? { kind: 'newTab' } : { kind: 'session', sessionId: target };
    saveUiState({ ...loadUiState<Record<string, unknown>>({}), submit: { mode, options } });
    try {
      await request({ op: 'run.start', itemIds, mode, target: runTarget, options });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const targetPicker = (
    <select value={target} onChange={e => setTarget(e.target.value)} aria-label="Send to">
      {connected.map(s => (
        <option key={s.sessionId} value={s.sessionId}>
          {sessionLabel(s, snap.catalog)}
        </option>
      ))}
      {snap.recentChats.length > 0 && (
        <optgroup label="Earlier chats (reopen)">
          {snap.recentChats.map(c => (
            <option key={c.sessionId} value={c.sessionId}>
              {`${c.title ?? c.firstPrompt ?? 'Untitled chat'} · not open`}
            </option>
          ))}
        </optgroup>
      )}
      {snap.bridge.kind !== 'notSetUp' && <option value="newTab">A new Claude tab</option>}
      <option value="prefill">Prefill a new Claude tab (text only)</option>
    </select>
  );

  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="submit-title" ref={dialog}>
        <h2 id="submit-title">
          Submit {n} item{n === 1 ? '' : 's'} to Claude
        </h2>
        <div className="dialog-body">
          <label className={`option ${mode === 'sequential' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'sequential'} onChange={() => setMode('sequential')} />
            <div>
              <div className="option-title">One conversation, in order</div>
              <div className="option-desc">Each item is sent after Claude finishes replying to the previous one.</div>
            </div>
          </label>
          <label className={`option ${mode === 'newConversationPerItem' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'newConversationPerItem'} onChange={() => setMode('newConversationPerItem')} disabled={n < 1} />
            <div>
              <div className="option-title">New conversation per item</div>
              <div className="option-desc">
                Opens a Claude tab for each item. Up to{' '}
                <select value={options.concurrency} onChange={e => set({ concurrency: Number(e.target.value) })} aria-label="Conversations at once" className="inline">
                  {[1, 2, 3, 4].map(k => (
                    <option key={k}>{k}</option>
                  ))}
                </select>{' '}
                run at once.
              </div>
            </div>
          </label>
          <label className={`option ${mode === 'combined' ? 'on' : ''}`}>
            <input type="radio" name="mode" checked={mode === 'combined'} onChange={() => setMode('combined')} />
            <div>
              <div className="option-title">All in one message</div>
              <div className="option-desc">Joins the items into one prompt, each under its own heading, with all attachments.</div>
              {mode === 'combined' && (
                <select value={options.combinedFrom} onChange={e => set({ combinedFrom: e.target.value as RunOptions['combinedFrom'] })} aria-label="Settings for the message" className="sub">
                  <option value="first">Use the first item's settings</option>
                  <option value="defaults">Use the defaults</option>
                </select>
              )}
            </div>
          </label>

          {mode !== 'newConversationPerItem' ? (
            <div className="field">
              <span className="label">Send to</span>
              {targetPicker}
            </div>
          ) : (
            <label className="check">
              <input type="checkbox" role="switch" checked={prefill} onChange={e => setTarget(e.target.checked ? 'prefill' : 'newTab')} />
              Prefill only (text, no settings or attachments)
            </label>
          )}

          <div className="checks">
            <label className="check">
              <input type="checkbox" role="switch" checked={options.stopOnError} onChange={e => set({ stopOnError: e.target.checked })} />
              Stop on first failure
            </label>
            <label className="check">
              <input type="checkbox" role="switch" checked={options.titleAsHeading} onChange={e => set({ titleAsHeading: e.target.checked })} />
              Send the title as a heading
            </label>
            <label className="check">
              <input type="checkbox" role="switch" checked={options.hideAfter} onChange={e => set({ hideAfter: e.target.checked })} />
              Hide items after they're sent
            </label>
          </div>

          {warnings.length > 0 && (
            <ul className="warnings">
              {warnings.map((w, i) => (
                <li key={i} className={w.kind}>
                  <Icon name={w.kind === 'warn' ? 'warn' : 'info'} size={13} />
                  <span>{w.text}</span>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="dialog-footer">
          <button className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? 'Submitting…' : `Submit ${n} item${n === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
