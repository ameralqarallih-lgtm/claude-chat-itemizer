// itemizer-bridge: carries chat items from the Claude Chat Itemizer VS Code
// extension into this Claude session. The logic lives in runner.ts; this file
// only connects it to the engine's events and `$`.

import type { EngineInterface, Register } from 'claude-code';

import { PLUGIN_NAME, joinPath } from './protocol.ts';
import { type Ports, Runner } from './runner.ts';

const TICK_MS = 1_000;

// Module state starts over on a reload; the runner rebuilds from its files.
let runner: Runner | undefined;
let generation = 0;

async function bridgeRoot($: EngineInterface): Promise<string> {
  const override = await $.env.get('ITEMIZER_BRIDGE_DIR');
  if (override) return override;
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.';
  return joinPath(home, '.claude', 'itemizer', 'v1');
}

function portsFor($: EngineInterface): Ports {
  return {
    now: () => $.clock.now(),
    read: path => $.fs.read(path),
    write: (path, text) => $.fs.write(path, text),
    list: async path => (await $.fs.list(path)).map(e => ({ name: e.name, kind: e.kind })),
    exists: path => $.fs.exists(path),
    submit: async text => {
      const r = await $.prompt.submit({ text, asUser: true });
      return { drop: typeof r.drop === 'string' ? r.drop : undefined };
    },
    abort: turnId => $.turn.abort({ turnId }),
    append: async blocks => {
      const r = await $.session.append({ message: { type: 'user', content: blocks.map(text => ({ type: 'text' as const, text })) } });
      return r.deny === undefined;
    },
    log: text => $.ui.log(`${PLUGIN_NAME}: ${text}`, { to: 'debug' }),
    status: text => $.ui.status(text),
    history: async () => {
      const msgs = await $.session.messages();
      if (!Array.isArray(msgs)) return { turns: 0 };
      // The person's own prompts: user rows with text that is not injected context.
      const prompts = msgs.filter(m => m.role === 'user' && m.text.trim() !== '' && !m.text.trimStart().startsWith('<'));
      return { turns: prompts.length, firstPrompt: prompts[0]?.text };
    },
    session: async () => ({
      id: await $.session.id(),
      cwd: await $.session.cwd(),
      model: await $.session.model(),
      surfaces: [...(await $.session.surfaces().catch(() => []))],
    }),
  };
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const mine = ++generation;
    const r = new Runner(portsFor($), await bridgeRoot($));
    await r.start();
    runner = r;
    await $.command.register({
      name: 'itemizer-run',
      description: 'Run chat items the Claude Chat Itemizer prepared for this conversation',
      argumentHint: '<claim id>',
    });
    const loop = (): void => {
      if (mine !== generation) return;
      void r.tick().finally(() => {
        if (mine === generation) $.clock.after(TICK_MS, loop);
      });
    };
    $.clock.after(250, loop);
    return next(e);
  });

  on('prompt.submit', ($, e, next) => {
    const blocks = runner?.promptContext(e.text, e.origin as { kind: string; name?: string });
    return blocks && blocks.length > 0 ? next({ ...e, context: [...(e.context ?? []), ...blocks] }) : next(e);
  }).catch(($, e, next) => next(e));

  on('turn.start', async ($, e, next) => {
    await runner?.onTurnStart(e.turnId, e.text);
    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const o = runner?.stepOverride(e.turnId, e.agentId, e.model);
    if (!o) return yield* next(e);
    const rewritten = { ...e };
    if (o.model) rewritten.model = o.model;
    if (o.effort) rewritten.effort = o.effort;
    return yield* next(rewritten);
  });

  on('turn.complete', async ($, e, next) => {
    await runner?.onTurnComplete({
      turnId: e.turnId,
      agentId: e.agentId,
      reason: e.reason,
      answer: e.answer,
      model: e.usage?.model,
    });
    return next(e);
  });

  on('tool.check', async ($, e, next) => {
    const r = runner;
    if (!r) return next(e);
    let realPath: string | undefined;
    const filePath = (e.input as { file_path?: unknown } | undefined)?.file_path;
    if (r.wantsRealPath(e.tool) && typeof filePath === 'string') {
      realPath = await $.fs
        .stat(filePath, { resolve: true })
        .then(s => s.realPath)
        .catch(() => undefined);
    }
    const verdict = r.toolDecision(e.tool, e.input, realPath);
    return verdict ?? next(e);
  }).catch(($, e, next) => next(e));

  on('command.run', { command: 'itemizer-run' }, async ($, e) => {
    if (!runner) return { text: 'Itemizer: the bridge is still starting. Try again in a moment.' };
    return { text: await runner.adoptClaim(e.args.trim()) };
  });

  // Claude Code's title for the conversation (the tab's label) rides on these classic events.
  on('classic.SessionStart', ($, e, next) => {
    runner?.setTitle(e.session_title);
    return next(e);
  });
  on('classic.UserPromptSubmit', ($, e, next) => {
    runner?.setTitle(e.session_title);
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    await runner?.onSessionEnd(e.reason);
    return next(e);
  });
};
