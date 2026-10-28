import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from 'react';

import { EFFORT_LEVELS, type EffortLevel } from '../../bridge-plugin/hooks/protocol';
import type { Snapshot } from '../src/shared/messages';
import {
  type Attachment,
  type ChatItem,
  type Defaults,
  type EffectiveSettings,
  type SettingKey,
  CATEGORY_COLORS,
  categoryOf,
  displayTitle,
  resolveSettings,
} from '../src/shared/model';
import { readAsBase64, send } from './api';
import { Icon } from './icons';
import { DELIVERY_LABELS, EFFORT_LABELS, POLICY_LABELS, effortSupportedBy, formatSize, modelLabel, timeAgo } from './labels';

/** Every draft field registers its flush here, so Save and Ctrl+S write what is typed at once. */
const flushers = new Set<() => void>();
function flushAll(): void {
  for (const f of flushers) f();
}

function useSaveShortcut(): boolean {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let timer: number | undefined;
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        flushAll();
        setSaved(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setSaved(false), 1500);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.clearTimeout(timer);
    };
  }, []);
  return saved;
}

function saveAndClose(): void {
  flushAll();
  send({ op: 'editor.close' });
}

function SavedNote({ show }: { show: boolean }) {
  return show ? (
    <span className="saved-note" role="status">
      <Icon name="check" size={12} /> Saved
    </span>
  ) : null;
}

export function Editor({ snap }: { snap: Snapshot }) {
  const t = snap.editorTarget;
  if (t?.kind === 'item' && snap.state.items[t.id]) return <ItemEditor key={t.id} snap={snap} item={snap.state.items[t.id]!} />;
  if (t?.kind === 'category' && snap.state.categories[t.id]) return <CategoryEditor key={t.id} snap={snap} id={t.id} />;
  if (t?.kind === 'defaults') return <DefaultsEditor snap={snap} />;
  return (
    <div className="editor empty">
      <p>Select a chat item in the Chat Itemizer sidebar to edit it.</p>
    </div>
  );
}

/** A text value edited locally and saved shortly after typing stops, so incoming snapshots do not fight the cursor. */
function useDraft(value: string, save: (v: string) => void, delay = 300) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const change = (v: string) => {
    setDraft(v);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      dirty.current = false;
      save(v);
    }, delay);
  };
  const latest = useRef(draft);
  latest.current = draft;
  const saveRef = useRef(save);
  saveRef.current = save;
  const flush = () => {
    if (!dirty.current) return;
    window.clearTimeout(timer.current);
    dirty.current = false;
    saveRef.current(latest.current);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const f = () => flushRef.current();
    flushers.add(f);
    return () => {
      f(); // leaving the item: keep what was typed
      flushers.delete(f);
    };
  }, []);
  return [draft, change, flush] as const;
}

