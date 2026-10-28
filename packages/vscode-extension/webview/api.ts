import { useSyncExternalStore } from 'react';

import type { HostMessage, Op, Snapshot } from '../src/shared/messages';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

let snapshot: Snapshot | undefined;
const listeners = new Set<() => void>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: RequestError) => void }>();
let nextId = 1;
const openSubmitListeners = new Set<(ids: string[]) => void>();

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

window.addEventListener('message', (ev: MessageEvent<HostMessage>) => {
  const m = ev.data;
  if (!m || typeof m !== 'object') return;
  if (m.type === 'snapshot') {
    snapshot = m.snapshot;
    for (const l of listeners) l();
  } else if (m.type === 'response') {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.result);
    else p.reject(new RequestError(m.error ?? 'Something went wrong.', m.code));
  } else if (m.type === 'openSubmit') {
    for (const l of openSubmitListeners) l(m.itemIds);
  }
});

export function request<T = unknown>(body: Op): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    vscode.postMessage({ type: 'request', id, body });
  });
}

/** Fire and forget; failures are logged by the host. */
export function send(body: Op): void {
  void request(body).catch(() => undefined);
}

export function useSnapshot(): Snapshot | undefined {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

export function onOpenSubmit(fn: (ids: string[]) => void): () => void {
  openSubmitListeners.add(fn);
  return () => openSubmitListeners.delete(fn);
}

/** Per-webview UI state VS Code keeps while the view is hidden. */
export function loadUiState<T>(fallback: T): T {
  try {
    return { ...fallback, ...((vscode.getState() as Partial<T>) ?? {}) };
  } catch {
    return fallback;
  }
}

export function saveUiState(s: unknown): void {
  vscode.setState(s);
}

export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const route = document.body.dataset.route === 'editor' ? 'editor' : 'sidebar';
