// Reading Claude Code transcripts (~/.claude/projects/<project>/<session>.jsonl). Pure, for tests.

/** Claude Code's folder name for a project: every character but letters and digits becomes '-'. */
export function projectDirName(folder: string): string {
  return folder.replace(/[^a-zA-Z0-9]/g, '-');
}

/** A user prompt's text, or undefined for a row the person did not type. */
function promptText(row: Record<string, unknown>): string | undefined {
  if (row.type !== 'user' || row.isMeta || row.isSidechain) return undefined;
  const content = (row.message as { content?: unknown } | undefined)?.content;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b: { type?: string }) => b?.type === 'text')
            .map((b: { text?: string }) => b.text ?? '')
            .join('\n')
        : '';
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('Caveat:')) return undefined;
  return t;
}

function rows(chunk: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a line cut by the head or tail window
    }
  }
  return out;
}

/**
 * Reads a transcript's name from its first and last bytes: the first prompt
 * from the head, the newest title (a /rename wins over the generated one)
 * from the tail.
 */
export function parseTranscript(head: string, tail: string): { title?: string; firstPrompt?: string } {
  let firstPrompt: string | undefined;
  for (const r of rows(head)) {
    firstPrompt = promptText(r);
    if (firstPrompt) break;
  }
  let title: string | undefined;
  let custom: string | undefined;
  for (const r of rows(tail)) {
    if (r.type === 'custom-title' && typeof r.customTitle === 'string') custom = r.customTitle;
    if (r.type === 'ai-title' && typeof r.aiTitle === 'string') title = r.aiTitle;
    if (r.type === 'summary' && typeof r.summary === 'string' && !title) title = r.summary;
  }
  const one = (s: string | undefined, max: number) => {
    const t = s?.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    return t ? (t.length > max ? `${t.slice(0, max - 1)}…` : t) : undefined;
  };
  return { title: one(custom ?? title, 80), firstPrompt: one(firstPrompt, 80) };
}
