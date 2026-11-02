import { t, useI18n } from '../i18n';
import { useToastStore } from '../toast';
import { Icons } from '../icons';

const ICON_FOR = {
  info: Icons.info,
  success: Icons.check,
  error: Icons.close,
  warning: Icons.warn,
  progress: Icons.refresh,
} as const;

const LABEL_FOR = {
  info: 'Information',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  progress: 'In progress',
} as const;

export function Toaster() {
  useI18n();
  const toasts = useToastStore((s) => s.toasts);
  const dismissToast = useToastStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((item) => (
        <button
          key={item.id}
          className="toast"
          data-type={item.type}
          onClick={() => dismissToast(item.id)}
          title={t('Dismiss')}
        >
          <span className="toast-ico" aria-hidden="true">
            {ICON_FOR[item.type]}
          </span>
          <span className="toast-text">
            <strong className="toast-label">{t(LABEL_FOR[item.type])}</strong>
            <span>{t(item.text)}</span>
          </span>
          <span className="toast-dismiss" aria-hidden="true">
            ×
          </span>
        </button>
      ))}
    </div>
  );
}
