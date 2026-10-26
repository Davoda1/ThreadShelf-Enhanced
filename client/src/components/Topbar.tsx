import { t, useI18n } from '../i18n';
import type { ReactNode } from 'react';
import { Icons } from '../icons';
import { collLabel } from '../utils';

const VIEW_LABELS: Record<string, string> = {
  get search() {
    return t('Archive');
  },
  get insights() {
    return t('Insights');
  },
  get indexing() {
    return t('Add data');
  },
  get mcp() {
    return t('MCP');
  },
  get settings() {
    return t('Settings');
  },
  get chat() {
    return t('Chat');
  },
};

interface TopbarProps {
  readonly view: string;
  readonly activeColl: string;
  readonly onMenu: () => void;
  readonly actions?: ReactNode;
}

export function Topbar({ view, activeColl, onMenu, actions }: TopbarProps) {
  useI18n();
  return (
    <div className="topbar">
      <button className="icon-btn mobile-menu-btn" onClick={onMenu} aria-label={t('Open sidebar')}>
        {Icons.menu}
      </button>
      <div className="crumbs">
        <span>{t(VIEW_LABELS[view] ?? view)}</span>
        {view === 'search' && (
          <>
            <span className="sep">/</span>
            <b>{collLabel(activeColl)}</b>
          </>
        )}
      </div>
      <div className="topbar-spacer" />
      {actions && <div className="topbar-actions">{actions}</div>}
    </div>
  );
}