function ItemEditor({ snap, item }: { snap: Snapshot; item: ChatItem }) {
  const saved = useSaveShortcut();
  const [title, setTitle, flushTitle] = useDraft(item.title, v => send({ op: 'item.update', id: item.id, patch: { title: v } }));
  const [text, setText, flushText] = useDraft(item.text, v => send({ op: 'item.update', id: item.id, patch: { text: v } }));
  const [dragOver, setDragOver] = useState(false);
  const cat = categoryOf(snap.state, item.id);
  const eff = resolveSettings(snap.state, item.id);

  const pastedName = (prefix: string, ext: string) => {
    const n = item.attachments.filter(a => a.name.startsWith(prefix)).length + 1;
    return `${prefix}${n}.${ext}`;
  };

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const isGeneric = !f.name || /^image\.\w+$/i.test(f.name);
      const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      const name = isGeneric && f.type.startsWith('image/') ? pastedName('pasted-image-', ext) : f.name || pastedName('pasted-file-', 'bin');
      send({ op: 'attachment.addBytes', itemId: item.id, name, mime: f.type, base64: await readAsBase64(f) });
    }
  };

  const uriList = (dt: DataTransfer) =>
    (dt.getData('application/vnd.code.uri-list') || dt.getData('text/uri-list'))
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('#'));

  const onZonePaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
      return;
    }
    const uris = uriList(e.clipboardData);
    if (uris.length) {
      e.preventDefault();
      send({ op: 'attachment.addUris', itemId: item.id, uris });
      return;
    }
    const plain = e.clipboardData.getData('text/plain');
    if (plain) {
      e.preventDefault();
      send({ op: 'attachment.addText', itemId: item.id, text: plain });
    }
  };

  /** In the prompt box an image on the clipboard becomes an attachment; text pastes as usual. */
  const onPromptPaste = (e: ClipboardEvent) => {
    const images = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'));
    if (images.length) {
      e.preventDefault();
      void addFiles(images);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const uris = uriList(e.dataTransfer);
    if (uris.length) send({ op: 'attachment.addUris', itemId: item.id, uris });
    else void addFiles(Array.from(e.dataTransfer.files));
  };

  return (
    <div className="editor">
      <div className="editor-meta">
        {cat && (
          <span>
            <span className="dot" style={{ background: cat.color }} /> {cat.name}
          </span>
        )}
        <span>Edited {timeAgo(item.updatedAt)}</span>
        {item.submittedAt && <span className="sent">Sent {timeAgo(item.submittedAt)}</span>}
      </div>

      <div className="field">
        <label className="label" htmlFor="f-title">
          Title
        </label>
        <input id="f-title" type="text" value={title} placeholder="A short name for this item" onChange={e => setTitle(e.target.value)} onBlur={flushTitle} />
      </div>

      <div className="field">
        <label className="label" htmlFor="f-text">
          Prompt
        </label>
        <textarea
          id="f-text"
          value={text}
          rows={8}
          placeholder="What should Claude do?"
          onChange={e => setText(e.target.value)}
          onBlur={flushText}
          onPaste={onPromptPaste}
          autoFocus={!item.text}
        />
      </div>

      <div className="field">
        <span className="label">Attachments</span>
        <div
          className={`attach-zone ${dragOver ? 'over' : ''}`}
          tabIndex={0}
          aria-label="Attachments. Press Ctrl+V to paste an image, copied files or text."
          onPaste={onZonePaste}
          onDragOver={e => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          {item.attachments.map(a => (
            <AttachmentChip key={a.id} a={a} thumb={snap.thumbnails[a.id]} itemId={item.id} />
          ))}
          <button className="button secondary" onClick={() => send({ op: 'attachment.pick', itemId: item.id })}>
            <Icon name="clip" size={13} /> Add files…
          </button>
          <span className="hint">
            Or click here and press Ctrl+V to paste an image, copied files or text. Drag files in from Explorer with Shift held.
          </span>
        </div>
        {!snap.hasWorkspace && <p className="hint">Open a folder or workspace to add attachments.</p>}
      </div>

      <div className="field">
        <span className="label">Chat settings for this item</span>
        <SettingsTable snap={snap} eff={eff} scope="item" onSet={(key, value) => send({ op: 'item.setSetting', id: item.id, key, value })} categoryName={cat?.name} />
      </div>

      <div className="editor-actions">
        <button className="button secondary" onClick={() => send({ op: 'run.quick', itemIds: [item.id] })} title="Send to the active Claude chat with that chat's own settings">
          <Icon name="bolt" size={13} /> Quick send
        </button>
        <button className="button" onClick={() => send({ op: 'ui.openSubmit', itemIds: [item.id] })}>
          Submit…
        </button>
        <button className="button secondary" onClick={() => send({ op: 'item.duplicate', ids: [item.id] })}>
          <Icon name="copy" size={13} /> Duplicate
        </button>
        <span className="spacer" />
        <SavedNote show={saved} />
        <button className="button secondary" onClick={saveAndClose} title="Save your changes and close the editor (Ctrl+S saves without closing)">
          <Icon name="check" size={13} /> Save and close
        </button>
      </div>
    </div>
  );
}

function AttachmentChip({ a, thumb, itemId }: { a: Attachment; thumb?: string; itemId: string }) {
  const ext = a.name.includes('.') ? a.name.split('.').pop()!.slice(0, 4).toUpperCase() : a.kind.toUpperCase();
  return (
    <div className="attachment" title={a.source.mode === 'copy' ? 'Stored copy' : `Live file: ${a.source.path}`}>
      <button className="thumb" onClick={() => send({ op: 'attachment.open', itemId, attachmentId: a.id })} aria-label={`Open ${a.name}`}>
        {thumb ? <img src={thumb} alt="" /> : <span>{ext}</span>}
      </button>
      <div className="attachment-text">
        <div className="attachment-name">{a.name}</div>
        <div className="attachment-meta">
          {formatSize(a.size)} · {a.source.mode === 'copy' ? 'stored copy' : 'live file'}
        </div>
      </div>
      <button className="icon-button" aria-label={`Remove ${a.name}`} title="Remove" onClick={() => send({ op: 'attachment.remove', itemId, attachmentId: a.id })}>
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}

function CategoryEditor({ snap, id }: { snap: Snapshot; id: string }) {
  const saved = useSaveShortcut();
  const cat = snap.state.categories[id]!;
  const [name, setName, flushName] = useDraft(cat.name, v => send({ op: 'category.update', id, patch: { name: v } }));
  // A category's own layer: what it sets, over the defaults.
  const eff = Object.fromEntries(
    (Object.keys(snap.state.defaults) as SettingKey[]).map(k => [
      k,
      cat.settings[k] !== undefined ? { value: cat.settings[k], source: 'category' } : { value: snap.state.defaults[k], source: 'defaults' },
    ]),
  ) as EffectiveSettings;
  const count = snap.state.itemOrder[id]?.length ?? 0;
  return (
    <div className="editor">
      <div className="editor-meta">
        <span>
          Category · {count} item{count === 1 ? '' : 's'}
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor="c-name">
          Name
        </label>
        <input id="c-name" type="text" value={name} onChange={e => setName(e.target.value)} onBlur={flushName} />
      </div>
      <div className="field">
        <span className="label">Color</span>
        <div className="swatches">
          {CATEGORY_COLORS.map(c => (
            <button
              key={c}
              className={`swatch ${c === cat.color ? 'on' : ''}`}
              style={{ background: c }}
              aria-label={`Color ${c}`}
              aria-pressed={c === cat.color}
              onClick={() => send({ op: 'category.update', id, patch: { color: c } })}
            />
          ))}
        </div>
      </div>
      <div className="field">
        <span className="label">Settings for items in this category</span>
        <p className="hint">Items use these unless they set their own.</p>
        <SettingsTable snap={snap} eff={eff} scope="category" onSet={(key, value) => send({ op: 'category.setSetting', id, key, value })} />
      </div>
      <div className="editor-actions">
        <button className="button secondary" onClick={() => send({ op: 'item.create', categoryId: id })}>
          <Icon name="plus" size={13} /> New item in {cat.name}
        </button>
        <span className="spacer" />
        <SavedNote show={saved} />
        <button className="button" onClick={saveAndClose}>
          <Icon name="check" size={13} /> Save and close
        </button>
      </div>
    </div>
  );
}

function DefaultsEditor({ snap }: { snap: Snapshot }) {
  const d = snap.state.defaults;
  const eff = Object.fromEntries((Object.keys(d) as SettingKey[]).map(k => [k, { value: d[k], source: 'defaults' }])) as EffectiveSettings;
  return (
    <div className="editor">
      <div className="editor-meta">
        <span>Defaults</span>
      </div>
      <p className="hint">New and existing items use these values unless their category or the item sets its own.</p>
      <SettingsTable snap={snap} eff={eff} scope="defaults" onSet={(key, value) => value !== undefined && send({ op: 'defaults.set', key, value })} />
      <div className="editor-actions">
        <button className="button secondary" onClick={() => send({ op: 'io.export' })}>
          Export items…
        </button>
        <button className="button secondary" onClick={() => send({ op: 'io.import' })}>
          Import items…
        </button>
        <span className="spacer" />
        <button className="button" onClick={saveAndClose} title="Defaults save as you change them">
          Close
        </button>
      </div>
    </div>
  );
}

// ---------- settings ----------

type Scope = 'item' | 'category' | 'defaults';

function SettingsTable({
  snap,
  eff,
  scope,
  onSet,
  categoryName,
}: {
  snap: Snapshot;
  eff: EffectiveSettings;
  scope: Scope;
  onSet: (key: SettingKey, value: Defaults[SettingKey] | undefined) => void;
  categoryName?: string;
}) {
  const own = (key: SettingKey) => (scope === 'item' ? eff[key].source === 'item' : scope === 'category' ? eff[key].source === 'category' : false);
  const source = (key: SettingKey) => {
    if (scope === 'defaults') return null;
    if (own(key))
      return (
        <>
          <span className="overridden">{scope === 'item' ? 'Overridden' : 'Set by category'}</span>
          <button className="link" onClick={() => onSet(key, undefined)}>
            Reset
          </button>
        </>
      );
    return eff[key].source === 'category' ? `From category “${categoryName ?? ''}”` : 'From defaults';
  };
  const model = eff.model.value;
  const effort = eff.effort.value;
  const effortProblem = effort !== 'session' && !effortSupportedBy(model, effort as EffortLevel, snap.catalog);

  return (
    <table className="settings">
      <tbody>
        <tr>
          <th scope="row">Model</th>
          <td>
            <select value={model} onChange={e => onSet('model', e.target.value)} aria-label="Model">
              <option value="session">Chat's model (no change)</option>
              {snap.catalog.map(m => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.id.startsWith('claude-') ? ` (${m.id})` : ''}
                </option>
              ))}
              {model !== 'session' && !snap.catalog.some(m => m.id === model) && <option value={model}>{model}</option>}
            </select>
          </td>
          <td className="source">{source('model')}</td>
        </tr>
        <tr>
          <th scope="row">Effort</th>
          <td>
            <select value={effort} onChange={e => onSet('effort', e.target.value as Defaults['effort'])} aria-label="Effort">
              <option value="session">Chat's effort (no change)</option>
              {EFFORT_LEVELS.map(l => (
                <option key={l} value={l}>
                  {EFFORT_LABELS[l]}
                  {!effortSupportedBy(model, l, snap.catalog) ? ` (not for ${modelLabel(model, snap.catalog)})` : ''}
                </option>
              ))}
            </select>
            {effortProblem && <div className="field-warning">{modelLabel(model, snap.catalog)} does not take this level; the turn runs without it.</div>}
          </td>
          <td className="source">{source('effort')}</td>
        </tr>
        <tr>
          <th scope="row">Tool policy</th>
          <td>
            <select value={eff.toolPolicy.value} onChange={e => onSet('toolPolicy', e.target.value as Defaults['toolPolicy'])} aria-label="Tool policy">
              <option value="inherit">{POLICY_LABELS.inherit}</option>
              <option value="readOnly">{POLICY_LABELS.readOnly}: no file edits</option>
              <option value="autoAcceptEdits" disabled={!snap.allowLoosening}>
                {POLICY_LABELS.autoAcceptEdits}
                {!snap.allowLoosening ? ' (off in settings)' : ''}
              </option>
            </select>
          </td>
          <td className="source">{source('toolPolicy')}</td>
        </tr>
        <tr>
          <th scope="row">Attachments</th>
          <td>
            <select value={eff.attachmentDelivery.value} onChange={e => onSet('attachmentDelivery', e.target.value as Defaults['attachmentDelivery'])} aria-label="Attachment delivery">
              <option value="auto">{DELIVERY_LABELS.auto}</option>
              <option value="pathsOnly">{DELIVERY_LABELS.pathsOnly}</option>
            </select>
          </td>
          <td className="source">{source('attachmentDelivery')}</td>
        </tr>
        <tr>
          <th scope="row">Instructions</th>
          <td colSpan={scope === 'defaults' ? 2 : 1}>
            <PreambleField value={eff.preamble.value} onSave={v => onSet('preamble', v)} />
          </td>
          {scope !== 'defaults' && <td className="source">{source('preamble')}</td>}
        </tr>
        <tr className="readonly">
          <th scope="row">Permission mode</th>
          <td>Set in the Claude tab</td>
          <td className="source">Not settable per item</td>
        </tr>
        <tr className="readonly">
          <th scope="row">Thinking</th>
          <td>The chat's setting</td>
          <td className="source">Not settable per item; effort sets how hard Claude thinks</td>
        </tr>
      </tbody>
    </table>
  );
}

function PreambleField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft, flush] = useDraft(value, onSave, 500);
  return (
    <textarea
      className="preamble"
      rows={2}
      value={draft}
      placeholder="Hidden instructions sent with the prompt (optional)"
      onChange={e => setDraft(e.target.value)}
      onBlur={flush}
      aria-label="Hidden instructions"
    />
  );
}

