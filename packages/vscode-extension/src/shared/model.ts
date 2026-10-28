// The Itemizer's own data: chat items, categories, defaults, and the pure
// operations on them. Shared by the extension host and the webview, so it
// imports nothing but the bridge protocol (itself import-free).

import type { AttachmentKind, BatchItemSettings, EffortLevel, ToolPolicy } from '../../../bridge-plugin/hooks/protocol';

export type { AttachmentKind, EffortLevel, ToolPolicy };

/** `session`: leave the chat's own value alone. */
export type ModelChoice = string;
export type EffortChoice = 'session' | EffortLevel;
export type AttachmentDelivery = 'auto' | 'pathsOnly';

/** Every field optional: absent means inherit from the layer above. */
export interface ItemSettings {
  model?: ModelChoice;
  effort?: EffortChoice;
  toolPolicy?: ToolPolicy;
  attachmentDelivery?: AttachmentDelivery;
  preamble?: string;
}

export interface Defaults {
  model: ModelChoice;
  effort: EffortChoice;
  toolPolicy: ToolPolicy;
  attachmentDelivery: AttachmentDelivery;
  preamble: string;
}

export type SettingKey = keyof Defaults;
export const SETTING_KEYS: readonly SettingKey[] = ['model', 'effort', 'toolPolicy', 'attachmentDelivery', 'preamble'];

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  size: number;
  addedAt: number;
  /** `copy`: a stored copy under the workspace's storage folder. `reference`: the live file. */
  source: { mode: 'copy'; file: string; sha256: string } | { mode: 'reference'; path: string };
}

export interface ChatItem {
  id: string;
  title: string;
  text: string;
  attachments: Attachment[];
  settings: ItemSettings;
  createdAt: number;
  updatedAt: number;
  /** Set when a submission of this item finished; cleared when the item is edited. */
  submittedAt?: number;
}

export interface Category {
  id: string;
  name: string;
  color: string;
  collapsed?: boolean;
  settings: ItemSettings;
}

export interface ItemizerState {
  schemaVersion: 1;
  defaults: Defaults;
  categories: Record<string, Category>;
  categoryOrder: string[];
  /** Item ids per category, in display order. */
  itemOrder: Record<string, string[]>;
  items: Record<string, ChatItem>;
  /** `targetSessionId`: the chat picked in Send to; absent means the most recently used one. */
  view: { hideSubmitted: boolean; targetSessionId?: string };
}

export const DEFAULT_DEFAULTS: Defaults = {
  model: 'session',
  effort: 'session',
  toolPolicy: 'inherit',
  attachmentDelivery: 'auto',
  preamble: '',
};

export const CATEGORY_COLORS = ['#7C8CF8', '#E0A458', '#5FB49C', '#D9708C', '#6FB3D2', '#B48EAD', '#C9B458'];

export function newId(prefix = ''): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

export function emptyState(): ItemizerState {
  const id = 'general';
  return {
    schemaVersion: 1,
    defaults: { ...DEFAULT_DEFAULTS },
    categories: { [id]: { id, name: 'General', color: CATEGORY_COLORS[0]!, settings: {} } },
    categoryOrder: [id],
    itemOrder: { [id]: [] },
    items: {},
    view: { hideSubmitted: false },
  };
}

/** Repairs a loaded or imported state so every id it lists exists and every item is listed once. */
export function normalizeState(s: ItemizerState): ItemizerState {
  const out: ItemizerState = {
    schemaVersion: 1,
    defaults: { ...DEFAULT_DEFAULTS, ...(s.defaults ?? {}) },
    categories: { ...(s.categories ?? {}) },
    categoryOrder: (s.categoryOrder ?? []).filter(id => s.categories?.[id]),
    itemOrder: {},
    items: { ...(s.items ?? {}) },
    view: {
      hideSubmitted: !!s.view?.hideSubmitted,
      ...(typeof s.view?.targetSessionId === 'string' ? { targetSessionId: s.view.targetSessionId } : {}),
    },
  };
  for (const id of Object.keys(out.categories)) if (!out.categoryOrder.includes(id)) out.categoryOrder.push(id);
  if (out.categoryOrder.length === 0) {
    const e = emptyState();
    out.categories = e.categories;
    out.categoryOrder = e.categoryOrder;
  }
  const seen = new Set<string>();
  for (const cid of out.categoryOrder) {
    out.itemOrder[cid] = (s.itemOrder?.[cid] ?? []).filter(iid => out.items[iid] && !seen.has(iid) && seen.add(iid));
  }
  const first = out.categoryOrder[0]!;
  for (const iid of Object.keys(out.items)) if (!seen.has(iid)) out.itemOrder[first]!.push(iid);
  return out;
}

