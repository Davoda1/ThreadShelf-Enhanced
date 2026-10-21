import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useListboxPosition } from './useListboxPosition';
import type { GenerationModel, GenerationProviderId } from '../types';
import { favoriteModelKey, useUIStore } from '../store';
import { compactModel, compactPath } from '../utils';

interface ModelComboboxProps {
  readonly provider: GenerationProviderId;
  readonly models: readonly GenerationModel[];
  readonly value: string;
  readonly onChange: (model: string) => void;
  readonly disabled?: boolean;
}

const compactModelMeta = (model: GenerationModel): string => {
  const parts: string[] = [];
  if (model.loaded) parts.push('loaded');
  if (model.sizeBytes) parts.push(`${(model.sizeBytes / 1024 ** 3).toFixed(1)} GB`);
  if (model.contextLength) parts.push(`${Math.round(model.contextLength / 1024)}k ctx`);
  if (
    model.id === 'openrouter/free' ||
    model.id.endsWith(':free') ||
    (Number(model.promptPrice) === 0 && Number(model.completionPrice) === 0)
  ) {
    parts.push('free');
  }
  if (model.createdAt) parts.push(new Date(model.createdAt).toLocaleDateString());
  return parts.join(' · ');
};

export function ModelCombobox({
  provider,
  models,
  value,
  onChange,
  disabled = false,
}: ModelComboboxProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-models`;
  const favoriteModels = useUIStore((state) => state.favoriteGenerationModels);
  const toggleFavorite = useUIStore((state) => state.toggleFavoriteGenerationModel);
  const [open, setOpen] = useState(false);
  const position = useListboxPosition(rootRef, open, 420);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = models.find((model) => model.id === value);
  const favoriteKeys = useMemo(
    () => new Set(favoriteModels.map((model) => favoriteModelKey(model))),
    [favoriteModels],
  );
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return models
      .filter(
        (model) =>
          !normalized ||
          model.name.toLowerCase().includes(normalized) ||
          model.id.toLowerCase().includes(normalized),
      )
      .sort((a, b) => {
        const aFavorite = favoriteKeys.has(favoriteModelKey(a));
        const bFavorite = favoriteKeys.has(favoriteModelKey(b));
        if (aFavorite !== bFavorite) return aFavorite ? -1 : 1;
        return 0;
      })
      .slice(0, 100);
  }, [models, query, favoriteKeys]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        !rootRef.current?.contains(event.target as Node) &&
        !listRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, []);

  const safeActiveIndex = Math.min(activeIndex, Math.max(visible.length - 1, 0));
  useEffect(() => {
    if (open)
      listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, safeActiveIndex]);

  const choose = (model: GenerationModel) => {
    onChange(model.id);
    setQuery('');
    setOpen(false);
  };

  return (
    <div className="model-combobox" ref={rootRef}>
      <div className="model-combobox-input">
        <input
          role="combobox"
          aria-label="Generation model"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && visible.length ? `${listId}-${safeActiveIndex}` : undefined
          }
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={open ? query : (selected?.name ?? '')}
          title={selected?.path || selected?.id}
          placeholder={disabled ? 'No models available' : 'Type to find a model…'}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onBlur={(event) => {
            if (
              !rootRef.current?.contains(event.relatedTarget) &&
              !listRef.current?.contains(event.relatedTarget)
            )
              setOpen(false);
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
              setActiveIndex(Math.min(safeActiveIndex + 1, visible.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              event.stopPropagation();
              setActiveIndex(Math.max(safeActiveIndex - 1, 0));
            } else if (event.key === 'Enter' && open && visible[safeActiveIndex]) {
              event.preventDefault();
              event.stopPropagation();
              choose(visible[safeActiveIndex]);
            } else if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
              setQuery('');
            }
          }}
        />
        <span className="model-combobox-chevron" aria-hidden="true">
          ⌄
        </span>
      </div>
      {open &&
        createPortal(
          <div
            id={listId}
            className="model-combobox-popover"
            role="listbox"
            aria-label="Available models"
            ref={listRef}
            style={position}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className="model-combobox-summary">
              <span>{visible.length === 100 ? '100+' : visible.length} matches</span>
              <span>favorites first</span>
            </div>
            {visible.length === 0 ? (
              <div className="model-combobox-empty">No matching models</div>
            ) : (
              visible.map((model, index) => {
                const favorite = favoriteKeys.has(favoriteModelKey(model));
                return (
                  <div
                    className="model-option"
                    id={`${listId}-${index}`}
                    data-active={index === safeActiveIndex}
                    data-selected={model.id === value}
                    role="option"
                    aria-selected={model.id === value}
                    key={model.id}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => choose(model)}
                  >
                    <button
                      type="button"
                      className="model-favorite"
                      data-favorite={favorite}
                      aria-label={`${favorite ? 'Remove' : 'Add'} ${model.name} ${favorite ? 'from' : 'to'} favorites`}
                      title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleFavorite({ provider, id: model.id, name: model.name });
                      }}
                    >
                      {favorite ? '★' : '☆'}
                    </button>
                    <span className="model-option-copy">
                      <strong title={model.name}>{compactModel(model.name, 38)}</strong>
                      <span title={model.path || model.id}>
                        {compactPath(model.path || model.id, 44)}
                      </span>
                    </span>
                    {compactModelMeta(model) && (
                      <span className="model-option-meta">{compactModelMeta(model)}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
