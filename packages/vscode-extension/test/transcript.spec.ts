import { describe, expect, it } from 'vitest';

import { parseTranscript, projectDirName } from '../src/shared/transcript';

const line = (o: unknown) => JSON.stringify(o);

describe('transcripts', () => {
  it("names a project folder the way Claude Code does", () => {
    expect(projectDirName(['f:', 'Development', 'Claude Chat Itemizer'].join('\\'))).toBe('f--Development-Claude-Chat-Itemizer');
    expect(projectDirName('/home/me/acme-shop')).toBe('-home-me-acme-shop');
  });

  it('takes the first prompt the person typed, skipping injected rows', () => {
    const head = [
      line({ type: 'bridge-session' }),
      line({ type: 'user', isMeta: true, message: { content: 'hidden' } }),
      line({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }),
      line({ type: 'user', message: { content: [{ type: 'text', text: '## Fix the\n  login bug' }] } }),
      line({ type: 'user', message: { content: 'second' } }),
    ].join('\n');
    expect(parseTranscript(head, '').firstPrompt).toBe('Fix the login bug');
  });

  it('takes the newest title, a rename over the generated one', () => {
    const tail = [line({ type: 'ai-title', aiTitle: 'Old title' }), line({ type: 'ai-title', aiTitle: 'Auth module refactor' })].join('\n');
    expect(parseTranscript('', tail).title).toBe('Auth module refactor');
    const renamed = `${tail}\n${line({ type: 'custom-title', customTitle: 'My name for it' })}`;
    expect(parseTranscript('', renamed).title).toBe('My name for it');
  });

  it('ignores a line cut by the read window', () => {
    const tail = `"aiTitle":"half a line"}\n${line({ type: 'ai-title', aiTitle: 'Whole' })}\n{"type":"ai-ti`;
    expect(parseTranscript('', tail).title).toBe('Whole');
  });
});