export function categoryOf(s: ItemizerState, itemId: string): Category | undefined {
  for (const cid of s.categoryOrder) if (s.itemOrder[cid]?.includes(itemId)) return s.categories[cid];
  return undefined;
}

/** Items in display order: categories in order, items in order within each. */
export function orderedItemIds(s: ItemizerState): string[] {
  return s.categoryOrder.flatMap(cid => s.itemOrder[cid] ?? []);
}

// ---------- settings ----------

export type SettingSource = 'defaults' | 'category' | 'item';
export interface Resolved<T> {
  value: T;
  source: SettingSource;
}
export type EffectiveSettings = { [K in SettingKey]: Resolved<Defaults[K]> };

export function resolveSettings(s: ItemizerState, itemId: string): EffectiveSettings {
  const item = s.items[itemId];
  const cat = categoryOf(s, itemId);
  const out = {} as Record<SettingKey, Resolved<unknown>>;
  for (const key of SETTING_KEYS) {
    const own = item?.settings[key];
    const fromCat = cat?.settings[key];
    out[key] =
      own !== undefined
        ? { value: own, source: 'item' }
        : fromCat !== undefined
          ? { value: fromCat, source: 'category' }
          : { value: s.defaults[key], source: 'defaults' };
  }
  return out as EffectiveSettings;
}

/** The settings a batch carries for one item: `session` means no override. */
export function batchSettings(eff: EffectiveSettings, allowLoosening: boolean): BatchItemSettings {
  const policy = eff.toolPolicy.value === 'autoAcceptEdits' && !allowLoosening ? 'inherit' : eff.toolPolicy.value;
  const out: BatchItemSettings = { toolPolicy: policy };
  if (eff.model.value && eff.model.value !== 'session') out.model = eff.model.value;
  if (eff.effort.value !== 'session') out.effort = eff.effort.value;
  if (eff.preamble.value.trim()) out.preamble = eff.preamble.value.trim();
  return out;
}

const POLICY_STRICTNESS: Record<ToolPolicy, number> = { readOnly: 2, inherit: 1, autoAcceptEdits: 0 };

export function strictestPolicy(policies: readonly ToolPolicy[]): ToolPolicy {
  return policies.reduce<ToolPolicy>((a, b) => (POLICY_STRICTNESS[b] > POLICY_STRICTNESS[a] ? b : a), 'autoAcceptEdits');
}

// ---------- prompt text ----------

export function promptText(item: Pick<ChatItem, 'title' | 'text'>, titleAsHeading: boolean): string {
  const text = item.text.trim();
  const title = item.title.trim();
  if (!titleAsHeading || !title) return text || title;
  return text ? `## ${title}\n\n${text}` : `## ${title}`;
}

/**
 * Names the attachments in the visible message. Their content reaches Claude
 * as a hidden row the chat does not show, so without this line the person
 * cannot tell from the chat that anything was attached.
 */
export function withAttachmentNote(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  return `${text}\n\nAttached: ${names.join(', ')}`;
}

/** All items in one message: numbered sections, in order. */
export function combinedText(items: readonly Pick<ChatItem, 'title' | 'text'>[]): string {
  if (items.length === 1) return promptText(items[0]!, true);
  const intro = `I have ${items.length} tasks. Work through them in order and report on each.`;
  const sections = items.map((it, i) => {
    const title = it.title.trim() || `Task ${i + 1}`;
    return `## ${i + 1}. ${title}\n\n${it.text.trim()}`.trimEnd();
  });
  return [intro, ...sections].join('\n\n');
}

