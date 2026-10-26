import { t, useI18n } from '../i18n';
import { useNavigate } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { Icons } from '../icons';
import { Topbar } from './Topbar';

/**
 * Shown for any URL the router does not know. Without it an unknown path (a
 * stale bookmark, a hand-edited link) rendered as bare unstyled "Not Found"
 * text with no way back.
 */
export function NotFound() {
  useI18n();
  const navigate = useNavigate();
  const activeColl = useUIStore((state) => state.activeColl);
  const setSidebarOpen = useUIStore((state) => state.setSidebarOpen);

  return (
    <>
      <Topbar view="search" activeColl={activeColl} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="view">
          <div className="empty" id="notFound">
            <h3>{t('That page does not exist.')}</h3>
            <p>
              {t('The address ')}
              <code>{window.location.pathname}</code>
              {t(
                ' is not part of ThreadShelf. The link may be from an older version, or a path may have been mistyped.',
              )}
            </p>
            <div className="examples">
              <button
                className="example-chip"
                onClick={() =>
                  void navigate({
                    to: '/search/$collection',
                    params: { collection: activeColl || 'all' },
                  })
                }
              >
                {Icons.search}
                <span>{t('Back to search')}</span>
              </button>
              <button className="example-chip" onClick={() => void navigate({ to: '/indexing' })}>
                {Icons.download}
                <span>{t('Index a folder')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
