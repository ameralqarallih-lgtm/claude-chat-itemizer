// Adding and editing chat items in the sidebar itself. The editor window is
// still there for everything else: "Open in editor" moves the work over.

import { type ClipboardEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { EFFORT_LEVELS } from '../../bridge-plugin/hooks/protocol';
import type { Snapshot } from '../src/shared/messages';
import { type ChatItem, type Defaults, displayTitle, resolveSettings } from '../src/shared/model';
import { readAsBase64, request, send } from './api';
import { Icon } from './icons';
import { EFFORT_LABELS, formatSize, modelLabel } from './labels';

interface PendingFile {
  key: string;
  name: string;
  mime: string;
  size: number;
  base64: string;
}

/** A pasted screenshot comes as "image.png": give it a name worth reading. */
function nameFor(file: File, taken: number): string {
  const ext = (file.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
  if (!file.name || /^image\.\w+$/i.test(file.name)) return `pasted-image-${taken + 1}.${ext}`;
  return file.name;
}

const isSubmitKey = (e: KeyboardEvent) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

// ---------- quick add ----------

export function QuickAdd({ snap, categoryId, onCategory }: { snap: Snapshot; categoryId: string; onCategory: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const cats = snap.state.categoryOrder.map(id => snap.state.categories[id]!).filter(Boolean);
  const cat = snap.state.categories[categoryId] ? categoryId : cats[0]?.id;

  useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);

  const reset = () => {
    setTitle('');
    setText('');
    setFiles([]);
  };
  const empty = !title.trim() && !text.trim() && files.length === 0;

  const addFiles = async (list: File[]) => {
    const next: PendingFile[] = [];
    for (const f of list) {
      next.push({ key: `${Date.now()}-${Math.random()}`, name: nameFor(f, files.length + next.length), mime: f.type, size: f.size, base64: await readAsBase64(f) });
    }
    setFiles(fs => [...fs, ...next]);
  };

  const onPaste = (e: ClipboardEvent) => {
    const list = Array.from(e.clipboardData.files);
    if (list.length) {
      e.preventDefault();
      void addFiles(list);
    }
  };

  /** Creates the item; `edit` opens it in the editor window afterwards. */
  const create = async (edit: boolean) => {
    if (busy || (empty && !edit)) return;
    setBusy(true);
    try {
      const id = await request<string>({ op: 'item.create', categoryId: cat, fields: { title: title.trim(), text: text.trim() }, open: edit });
      for (const f of files) send({ op: 'attachment.addBytes', itemId: id, name: f.name, mime: f.mime, base64: f.base64 });
      reset();
      if (edit) setOpen(false);
      else area.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button className="quick-add-closed" onClick={() => setOpen(true)}>
        <Icon name="plus" size={14} />
        <span>Add an item here…</span>
      </button>
    );
  }

  return (
    <div
      className="quick-add"
      onKeyDown={e => {
        if (isSubmitKey(e)) {
          e.preventDefault();
          void create(false);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          if (empty) setOpen(false);
          else reset();
        }
      }}
    >
      <input type="text" value={title} placeholder="Title (optional)" aria-label="New item title" onChange={e => setTitle(e.target.value)} onPaste={onPaste} />
      <textarea
        ref={area}
        rows={3}
        value={text}
        placeholder="What should Claude do? Paste screenshots or files here too."
        aria-label="New item prompt"
        onChange={e => setText(e.target.value)}
        onPaste={onPaste}
      />
      {files.length > 0 && (
        <div className="inline-files">
          {files.map(f => (
            <span key={f.key} className="chip file">
              <Icon name="clip" size={11} />
              {f.name}
              <span className="dim">{formatSize(f.size)}</span>
              <button className="chip-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(fs => fs.filter(x => x.key !== f.key))}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <select value={cat} onChange={e => onCategory(e.target.value)} aria-label="Category" title="Category for the new item">
        {cats.map(c => (
          <option key={c.id} value={c.id}>
            {`In ${c.name}`}
          </option>
        ))}
      </select>
      <div className="inline-row inline-actions">
        <button className="button secondary small" title="Close (Esc)" onClick={() => (empty ? setOpen(false) : reset())}>
          {empty ? 'Close' : 'Clear'}
        </button>
        <button className="button secondary small" title="Create it and open the full editor" onClick={() => void create(true)}>
          Open in editor
        </button>
        <button className="button small" disabled={empty || busy} title="Add (Ctrl+Enter)" onClick={() => void create(false)}>
          Add
        </button>
      </div>
      <span className="hint">Ctrl+Enter adds · Esc clears · paste to attach</span>
    </div>
  );
}

// ---------- inline edit ----------

type Choice<T> = T | 'inherit';

export function InlineEdit({ snap, item, onDone }: { snap: Snapshot; item: ChatItem; onDone: () => void }) {
  const eff = resolveSettings(snap.state, item.id);
  const [title, setTitle] = useState(item.title);
  const [text, setText] = useState(item.text);
  const [model, setModel] = useState<Choice<string>>(item.settings.model ?? 'inherit');
  const [effort, setEffort] = useState<Choice<Defaults['effort']>>(item.settings.effort ?? 'inherit');
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = area.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  // What the item would get without its own value: the category's, else the defaults'.
  const cat = Object.values(snap.state.categories).find(c => snap.state.itemOrder[c.id]?.includes(item.id));
  const inheritedModel = cat?.settings.model ?? snap.state.defaults.model;
  const inheritedEffort = cat?.settings.effort ?? snap.state.defaults.effort;

  const save = () => {
    if (title !== item.title || text !== item.text) send({ op: 'item.update', id: item.id, patch: { title, text } });
    const want = (v: Choice<string>) => (v === 'inherit' ? undefined : v);
    if (want(model) !== item.settings.model) send({ op: 'item.setSetting', id: item.id, key: 'model', value: want(model) });
    if (want(effort) !== item.settings.effort) send({ op: 'item.setSetting', id: item.id, key: 'effort', value: want(effort) as Defaults['effort'] | undefined });
    onDone();
  };

  const openEditor = () => {
    save();
    send({ op: 'editor.open', target: { kind: 'item', id: item.id } });
  };

  const onPaste = (e: ClipboardEvent) => {
    const list = Array.from(e.clipboardData.files);
    if (!list.length) return;
    e.preventDefault();
    void (async () => {
      let n = item.attachments.filter(a => a.name.startsWith('pasted-image-')).length;
      for (const f of list) {
        send({ op: 'attachment.addBytes', itemId: item.id, name: nameFor(f, n++), mime: f.type, base64: await readAsBase64(f) });
      }
    })();
  };

  return (
    <div
      className="inline-edit"
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (isSubmitKey(e)) {
          e.preventDefault();
          save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
    >
      <input type="text" value={title} placeholder="Title (optional)" aria-label="Title" onChange={e => setTitle(e.target.value)} onPaste={onPaste} />
      <textarea ref={area} rows={4} value={text} placeholder="Prompt" aria-label="Prompt" onChange={e => setText(e.target.value)} onPaste={onPaste} />
      {item.attachments.length > 0 && (
        <div className="inline-files">
          {item.attachments.map(a => (
            <span key={a.id} className="chip file" title={a.name}>
              <Icon name="clip" size={11} />
              {a.name}
              <button className="chip-x" aria-label={`Remove ${a.name}`} onClick={() => send({ op: 'attachment.remove', itemId: item.id, attachmentId: a.id })}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="inline-row settings">
        <select value={model} onChange={e => setModel(e.target.value)} aria-label="Model" title="Model for this item">
          <option value="inherit">{`Model: ${modelLabel(inheritedModel, snap.catalog)} (inherited)`}</option>
          <option value="session">Model: chat's own</option>
          {snap.catalog
            .filter(m => !m.id.startsWith('claude-'))
            .map(m => (
              <option key={m.id} value={m.id}>
                {`Model: ${m.label}`}
              </option>
            ))}
          {model !== 'inherit' && model !== 'session' && !snap.catalog.some(m => m.id === model && !m.id.startsWith('claude-')) && (
            <option value={model}>{`Model: ${modelLabel(model, snap.catalog)}`}</option>
          )}
        </select>
        <select value={effort} onChange={e => setEffort(e.target.value as Choice<Defaults['effort']>)} aria-label="Effort" title="Effort for this item">
          <option value="inherit">{`Effort: ${EFFORT_LABELS[inheritedEffort]} (inherited)`}</option>
          <option value="session">Effort: chat's own</option>
          {EFFORT_LEVELS.map(l => (
            <option key={l} value={l}>
              {`Effort: ${EFFORT_LABELS[l]}`}
            </option>
          ))}
        </select>
      </div>
      <div className="inline-row inline-actions">
        <button className="button secondary small" onClick={onDone}>
          Cancel
        </button>
        <button className="button secondary small" title="Save and open the full editor" onClick={openEditor}>
          Open in editor
        </button>
        <button className="button small" onClick={save}>
          Save
        </button>
      </div>
      <span className="hint">Ctrl+Enter saves · Esc cancels · paste to attach</span>
      <span className="sr-only">{`Editing ${displayTitle(item)}; current model ${eff.model.value}`}</span>
    </div>
  );
}