export function displayTitle(item: Pick<ChatItem, 'title' | 'text'>): string {
  return item.title.trim() || item.text.trim().split(/\r?\n/)[0]?.slice(0, 80) || 'Untitled item';
}

// ---------- operations (pure: each returns a new state) ----------

export function createItem(s: ItemizerState, categoryId: string | undefined, now: number, fields: Partial<ChatItem> = {}): { state: ItemizerState; id: string } {
  const cid = categoryId && s.categories[categoryId] ? categoryId : s.categoryOrder[0]!;
  const id = newId('i');
  const item: ChatItem = { id, title: '', text: '', attachments: [], settings: {}, createdAt: now, updatedAt: now, ...fields };
  return {
    id,
    state: {
      ...s,
      items: { ...s.items, [id]: { ...item, id } },
      itemOrder: { ...s.itemOrder, [cid]: [id, ...(s.itemOrder[cid] ?? [])] },
      categories: { ...s.categories, [cid]: { ...s.categories[cid]!, collapsed: false } },
    },
  };
}

export type ItemPatch = Partial<Pick<ChatItem, 'title' | 'text' | 'settings' | 'attachments'>>;

export function updateItem(s: ItemizerState, id: string, patch: ItemPatch, now: number): ItemizerState {
  const item = s.items[id];
  if (!item) return s;
  const contentChanged = patch.title !== undefined || patch.text !== undefined || patch.attachments !== undefined;
  const next: ChatItem = { ...item, ...patch, updatedAt: now };
  if (contentChanged && item.submittedAt) delete next.submittedAt;
  return { ...s, items: { ...s.items, [id]: next } };
}

/** Sets one item setting, or with `undefined` removes the override. */
export function setItemSetting<K extends SettingKey>(s: ItemizerState, id: string, key: K, value: Defaults[K] | undefined, now: number): ItemizerState {
  const item = s.items[id];
  if (!item) return s;
  const settings = { ...item.settings } as ItemSettings;
  if (value === undefined) delete settings[key];
  else (settings as Record<string, unknown>)[key] = value;
  return updateItem(s, id, { settings }, now);
}

export function setCategorySetting<K extends SettingKey>(s: ItemizerState, id: string, key: K, value: Defaults[K] | undefined): ItemizerState {
  const cat = s.categories[id];
  if (!cat) return s;
  const settings = { ...cat.settings } as ItemSettings;
  if (value === undefined) delete settings[key];
  else (settings as Record<string, unknown>)[key] = value;
  return { ...s, categories: { ...s.categories, [id]: { ...cat, settings } } };
}

export function deleteItems(s: ItemizerState, ids: readonly string[]): ItemizerState {
  const gone = new Set(ids);
  const items = { ...s.items };
  for (const id of ids) delete items[id];
  const itemOrder: Record<string, string[]> = {};
  for (const [cid, list] of Object.entries(s.itemOrder)) itemOrder[cid] = list.filter(i => !gone.has(i));
  return { ...s, items, itemOrder };
}

export function duplicateItems(s: ItemizerState, ids: readonly string[], now: number): { state: ItemizerState; ids: string[] } {
  let state = s;
  const created: string[] = [];
  for (const id of ids) {
    const item = state.items[id];
    const cat = categoryOf(state, id);
    if (!item || !cat) continue;
    const nid = newId('i');
    const copy: ChatItem = {
      ...structuredClone(item),
      id: nid,
      title: item.title ? `${item.title} (copy)` : '',
      createdAt: now,
      updatedAt: now,
      attachments: item.attachments.map(a => ({ ...a, id: newId('a') })),
    };
    delete copy.submittedAt;
    const list = [...(state.itemOrder[cat.id] ?? [])];
    list.splice(list.indexOf(id) + 1, 0, nid);
    state = { ...state, items: { ...state.items, [nid]: copy }, itemOrder: { ...state.itemOrder, [cat.id]: list } };
    created.push(nid);
  }
  return { state, ids: created };
}

