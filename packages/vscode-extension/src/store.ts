import * as vscode from 'vscode';

import { type ItemizerState, emptyState, normalizeState } from './shared/model';

const KEY = 'itemizer.state.v1';

/** The workspace's items, kept in VS Code's private storage for this workspace. */
export class Store implements vscode.Disposable {
  private current: ItemizerState;
  private readonly changed = new vscode.EventEmitter<ItemizerState>();
  readonly onDidChange = this.changed.event;
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly memento: vscode.Memento) {
    const saved = memento.get<ItemizerState>(KEY);
    this.current = saved ? normalizeState(saved) : emptyState();
  }

  get state(): ItemizerState {
    return this.current;
  }

  update(fn: (s: ItemizerState) => ItemizerState): ItemizerState {
    const next = fn(this.current);
    if (next === this.current) return next;
    this.current = next;
    this.saving = this.saving.then(() => this.memento.update(KEY, next)).then(undefined, () => undefined);
    this.changed.fire(next);
    return next;
  }

  replace(state: ItemizerState): void {
    this.update(() => normalizeState(state));
  }

  flush(): Promise<void> {
    return this.saving;
  }

  dispose(): void {
    this.changed.dispose();
  }
}
