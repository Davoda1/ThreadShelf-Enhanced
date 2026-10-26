import { t, useI18n, formatNumber } from '../i18n';
import { useMemo } from 'react';
import type { SearchResult } from '../types';
import { Icons } from '../icons';
import { getProvider } from '../constants';
import {
  collLabel,
  shortPath,
  fmtModel,
  fmtDateShort,
  queryHighlightRegex,
  splitHighlightedText,
} from '../utils';

interface ResultCardProps {
  readonly result: SearchResult;
  readonly query: string;
  readonly onClick: () => void;
  readonly selected?: boolean;
  readonly onMoreLikeThis?: () => void;
}

function highlightSnippet(text: string, query: string): React.ReactNode {
  const regex = queryHighlightRegex(query);
  if (!regex) return text;
  try {
    return splitHighlightedText(text, query).map((part, i) =>
      regex.test(part) ? <mark key={i}>{part}</mark> : part,
    );
  } catch {
    return text;
  }
}

export function ResultCard({ result, query, onClick, selected, onMoreLikeThis }: ResultCardProps) {
  useI18n();
  const { metadata } = result;
  const role = metadata.role ?? 'ai';
  const roleLabel = { user: 'user', thinking: 'reasoning', ai: 'response' }[role] ?? role;
  const provider = getProvider(metadata.provider);
  const model = fmtModel(metadata.model);
  const date = fmtDateShort(metadata.createdAt);
  const score =
    result.distance != null
      ? formatNumber(1 - result.distance, { minimumFractionDigits: 3, maximumFractionDigits: 3 })
      : '';
  const scorePct = result.distance != null ? Math.round((1 - result.distance) * 100) : 0;

  const snippet = useMemo(() => highlightSnippet(result.document, query), [result.document, query]);
  // A hit is only useful once you know which conversation it came from, so the
  // stored thread title leads the card and the file path drops to the footer.
  const title = metadata.title?.trim() || shortPath(metadata.sourceFile);

  return (
    <button className="result" data-selected={selected} aria-selected={selected} onClick={onClick}>
      <div className="result-head">
        <span className="r-role" data-role={role}>
          {t(roleLabel)}
        </span>
        <span className="r-provider">
          <span className="pdot" style={{ background: provider.color }} />
          <span>{provider.short}</span>
        </span>
        {metadata.createdInThreadShelf && (
          <span className="threadshelf-turn-badge">{t('ThreadShelf')}</span>
        )}
        {result.distance != null && (
          <div className="r-meta-right">
            <span className="r-score">
              <span className="r-score-bar">
                <i style={{ width: `${scorePct}%` }} />
              </span>
              <span>{score}</span>
            </span>
          </div>
        )}
      </div>

      <div className="r-title" title={title}>
        {title}
      </div>
      <div className="r-snippet">{snippet}</div>

      <div className="r-foot">
        <span className="r-source" title={metadata.sourceFile}>
          {Icons.folder}
          <span className="r-source-coll">{collLabel(metadata.collection ?? '')}</span>
          <span className="slash">/</span>
          <span className="r-source-file">{shortPath(metadata.sourceFile)}</span>
        </span>
        <span className="dot" />
        {model && (
          <>
            <span className="mono">{model}</span>
            <span className="dot" />
          </>
        )}
        {date && (
          <>
            <span>{date}</span>
            <span className="dot" />
          </>
        )}
        {metadata.turnIndex != null && (
          <>
            <span>
              {t('turn ')}
              <b className="mono">#{metadata.turnIndex}</b>
            </span>
            <span className="dot" />
          </>
        )}
        {onMoreLikeThis && (
          // The card itself is a <button>, so this affordance must not be one.
          <span
            className="more-like-this"
            role="button"
            tabIndex={0}
            title={t('Search for similar passages')}
            onClick={(e) => {
              e.stopPropagation();
              onMoreLikeThis();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                onMoreLikeThis();
              }
            }}
          >
            {t('more like this')}
          </span>
        )}
        <span className="open-thread">
          {t('open thread ')}
          {Icons.arrowRight}
        </span>
      </div>
    </button>
  );
}