/** Moves an item into a category, before `beforeId` (or to the end when null or not found). */
export function moveItem(s: ItemizerState, id: string, toCategoryId: string, beforeId: string | null): ItemizerState {
  if (!s.items[id] || !s.categories[toCategoryId] || id === beforeId) return s;
  const itemOrder: Record<string, string[]> = {};
  for (const [cid, list] of Object.entries(s.itemOrder)) itemOrder[cid] = list.filter(i => i !== id);
  const target = [...(itemOrder[toCategoryId] ?? [])];
  const at = beforeId ? target.indexOf(beforeId) : -1;
  if (at < 0) target.push(id);
  else target.splice(at, 0, id);
  itemOrder[toCategoryId] = target;
  return { ...s, itemOrder };
}

export function createCategory(s: ItemizerState, name: string): { state: ItemizerState; id: string } {
  const id = newId('c');
  const color = CATEGORY_COLORS[s.categoryOrder.length % CATEGORY_COLORS.length]!;
  return {
    id,
    state: {
      ...s,
      categories: { ...s.categories, [id]: { id, name: name.trim() || 'New category', color, settings: {} } },
      categoryOrder: [...s.categoryOrder, id],
      itemOrder: { ...s.itemOrder, [id]: [] },
    },
  };
}

export function updateCategory(s: ItemizerState, id: string, patch: Partial<Pick<Category, 'name' | 'color' | 'collapsed'>>): ItemizerState {
  const cat = s.categories[id];
  if (!cat) return s;
  return { ...s, categories: { ...s.categories, [id]: { ...cat, ...patch } } };
}

/** Deletes a category; its items move to `moveTo`, or are deleted when it is null. The last category stays. */
export function deleteCategory(s: ItemizerState, id: string, moveTo: string | null): ItemizerState {
  if (!s.categories[id] || s.categoryOrder.length <= 1) return s;
  const items = s.itemOrder[id] ?? [];
  let state: ItemizerState = s;
  if (moveTo && moveTo !== id && s.categories[moveTo]) {
    state = { ...state, itemOrder: { ...state.itemOrder, [moveTo]: [...(state.itemOrder[moveTo] ?? []), ...items] } };
  } else {
    state = deleteItems(state, items);
  }
  const categories = { ...state.categories };
  delete categories[id];
  const itemOrder = { ...state.itemOrder };
  delete itemOrder[id];
  return { ...state, categories, itemOrder, categoryOrder: state.categoryOrder.filter(c => c !== id) };
}

export function moveCategory(s: ItemizerState, id: string, beforeId: string | null): ItemizerState {
  if (!s.categories[id] || id === beforeId) return s;
  const order = s.categoryOrder.filter(c => c !== id);
  const at = beforeId ? order.indexOf(beforeId) : -1;
  if (at < 0) order.push(id);
  else order.splice(at, 0, id);
  return { ...s, categoryOrder: order };
}

export function markSubmitted(s: ItemizerState, ids: readonly string[], at: number): ItemizerState {
  const items = { ...s.items };
  for (const id of ids) if (items[id]) items[id] = { ...items[id]!, submittedAt: at };
  return { ...s, items };
}

/** Attachment files still referenced by an item, for garbage collection. */
export function referencedFiles(s: ItemizerState): Set<string> {
  const out = new Set<string>();
  for (const item of Object.values(s.items)) for (const a of item.attachments) if (a.source.mode === 'copy') out.add(a.source.file);
  return out;
}

/** Adds `b` to `a`: categories matched by name, every imported item gets a fresh id. */
export function mergeStates(a: ItemizerState, b: ItemizerState): ItemizerState {
  const out: ItemizerState = structuredClone(a);
  for (const cid of b.categoryOrder) {
    const cat = b.categories[cid]!;
    let target = Object.values(out.categories).find(c => c.name.toLowerCase() === cat.name.toLowerCase());
    if (!target) {
      const id = newId('c');
      target = { ...cat, id };
      out.categories[id] = target;
      out.categoryOrder.push(id);
      out.itemOrder[id] = [];
    }
    for (const iid of b.itemOrder[cid] ?? []) {
      const item = b.items[iid];
      if (!item) continue;
      const id = newId('i');
      out.items[id] = { ...item, id, attachments: item.attachments.map(x => ({ ...x, id: newId('a') })) };
      out.itemOrder[target.id]!.push(id);
    }
  }
  return normalizeState(out);
}
