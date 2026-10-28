import { promises as fs } from 'node:fs';
import * as path from 'node:path';

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function retry<T>(fn: () => Promise<T>, attempts = 10, delayMs = 50): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (i >= attempts - 1 || !RETRY_CODES.has(code)) throw err;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/** Writes JSON so a reader never sees half a file: a temp file, then a rename. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  try {
    await retry(() => fs.rename(tmp, file));
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * Reads JSON written by the plugin, whose writes are not atomic: a file that
 * does not parse is read again after a short pause, then given up on.
 */
export async function readJson<T>(file: string, attempts = 3): Promise<T | undefined> {
  for (let i = 0; i < attempts; i++) {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      await new Promise(r => setTimeout(r, 120));
    }
  }
  return undefined;
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export async function remove(p: string): Promise<void> {
  await retry(() => fs.rm(p, { recursive: true, force: true })).catch(() => undefined);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
