import { t, useI18n } from '../i18n';
import { Icons } from '../icons';
import { EXAMPLE_QUERIES } from '../constants';

interface EmptyProps {
  readonly onPick: (query: string) => void;
}

export function Empty({ onPick }: EmptyProps) {
  useI18n();
  return (
    <div className="empty">
      <h3>{t('Ask your archive in plain language.')}</h3>
      <p>
        {t(
          "ThreadShelf runs locally — your queries embed on this machine and search a local LanceDB. Try a topic, a draft you half-remember, or the shape of an answer you're looking for.",
        )}
      </p>
      <div className="examples">
        {EXAMPLE_QUERIES.map((q) => (
          <button key={q} className="example-chip" onClick={() => onPick(q)}>
            {Icons.spark}
            <span>{q}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
