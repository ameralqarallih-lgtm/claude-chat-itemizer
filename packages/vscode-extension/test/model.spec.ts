import { describe, expect, it } from 'vitest';

import {
  type ItemizerState,
  batchSettings,
  combinedText,
  createCategory,
  createItem,
  deleteCategory,
  deleteItems,
  duplicateItems,
  emptyState,
  markSubmitted,
  mergeStates,
  moveCategory,
  moveItem,
  normalizeState,
  orderedItemIds,
  promptText,
  resolveSettings,
  setCategorySetting,
  setItemSetting,
  strictestPolicy,
  updateItem,
  withAttachmentNote,
} from '../src/shared/model';

function world() {
  let s = emptyState();
  const cat = createCategory(s, 'Refactor');
  s = cat.state;
  const a = createItem(s, 'general', 1, { title: 'A', text: 'do a' });
  s = a.state;
  const b = createItem(s, 'general', 2, { title: 'B', text: 'do b' });
  s = b.state;
  const c = createItem(s, cat.id, 3, { title: 'C', text: 'do c' });
  s = c.state;
  return { s, cat: cat.id, a: a.id, b: b.id, c: c.id };
}

describe('settings cascade', () => {
  it('takes the item, then the category, then the defaults', () => {
    let { s, cat, c } = world();
    expect(resolveSettings(s, c).model).toEqual({ value: 'session', source: 'defaults' });
    s = { ...s, defaults: { ...s.defaults, model: 'sonnet' } };
    expect(resolveSettings(s, c).model).toEqual({ value: 'sonnet', source: 'defaults' });
    s = setCategorySetting(s, cat, 'model', 'opus');
    expect(resolveSettings(s, c).model).toEqual({ value: 'opus', source: 'category' });
    s = setItemSetting(s, c, 'model', 'haiku', 9);
    expect(resolveSettings(s, c).model).toEqual({ value: 'haiku', source: 'item' });
    s = setItemSetting(s, c, 'model', undefined, 10);
    expect(resolveSettings(s, c).model.source).toBe('category');
  });

  it('turns "session" into no override for the bridge', () => {
    const { s, a } = world();
    expect(batchSettings(resolveSettings(s, a), false)).toEqual({ toolPolicy: 'inherit' });
    const s2 = setItemSetting(setItemSetting(s, a, 'model', 'opus', 1), a, 'effort', 'high', 1);
    expect(batchSettings(resolveSettings(s2, a), false)).toEqual({ toolPolicy: 'inherit', model: 'opus', effort: 'high' });
  });

  it('only allows auto-accept edits when the setting allows it', () => {
    const { s, a } = world();
    const s2 = setItemSetting(s, a, 'toolPolicy', 'autoAcceptEdits', 1);
    expect(batchSettings(resolveSettings(s2, a), false).toolPolicy).toBe('inherit');
    expect(batchSettings(resolveSettings(s2, a), true).toolPolicy).toBe('autoAcceptEdits');
  });

  it('picks the strictest tool policy for a combined message', () => {
    expect(strictestPolicy(['inherit', 'autoAcceptEdits'])).toBe('inherit');
    expect(strictestPolicy(['autoAcceptEdits', 'readOnly', 'inherit'])).toBe('readOnly');
  });
});

describe('prompt text', () => {
  it('puts the title on top as a heading when asked', () => {
    expect(promptText({ title: 'Fix it', text: 'the bug' }, true)).toBe('## Fix it\n\nthe bug');
    expect(promptText({ title: 'Fix it', text: 'the bug' }, false)).toBe('the bug');
    expect(promptText({ title: '', text: ' only text ' }, true)).toBe('only text');
  });

  it('names the attachments in the visible message', () => {
    expect(withAttachmentNote('## T\n\ndo it', ['shot.png', 'notes.md'])).toBe('## T\n\ndo it\n\nAttached: shot.png, notes.md');
    expect(withAttachmentNote('do it', [])).toBe('do it');
  });

  it('numbers items in one combined message', () => {
    const t = combinedText([
      { title: 'One', text: 'first' },
      { title: '', text: 'second' },
    ]);
    expect(t).toContain('I have 2 tasks');
    expect(t).toContain('## 1. One\n\nfirst');
    expect(t).toContain('## 2. Task 2\n\nsecond');
  });
});

