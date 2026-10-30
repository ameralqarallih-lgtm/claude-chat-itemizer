import { type ReactNode, useEffect, useRef } from 'react';

import { Icon } from './icons';

/** An inline "are you sure" row: Cancel takes focus, Esc cancels. */
export function ConfirmBar({ message, confirm = 'Delete', onConfirm, onCancel }: { message: ReactNode; confirm?: string; onConfirm: () => void; onCancel: () => void }) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  return (
    <div
      className="confirm-bar"
      role="alertdialog"
      aria-label={typeof message === 'string' ? message : 'Confirm'}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <Icon name="trash" size={13} />
      <span className="confirm-text">{message}</span>
      <span className="confirm-buttons">
        <button ref={cancel} className="button secondary small" onClick={onCancel}>
          Cancel
        </button>
        <button className="button small danger" onClick={onConfirm}>
          {confirm}
        </button>
      </span>
    </div>
  );
}
