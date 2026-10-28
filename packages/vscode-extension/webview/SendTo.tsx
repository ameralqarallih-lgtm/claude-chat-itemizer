import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import type { SessionView, Snapshot } from '../src/shared/messages';
import { send } from './api';
import { Icon } from './icons';
import { sessionMeta, sessionName } from './labels';

const AUTO = '__auto__';

interface Choice {
  value: string;
  name: string;
  meta?: string;
  live: boolean;
}

/** Which Claude chat Quick, the item bolts and Submit… send to. A listbox, so long chat names wrap. */
export function SendTo({ snap }: { snap: Snapshot }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);

  const chats = snap.sessions.filter(s => s.isCompatible && s.hasTab);
  const picked = snap.state.view.targetSessionId;
  const pickedGone = !!picked && !chats.some(s => s.sessionId === picked);
  const auto = chats.find(s => s.sessionId === snap.resolvedTargetId);

  const toChoice = (s: SessionView): Choice => ({ value: s.sessionId, name: sessionName(s), meta: sessionMeta(s, snap.catalog), live: s.state === 'busy' });
  const choices: Choice[] = [
    { value: AUTO, name: 'Most recently used chat', meta: !picked && auto ? `Now: ${sessionName(auto)}` : chats.length ? undefined : 'No chat connected yet', live: false },
    ...chats.map(toChoice),
    ...(pickedGone ? [{ value: picked, name: 'Closed chat', meta: 'Pick another one', live: false }] : []),
  ];
  const current = picked ?? AUTO;
  const selected = choices.find(c => c.value === current) ?? choices[0]!;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  if (snap.bridge.kind === 'notSetUp') return null;

  const choose = (value: string) => {
    send({ op: 'target.set', sessionId: value === AUTO ? null : value });
    setOpen(false);
  };
  const openList = () => {
    setActive(Math.max(0, choices.findIndex(c => c.value === current)));
    setOpen(true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(a => Math.min(choices.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(a => Math.max(0, a - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(choices[active]!.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="send-to" ref={root}>
      <span className="label" id="send-to-label">
        Send to
      </span>
      <div className="send-to-row">
        <button
          type="button"
          className={`picker ${open ? 'open' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-labelledby="send-to-label"
          aria-activedescendant={open ? `send-to-opt-${active}` : undefined}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onKey}
        >
          <ChoiceText choice={selected} />
          <Icon name="chev" size={12} className="picker-chev" />
        </button>
        <button className="icon-button" title="Open a new Claude tab" aria-label="Open a new Claude tab" onClick={() => send({ op: 'claude.newTab' })}>
          <Icon name="plus" size={14} />
        </button>
        {open && (
          <ul className="picker-list" role="listbox" aria-labelledby="send-to-label" ref={list}>
            {choices.map((c, i) => (
              <li
                key={c.value}
                id={`send-to-opt-${i}`}
                data-index={i}
                role="option"
                aria-selected={c.value === current}
                className={`${i === active ? 'active' : ''} ${c.value === current ? 'selected' : ''}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => choose(c.value)}
              >
                <ChoiceText choice={c} />
                {c.value === current && <Icon name="check" size={13} className="picker-check" />}
              </li>
            ))}
          </ul>
        )}
      </div>
      {pickedGone && <p className="send-to-note problem">That chat is closed. Pick another one.</p>}
      {!pickedGone && chats.length === 0 && <p className="send-to-note">No Claude chat in this folder is connected. Open a new Claude tab.</p>}
    </div>
  );
}

function ChoiceText({ choice }: { choice: Choice }) {
  return (
    <span className="choice">
      <span className="choice-name">{choice.name}</span>
      {choice.meta && (
        <span className="choice-meta">
          {choice.live && <span className="spin" />}
          {choice.meta}
        </span>
      )}
    </span>
  );
}
