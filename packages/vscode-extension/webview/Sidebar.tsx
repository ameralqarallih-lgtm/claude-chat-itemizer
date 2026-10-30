import {
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type { Snapshot } from '../src/shared/messages';
import { type ChatItem, displayTitle, resolveSettings } from '../src/shared/model';
import { RequestError, loadUiState, onOpenSubmit, request, saveUiState, send } from './api';
import { Icon } from './icons';
import { EFFORT_LABELS, POLICY_LABELS, itemBadge, modelChip } from './labels';
import { InlineEdit, QuickAdd } from './InlineItem';
import { DEFAULT_HISTORY_UI, type HistoryUi, RunHistory } from './RunHistory';
import { SendTo } from './SendTo';
import { SubmitDialog } from './SubmitDialog';

const CAT = 'cat:'; // droppable: a category section (items land at its end)
const CATSORT = 'catsort:'; // sortable: a category header (reorders categories)

interface UiState {
  selected: string[];
  history: HistoryUi;
  /** The category the quick-add box puts new items in. */
  addTo?: string;
}

export function Sidebar({ snap }: { snap: Snapshot }) {
  const { state } = snap;
  const [ui, setUi] = useState<UiState>(() => loadUiState<UiState>({ selected: [], history: DEFAULT_HISTORY_UI }));
  const [dialog, setDialog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inlineId, setInlineId] = useState<string | null>(null);

  const selected = useMemo(() => new Set(ui.selected.filter(id => state.items[id])), [ui.selected, state.items]);

  useEffect(() => {
    saveUiState(ui);
    send({ op: 'selection.set', ids: [...selected] });
  }, [ui, selected]);

  useEffect(
    () =>
      onOpenSubmit(ids => {
        setUi(u => ({ ...u, selected: ids }));
        setDialog(ids);
      }),
    [],
  );

  const setSelected = (ids: Iterable<string>) => setUi(u => ({ ...u, selected: [...new Set(ids)] }));
  const toggle = (id: string, on: boolean) => setSelected(on ? [...selected, id] : [...selected].filter(x => x !== id));

  const liveItems = useMemo(() => {
    const out = new Set<string>();
    for (const r of snap.runs) if (r.state === 'running' || r.state === 'starting') for (const i of r.items) i.itemIds.forEach(id => out.add(id));
    return out;
  }, [snap.runs]);

  const isHidden = (item: ChatItem) => state.view.hideSubmitted && !!item.submittedAt && !liveItems.has(item.id);

  /** Selected items in display order. */
  const orderedSelection = state.categoryOrder.flatMap(cid => (state.itemOrder[cid] ?? []).filter(id => selected.has(id)));
  const visibleIds = state.categoryOrder.flatMap(cid => (state.itemOrder[cid] ?? []).filter(id => !isHidden(state.items[id]!)));
  const allSelected = visibleIds.length > 0 && visibleIds.every(id => selected.has(id));
  const busy = snap.runs.some(r => r.state === 'running' || r.state === 'starting');

  const quick = async (ids: string[]) => {
    setError(null);
    try {
      await request({ op: 'run.quick', itemIds: ids });
    } catch (err) {
      if (err instanceof RequestError && err.code === 'noSession') setDialog(ids);
      else if (err instanceof RequestError && err.code === 'targetGone') setError(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (ids: string[]) => {
    const what = ids.length === 1 ? `“${displayTitle(state.items[ids[0]!]!)}”` : `${ids.length} chat items`;
    if (await request<boolean>({ op: 'confirm', message: `Delete ${what}?`, confirm: 'Delete' })) send({ op: 'item.delete', ids });
  };

  return (
    <div className="sidebar">
      <SendTo snap={snap} />
      <div className="toolbar">
        <label className="select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={e => setSelected(e.target.checked ? visibleIds : [])}
            aria-label="Select all items"
          />
          {selected.size} of {visibleIds.length} selected
        </label>
        <button
          className={`icon-button ${state.view.hideSubmitted ? 'on' : ''}`}
          title={state.view.hideSubmitted ? 'Show sent items' : 'Hide sent items'}
          aria-pressed={state.view.hideSubmitted}
          onClick={() => send({ op: 'view.set', hideSubmitted: !state.view.hideSubmitted })}
        >
          <Icon name={state.view.hideSubmitted ? 'eyeOff' : 'eye'} />
        </button>
      </div>
      <div className="actions">
        <button
          className="button secondary"
          disabled={selected.size === 0 || busy}
          title="Send the selected items to the active Claude chat, in order, with that chat's own model and effort. No dialog."
          onClick={() => void quick(orderedSelection)}
        >
          <Icon name="bolt" size={13} />
          Quick
        </button>
        <button className="button" disabled={selected.size === 0 || busy} onClick={() => setDialog(orderedSelection)}>
          Submit…
        </button>
      </div>
      {error && (
        <div className="banner error" role="alert">
          <Icon name="warn" size={14} />
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      )}
      <BridgeBanner snap={snap} />
      <RunHistory snap={snap} ui={ui.history ?? DEFAULT_HISTORY_UI} onUi={history => setUi(u => ({ ...u, history }))} onSelect={ids => setSelected(ids)} />
      <div className="quick-add-wrap">
        <QuickAdd snap={snap} categoryId={ui.addTo ?? state.categoryOrder[0] ?? ''} onCategory={addTo => setUi(u => ({ ...u, addTo }))} />
      </div>
      <CategoryList
        snap={snap}
        selected={selected}
        isHidden={isHidden}
        onToggle={toggle}
        onSelectMany={(ids, on) => setSelected(on ? [...selected, ...ids] : [...selected].filter(x => !ids.includes(x)))}
        onQuick={id => void quick([id])}
        onDelete={id => void remove([id])}
        busy={busy}
        inlineId={inlineId}
        onInline={setInlineId}
      />
      <Footer snap={snap} />
      {dialog && (
        <SubmitDialog
          snap={snap}
          itemIds={dialog.filter(id => state.items[id])}
          onClose={() => setDialog(null)}
          onSubmitted={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// ---------- categories and items ----------

interface ListProps {
  snap: Snapshot;
  selected: Set<string>;
  isHidden: (item: ChatItem) => boolean;
  onToggle: (id: string, on: boolean) => void;
  onSelectMany: (ids: string[], on: boolean) => void;
  onQuick: (id: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  inlineId: string | null;
  onInline: (id: string | null) => void;
}

function CategoryList(props: ListProps) {
  const { snap, isHidden } = props;
  const { state } = snap;
  const visibleOrder = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const cid of state.categoryOrder) out[cid] = (state.itemOrder[cid] ?? []).filter(id => !isHidden(state.items[id]!));
    return out;
  }, [state, isHidden]);
  const [draft, setDraft] = useState<Record<string, string[]> | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const containers = draft ?? visibleOrder;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const containerOf = (id: string, within = containers): string | undefined => {
    if (id.startsWith(CAT)) return id.slice(CAT.length);
    if (id.startsWith(CATSORT)) return id.slice(CATSORT.length);
    return Object.keys(within).find(cid => within[cid]!.includes(id));
  };

  const collision: CollisionDetection = args => {
    const draggingCategory = String(args.active.id).startsWith(CATSORT);
    const candidates = args.droppableContainers.filter(c => String(c.id).startsWith(CATSORT) === draggingCategory);
    const scoped = { ...args, droppableContainers: candidates };
    const under = pointerWithin(scoped);
    if (under.length) {
      const items = under.filter(c => !String(c.id).startsWith(CAT));
      return items.length ? items : under;
    }
    return closestCenter(scoped);
  };

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    if (!id.startsWith(CATSORT)) setDraft(structuredClone(visibleOrder));
  };

  const onDragOver = (e: DragOverEvent) => {
    const id = String(e.active.id);
    if (!e.over || id.startsWith(CATSORT) || !draft) return;
    const from = containerOf(id, draft);
    const to = containerOf(String(e.over.id), draft);
    if (!from || !to || from === to) return;
    setDraft(d => {
      if (!d) return d;
      const next = { ...d, [from]: d[from]!.filter(x => x !== id) };
      const target = [...d[to]!];
      const overIndex = target.indexOf(String(e.over!.id));
      target.splice(overIndex >= 0 ? overIndex : target.length, 0, id);
      next[to] = target;
      return next;
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActiveId(null);
    if (id.startsWith(CATSORT)) {
      if (overId?.startsWith(CATSORT) && overId !== id) {
        const order = state.categoryOrder;
        const next = arrayMove(order, order.indexOf(id.slice(CATSORT.length)), order.indexOf(overId.slice(CATSORT.length)));
        const at = next.indexOf(id.slice(CATSORT.length));
        send({ op: 'category.move', id: id.slice(CATSORT.length), beforeId: next[at + 1] ?? null });
      }
      return;
    }
    const d = draft;
    setDraft(null);
    if (!d || !overId) return;
    const to = containerOf(id, d);
    if (!to) return;
    let list = d[to]!;
    if (!overId.startsWith(CAT) && list.includes(overId) && overId !== id) list = arrayMove(list, list.indexOf(id), list.indexOf(overId));
    const at = list.indexOf(id);
    const beforeId = list[at + 1] ?? null;
    const unchanged = to === containerOf(id, visibleOrder) && (visibleOrder[to]![visibleOrder[to]!.indexOf(id) + 1] ?? null) === beforeId;
    if (!unchanged) send({ op: 'item.move', id, toCategoryId: to, beforeId });
  };

  const activeItem = activeId && !activeId.startsWith(CATSORT) ? state.items[activeId] : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={() => {
        setDraft(null);
        setActiveId(null);
      }}
    >
      <div className="categories" role="list" aria-label="Chat items">
        <SortableContext items={state.categoryOrder.map(c => CATSORT + c)} strategy={verticalListSortingStrategy}>
          {state.categoryOrder.map(cid => (
            <CategorySection key={cid} categoryId={cid} itemIds={containers[cid] ?? []} hiddenCount={(state.itemOrder[cid]?.length ?? 0) - (visibleOrder[cid]?.length ?? 0)} {...props} />
          ))}
        </SortableContext>
        {Object.keys(state.items).length === 0 && (
          <div className="empty">
            <p>No chat items yet.</p>
            <p>Write prompts here ahead of time, give each its own attachments, model and effort, then send them to Claude.</p>
            <button className="button" onClick={() => send({ op: 'item.create' })}>
              <Icon name="plus" size={13} /> New chat item
            </button>
          </div>
        )}
      </div>
      <DragOverlay>{activeItem ? <ItemCardBody item={activeItem} snap={props.snap} overlay /> : null}</DragOverlay>
    </DndContext>
  );
}

function CategorySection(props: ListProps & { categoryId: string; itemIds: string[]; hiddenCount: number }) {
  const { snap, categoryId, itemIds, selected, hiddenCount } = props;
  const cat = snap.state.categories[categoryId]!;
  const sortable = useSortable({ id: CATSORT + categoryId });
  const drop = useDroppable({ id: CAT + categoryId });
  const all = snap.state.itemOrder[categoryId] ?? [];
  const allSelected = itemIds.length > 0 && itemIds.every(id => selected.has(id));
  const overrides = Object.entries(cat.settings)
    .map(([k, v]) =>
      k === 'model' ? modelChip(String(v), snap.catalog) : k === 'effort' ? EFFORT_LABELS[v as keyof typeof EFFORT_LABELS] : k === 'toolPolicy' ? POLICY_LABELS[v as keyof typeof POLICY_LABELS] : null,
    )
    .filter(Boolean)
    .join(', ');

  const del = async () => {
    const others = snap.state.categoryOrder.filter(c => c !== categoryId);
    if (others.length === 0) return;
    const moveTo = snap.state.categories[others[0]!]!;
    const ok = await request<boolean>({
      op: 'confirm',
      message: all.length ? `Delete “${cat.name}”? Its ${all.length} item(s) move to “${moveTo.name}”.` : `Delete “${cat.name}”?`,
      confirm: 'Delete',
    });
    if (ok) send({ op: 'category.delete', id: categoryId, moveTo: moveTo.id });
  };

  return (
    <section
      ref={el => {
        sortable.setNodeRef(el);
        drop.setNodeRef(el);
      }}
      className={`category ${cat.collapsed ? 'collapsed' : ''} ${drop.isOver ? 'drop-target' : ''}`}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
    >
      <div className="category-header">
        <button className="icon-button grip" title="Drag to reorder categories" aria-label={`Reorder ${cat.name}`} {...sortable.attributes} {...sortable.listeners}>
          <Icon name="grip" size={12} />
        </button>
        <button
          className="icon-button chevron"
          aria-expanded={!cat.collapsed}
          aria-label={cat.collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
          onClick={() => send({ op: 'category.update', id: categoryId, patch: { collapsed: !cat.collapsed } })}
        >
          <Icon name="chev" size={12} />
        </button>
        <input
          type="checkbox"
          checked={allSelected}
          disabled={itemIds.length === 0}
          onChange={e => props.onSelectMany(itemIds, e.target.checked)}
          aria-label={`Select all in ${cat.name}`}
        />
        <span className="dot" style={{ background: cat.color }} />
        <button className="category-name" onClick={() => send({ op: 'editor.open', target: { kind: 'category', id: categoryId } })} title="Edit category">
          {cat.name}
        </button>
        <span className="count">{all.length}</span>
        {overrides && <span className="category-overrides" title="Category settings">{overrides}</span>}
        <span className="hover-actions">
          <button className="icon-button" title="New item in this category" onClick={() => send({ op: 'item.create', categoryId })}>
            <Icon name="plus" size={14} />
          </button>
          <button className="icon-button" title="Category settings" onClick={() => send({ op: 'editor.open', target: { kind: 'category', id: categoryId } })}>
            <Icon name="gear" size={14} />
          </button>
          {snap.state.categoryOrder.length > 1 && (
            <button className="icon-button" title="Delete category" onClick={() => void del()}>
              <Icon name="trash" size={14} />
            </button>
          )}
        </span>
      </div>
      {!cat.collapsed && (
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <div className="category-body">
            {itemIds.map(id => (snap.state.items[id] ? <ItemCard key={id} item={snap.state.items[id]!} {...props} /> : null))}
            {itemIds.length === 0 && hiddenCount === 0 && <div className="drop-hint">Drop items here</div>}
            {hiddenCount > 0 && (
              <div className="hidden-note">
                {hiddenCount} sent item{hiddenCount === 1 ? '' : 's'} hidden ·{' '}
                <button className="link" onClick={() => send({ op: 'view.set', hideSubmitted: false })}>
                  Show
                </button>
              </div>
            )}
          </div>
        </SortableContext>
      )}
    </section>
  );
}

function ItemCard(props: ListProps & { item: ChatItem }) {
  const { item, snap, selected, onToggle } = props;
  const sortable = useSortable({ id: item.id, disabled: props.inlineId === item.id });
  const clickTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(clickTimer.current), []);
  const editing = snap.editorTarget?.kind === 'item' && snap.editorTarget.id === item.id;
  if (props.inlineId === item.id) {
    return (
      <div ref={sortable.setNodeRef} role="listitem" className="item inline">
        <InlineEdit snap={snap} item={item} onDone={() => props.onInline(null)} />
      </div>
    );
  }
  return (
    <div
      ref={sortable.setNodeRef}
      role="listitem"
      className={`item ${editing ? 'editing' : ''} ${sortable.isDragging ? 'dragging' : ''}`}
      style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
      onClick={e => {
        // Wait out a possible second click: a double-click edits here instead.
        if (e.detail > 1) return;
        window.clearTimeout(clickTimer.current);
        clickTimer.current = window.setTimeout(() => send({ op: 'editor.open', target: { kind: 'item', id: item.id } }), 230);
      }}
      onDoubleClick={e => {
        e.preventDefault();
        window.clearTimeout(clickTimer.current);
        props.onInline(item.id);
      }}
      title="Click to open in the editor · double-click to edit here"
    >
      <button className="icon-button grip" title="Drag to reorder" aria-label={`Reorder ${displayTitle(item)}`} {...sortable.attributes} {...sortable.listeners} onClick={e => e.stopPropagation()}>
        <Icon name="grip" size={12} />
      </button>
      <input
        type="checkbox"
        checked={selected.has(item.id)}
        onClick={e => e.stopPropagation()}
        onChange={e => onToggle(item.id, e.target.checked)}
        aria-label={`Select ${displayTitle(item)}`}
      />
      <ItemCardBody item={item} snap={snap} />
      <span className="hover-actions" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        <button className="icon-button" title="Edit here" onClick={() => props.onInline(item.id)}>
          <Icon name="edit" size={14} />
        </button>
        <button className="icon-button" title="Quick send with the chat's current settings" disabled={props.busy} onClick={() => props.onQuick(item.id)}>
          <Icon name="bolt" size={14} />
        </button>
        <button className="icon-button" title="Duplicate" onClick={() => send({ op: 'item.duplicate', ids: [item.id] })}>
          <Icon name="copy" size={14} />
        </button>
        <button className="icon-button" title="Delete" onClick={() => props.onDelete(item.id)}>
          <Icon name="trash" size={14} />
        </button>
      </span>
    </div>
  );
}

function ItemCardBody({ item, snap, overlay }: { item: ChatItem; snap: Snapshot; overlay?: boolean }) {
  const eff = resolveSettings(snap.state, item.id);
  const cls = (src: string) => (src === 'item' ? 'chip own' : src === 'category' ? 'chip cat' : 'chip');
  const badge = itemBadge(snap, item.id);
  return (
    <div className={`item-body ${overlay ? 'overlay' : ''}`}>
      <div className="item-title" title={displayTitle(item)}>
        {displayTitle(item)}
      </div>
      {item.title.trim() && item.text.trim() && <div className="item-preview">{item.text.trim().split(/\r?\n/).find(l => l.trim()) ?? ''}</div>}
      <div className="chips">
        <span className={cls(eff.model.source)} title={`Model, from ${eff.model.source}`}>
          {modelChip(eff.model.value, snap.catalog)}
        </span>
        {eff.effort.value !== 'session' && (
          <span className={cls(eff.effort.source)} title={`Effort, from ${eff.effort.source}`}>
            {EFFORT_LABELS[eff.effort.value]}
          </span>
        )}
        {item.attachments.length > 0 && (
          <span className="chip" title={item.attachments.map(a => a.name).join('\n')}>
            <Icon name="clip" size={11} />
            {item.attachments.length}
          </span>
        )}
        {eff.toolPolicy.value !== 'inherit' && <span className="chip policy">{POLICY_LABELS[eff.toolPolicy.value]}</span>}
        {badge && <StatusBadge kind={badge.kind} tip={badge.tip} />}
      </div>
    </div>
  );
}

function StatusBadge({ kind, tip }: { kind: string; tip: string }) {
  const content: Record<string, ReactNode> = {
    queued: 'queued',
    running: (
      <>
        <span className="spin" /> running
      </>
    ),
    done: (
      <>
        <Icon name="check" size={11} /> done
      </>
    ),
    sent: (
      <>
        <Icon name="check" size={11} /> sent
      </>
    ),
    failed: (
      <>
        <Icon name="warn" size={11} /> failed
      </>
    ),
    cancelled: 'cancelled',
  };
  return (
    <span className={`status ${kind}`} title={tip}>
      {content[kind]}
    </span>
  );
}

// ---------- banners ----------

function BridgeBanner({ snap }: { snap: Snapshot }) {
  const b = snap.bridge;
  if (b.kind === 'connected') return null;
  if (b.kind === 'notSetUp')
    return (
      <div className="banner">
        <Icon name="info" size={14} />
        <div>
          <p>Set up the Claude bridge to send items into your Claude chats with their own model, effort and attachments.</p>
          <button className="button" onClick={() => send({ op: 'bridge.setUp' })}>
            Set Up Claude Bridge
          </button>
        </div>
      </div>
    );
  return (
    <div className={`banner ${b.kind === 'outdated' ? 'warn' : ''}`}>
      <Icon name={b.kind === 'outdated' ? 'warn' : 'info'} size={14} />
      <div>
        <p>{b.detail}</p>
        {b.kind === 'outdated' ? (
          <button className="button" onClick={() => send({ op: 'bridge.setUp' })}>
            Set Up Again
          </button>
        ) : (
          <button className="button secondary" onClick={() => send({ op: 'claude.newTab' })}>
            Open Claude Tab
          </button>
        )}
      </div>
    </div>
  );
}

function Footer({ snap }: { snap: Snapshot }) {
  const n = snap.sessions.filter(s => s.hasTab).length;
  return (
    <div className="footer">
      <span className={`live-dot ${n ? 'on' : ''}`} />
      {n ? `${n} Claude chat${n === 1 ? '' : 's'} connected in this folder` : 'No Claude chat connected'}
    </div>
  );
}
