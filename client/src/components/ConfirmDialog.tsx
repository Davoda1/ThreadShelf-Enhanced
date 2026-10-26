import { t, useI18n } from '../i18n';
import { useEffect } from 'react';
import { useToastStore } from '../toast';

export function ConfirmDialog() {
  useI18n();
  const confirmState = useToastStore((s) => s.confirmState);
  const resolveConfirm = useToastStore((s) => s.resolveConfirm);

  useEffect(() => {
    if (!confirmState) return;
    // Only Escape is handled globally. Enter is left to the focused button so
    // that pressing Enter while Cancel is focused does NOT confirm a destructive
    // action — the Confirm button is autoFocused, so Enter still confirms by default.
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      resolveConfirm(false);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [confirmState, resolveConfirm]);

  if (!confirmState) return null;

  const { title, message, confirmLabel, cancelLabel, danger } = confirmState;

  return (
    <div className="scrim" onClick={() => resolveConfirm(false)}>
      <div
        className="modal-card"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={message ? 'confirm-dialog-message' : undefined}
      >
        <div className="modal-head">
          <h3 id="confirm-dialog-title">{t(title)}</h3>
          {message && <p id="confirm-dialog-message">{t(message)}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={() => resolveConfirm(false)}>
            {t(cancelLabel ?? 'Cancel')}
          </button>
          <button
            className={`btn ${danger ? 'danger' : 'primary'}`}
            onClick={() => resolveConfirm(true)}
            autoFocus
          >
            {t(confirmLabel ?? 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
