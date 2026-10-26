import { t, useI18n } from '../i18n';
import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useUIStore } from '../store';
import { useInsightsQuery, useCollectionsQuery } from '../queries';
import { Topbar } from '../components/Topbar';
import { getProvider } from '../constants';
import { collLabel, fmtDate, shortPath } from '../utils';
import type { ActivityBucket, LongestThread } from '../types';

const compact = (n: number): string =>
  new Intl.NumberFormat(useUIStore.getState().locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);

const full = (n: number): string => n.toLocaleString(useUIStore.getState().locale);

// Round a max value up to a clean axis number (1/2/5 × 10^k).
const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
};

const monthLabel = (month: string): string => {
  const date = new Date(`${month}-01T00:00:00Z`);
  return new Intl.DateTimeFormat(useUIStore.getState().locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
};

const axisMonthLabel = (month: string): string => {
  const date = new Date(`${month}-01T00:00:00Z`);
  const name = new Intl.DateTimeFormat(useUIStore.getState().locale, {
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
  return `${name} ’${month.slice(2, 4)}`;
};

function StatTile({ label, value }: { readonly label: string; readonly value: number }) {
  useI18n();
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value" title={full(value)}>
        {compact(value)}
      </span>
    </div>
  );
}

// Monthly activity as an HTML column chart: single series (no legend), columns
// grow from the baseline with rounded data-ends, hairline gridlines behind,
// tooltip + peak label carry the values.
function ActivityChart({ activity }: { readonly activity: readonly ActivityBucket[] }) {
  useI18n();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(...activity.map((b) => b.count), 0));
  const peakIdx = useMemo(() => {
    let idx = 0;
    activity.forEach((b, i) => {
      if (b.count > (activity[idx]?.count ?? 0)) idx = i;
    });
    return idx;
  }, [activity]);

  if (activity.length === 0) {
    return (
      <p className="chart-empty">{t('No dated turns yet — timestamps appear as you index.')}</p>
    );
  }

  // Label january of each year; if the range is short, label every ~6th month.
  const labelEvery = activity.length > 18 ? 12 : activity.length > 8 ? 6 : 2;

  return (
    <div className="activity-chart" onMouseLeave={() => setHover(null)}>
      <div className="chart-grid" aria-hidden="true">
        {[1, 0.5, 0].map((f) => {
          const value = max * f;
          return (
            <div key={f} className="grid-row">
              {/* Never label a gridline with a rounded lie (max 5 → mid 2.5). */}
              <span className="grid-tick">{Number.isInteger(value) ? full(value) : ''}</span>
              <span className="grid-line" />
            </div>
          );
        })}
      </div>
      <div className="chart-cols" role="img" aria-label={t('Indexed passages per month')}>
        {activity.map((bucket, i) => {
          const pct = max > 0 ? (bucket.count / max) * 100 : 0;
          const isPeak = i === peakIdx && bucket.count > 0;
          return (
            <div
              key={bucket.month}
              className="col-slot"
              onMouseEnter={() => setHover(i)}
              aria-label={t('{value0}: {value1} passages', {
                value0: monthLabel(bucket.month),
                value1: full(bucket.count),
              })}
            >
              {isPeak && hover === null && <span className="col-peak">{full(bucket.count)}</span>}
              <div
                className="col-bar"
                data-hover={hover === i}
                style={{ height: `${Math.max(pct, bucket.count > 0 ? 2 : 0)}%` }}
              />
              {hover === i && (
                <div className="chart-tip">
                  <b>{monthLabel(bucket.month)}</b>
                  <span>
                    {full(bucket.count)}
                    {t(' passages')}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="chart-x" aria-hidden="true">
        {activity.map((bucket, i) => (
          <span key={bucket.month} className="x-slot">
            {i % labelEvery === 0 ? axisMonthLabel(bucket.month) : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

// Horizontal bar list: identity is the row's text label (plus provider dot
// where relevant), the bar carries magnitude in the single accent hue.
function BarList({
  items,
}: {
  readonly items: readonly {
    readonly key: string;
    readonly label: React.ReactNode;
    readonly value: number;
    readonly detail?: string;
  }[];
}) {
  useI18n();
  const max = Math.max(...items.map((item) => item.value), 1);
  return (
    <div className="bar-list">
      {items.map((item) => (
        <div key={item.key} className="bar-row" title={item.detail}>
          <span className="bar-label">{item.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </span>
          <span className="bar-value">{full(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function InsightsPage() {
  useI18n();
  const navigate = useNavigate();
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const activeColl = useUIStore((s) => s.activeColl);
  const [scope, setScope] = useState(activeColl || 'all');

  const { data: collData } = useCollectionsQuery();
  const collections = collData?.collections ?? ['all'];
  const { data, isLoading, isError } = useInsightsQuery(scope);

  const openThread = (thread: LongestThread) => {
    void navigate({
      to: '/thread',
      search: {
        sourceFile: thread.sourceFile,
        collection: thread.collection,
        conversationKey: thread.conversationKey || undefined,
        title: thread.title || undefined,
        provider: thread.provider || undefined,
      },
    });
  };

  const isEmpty = data != null && data.totals.chunks === 0;

  return (
    <>
      <Topbar view="insights" activeColl={scope} onMenu={() => setSidebarOpen(true)} />
      <div className="main-scroll">
        <div className="view insights-view">
          <div className="insights-head">
            <div>
              <h2>{t('Archive insights')}</h2>
              {data?.firstActivity && data?.lastActivity && (
                <p className="insights-range">
                  {fmtDate(data.firstActivity).split(',')[0]} —{' '}
                  {fmtDate(data.lastActivity).split(',')[0]}
                </p>
              )}
            </div>
            <label className="insights-scope">
              <span>{t('scope')}</span>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                aria-label={t('Insights scope')}
              >
                {collections.map((c) => (
                  <option key={c} value={c}>
                    {collLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {isError && (
            <div className="empty">
              <h3>{t('Could not load insights.')}</h3>
              <p>{t('Is the backend running?')}</p>
            </div>
          )}

          {isLoading && <div className="shimmer-card" style={{ height: 220 }} />}

          {isEmpty && (
            <div className="empty">
              <h3>{t('Nothing indexed yet.')}</h3>
              <p>{t('Index a folder of chat exports and your archive stats will appear here.')}</p>
            </div>
          )}

          {data && !isEmpty && (
            <>
              <div className="stat-tiles">
                <StatTile label={t('Conversations')} value={data.totals.conversations} />
                <StatTile label={t('Turns')} value={data.totals.turns} />
                <StatTile label={t('Files')} value={data.totals.files} />
                <StatTile label={t('Indexed passages')} value={data.totals.chunks} />
                {scope === 'all' && (
                  <StatTile label={t('Collections')} value={data.totals.collections} />
                )}
              </div>

              <section className="insight-card">
                <h3>{t('Activity over time')}</h3>
                <p className="insight-sub">{t('Indexed passages per month, by turn date')}</p>
                <ActivityChart activity={data.activity} />
              </section>

              <div className="insight-grid">
                <section className="insight-card">
                  <h3>{t('Top models')}</h3>
                  <p className="insight-sub">{t('By indexed passages')}</p>
                  {data.topModels.length === 0 ? (
                    <p className="chart-empty">{t('No model metadata in this scope.')}</p>
                  ) : (
                    <BarList
                      items={data.topModels.map((m) => ({
                        key: m.model,
                        label: <span className="mono">{m.model}</span>,
                        value: m.count,
                        detail: `${m.model}: ${full(m.count)} passages`,
                      }))}
                    />
                  )}
                </section>

                <section className="insight-card">
                  <h3>{t('Providers')}</h3>
                  <p className="insight-sub">{t('Turns per provider')}</p>
                  {data.providers.length === 0 ? (
                    <p className="chart-empty">{t('No conversations stored yet.')}</p>
                  ) : (
                    <BarList
                      items={data.providers.map((p) => {
                        const provider = getProvider(p.provider);
                        return {
                          key: p.provider,
                          label: (
                            <span className="provider-label">
                              <span className="pdot" style={{ background: provider.color }} />
                              <span>{provider.short === '—' ? p.provider : provider.short}</span>
                            </span>
                          ),
                          value: p.turns,
                          detail: `${provider.label}: ${full(p.conversations)} conversations, ${full(p.turns)} turns`,
                        };
                      })}
                    />
                  )}
                </section>
              </div>

              <section className="insight-card">
                <h3>{t('Longest conversations')}</h3>
                <p className="insight-sub">
                  {t('Top ')}
                  {data.longestThreads.length}
                  {t(' by turn count')}
                </p>
                <div className="longest-list">
                  {data.longestThreads.map((thread, i) => {
                    const provider = getProvider(thread.provider);
                    return (
                      <button
                        key={`${thread.collection}:${thread.sourceFile}:${thread.conversationKey}:${i}`}
                        className="longest-row"
                        onClick={() => openThread(thread)}
                        title={thread.sourceFile}
                      >
                        <span className="rank">{i + 1}</span>
                        <span className="pdot" style={{ background: provider.color }} />
                        <span className="l-title">
                          {thread.title || shortPath(thread.sourceFile)}
                        </span>
                        <span className="l-meta">
                          {thread.turnCount}
                          {t(' turns')}
                          {thread.lastTurnAt
                            ? ` · ${fmtDate(thread.lastTurnAt).split(',')[0]}`
                            : ''}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