describe('organizing', () => {
  it('creates new items at the top of their category', () => {
    const { s, a, b } = world();
    expect(s.itemOrder.general).toEqual([b, a]);
  });

  it('moves an item within and across categories', () => {
    const { s, cat, a, b, c } = world();
    let m = moveItem(s, a, 'general', b);
    expect(m.itemOrder.general).toEqual([a, b]);
    m = moveItem(m, a, cat, c);
    expect(m.itemOrder.general).toEqual([b]);
    expect(m.itemOrder[cat]).toEqual([a, c]);
    m = moveItem(m, b, cat, null);
    expect(m.itemOrder[cat]).toEqual([a, c, b]);
    expect(orderedItemIds(m)).toEqual([a, c, b]);
  });

  it('reorders categories', () => {
    const { s, cat } = world();
    expect(moveCategory(s, cat, 'general').categoryOrder).toEqual([cat, 'general']);
    expect(moveCategory(s, 'general', null).categoryOrder).toEqual([cat, 'general']);
  });

  it('moves a deleted category’s items, and never deletes the last category', () => {
    const { s, cat, c } = world();
    const d = deleteCategory(s, cat, 'general');
    expect(d.categories[cat]).toBeUndefined();
    expect(d.itemOrder.general).toContain(c);
    expect(deleteCategory(d, 'general', null)).toBe(d);
  });

  it('duplicates next to the original, without the sent mark', () => {
    let { s, a } = world();
    s = markSubmitted(s, [a], 5);
    const { state, ids } = duplicateItems(s, [a], 6);
    const copy = state.items[ids[0]!]!;
    expect(copy.title).toBe('A (copy)');
    expect(copy.submittedAt).toBeUndefined();
    expect(state.itemOrder.general!.indexOf(ids[0]!)).toBe(state.itemOrder.general!.indexOf(a) + 1);
  });

  it('clears the sent mark when the item is edited, not when a setting changes', () => {
    let { s, a } = world();
    s = markSubmitted(s, [a], 5);
    expect(setItemSetting(s, a, 'effort', 'low', 6).items[a]!.submittedAt).toBe(5);
    expect(updateItem(s, a, { text: 'changed' }, 6).items[a]!.submittedAt).toBeUndefined();
  });

  it('deletes items from every list', () => {
    const { s, a, c } = world();
    const d = deleteItems(s, [a, c]);
    expect(Object.keys(d.items)).toHaveLength(1);
    expect(orderedItemIds(d)).not.toContain(a);
  });
});

describe('loading and importing', () => {
  it('repairs a state whose lists and items disagree', () => {
    const broken = {
      schemaVersion: 1,
      defaults: { model: 'opus' },
      categories: { x: { id: 'x', name: 'X', color: '#000', settings: {} } },
      categoryOrder: ['x', 'missing'],
      itemOrder: { x: ['i1', 'ghost', 'i1'] },
      items: {
        i1: { id: 'i1', title: '', text: 'a', attachments: [], settings: {}, createdAt: 0, updatedAt: 0 },
        i2: { id: 'i2', title: '', text: 'b', attachments: [], settings: {}, createdAt: 0, updatedAt: 0 },
      },
    } as unknown as ItemizerState;
    const s = normalizeState(broken);
    expect(s.categoryOrder).toEqual(['x']);
    expect(s.itemOrder.x).toEqual(['i1', 'i2']);
    expect(s.defaults.effort).toBe('session');
    expect(s.view.hideSubmitted).toBe(false);
  });

  it('merges an import by category name, with fresh ids', () => {
    const a = world();
    const b = world();
    const merged = mergeStates(a.s, b.s);
    expect(Object.keys(merged.items)).toHaveLength(6);
    expect(merged.categoryOrder).toHaveLength(2);
    expect(merged.itemOrder.general).toHaveLength(4);
    expect(new Set(Object.keys(merged.items)).size).toBe(6);
  });
});
