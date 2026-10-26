import { t, useI18n } from '../i18n';
import { useUIStore } from '../store';
import { Icons } from '../icons';

interface ThemeToggleProps {
  /** `full` shows a labelled row, `icon` shows a compact icon button. */
  readonly variant?: 'full' | 'icon';
}

export function ThemeToggle({ variant = 'full' }: ThemeToggleProps) {
  useI18n();
  const theme = useUIStore((s) => s.theme);
  const toggleTheme = useUIStore((s) => s.toggleTheme);
  const isDark = theme === 'dark';
  const nextLabel = isDark ? t('Light') : t('Dark');

  return (
    <button
      className={`theme-toggle ${variant}`}
      onClick={toggleTheme}
      title={t('Switch to {value0} theme', { value0: nextLabel })}
      aria-label={t('Switch to {value0} theme', { value0: nextLabel })}
    >
      <span className="tt-ico">{isDark ? Icons.sun : Icons.moon}</span>
      {variant === 'full' && <span className="tt-label">{isDark ? t('Light') : t('Dark')}</span>}
    </button>
  );
}
