import { useUIStore } from '../store';
import { t, useI18n } from '../i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useListboxPosition } from './useListboxPosition';

interface NumberComboboxProps {
  readonly id?: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly number[];
  readonly optionLabel?: (value: number) => string;
  readonly invalid?: boolean;
  readonly title?: string;
  readonly placeholder?: string;
}

/**
 * A token-count field that is both a dropdown and a free-text input: the
 * presets are one click away, but any whole number can still be typed. Used for
 * every token budget (context window, max answer) so they behave identically.
 */
export function NumberCombobox({
  id,
  label,
  value,
  onChange,
  options,
  optionLabel,
  invalid = false,
  title,
  placeholder,
}: NumberComboboxProps) {
  useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = `${useId()}-options`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const safeActiveIndex = Math.min(activeIndex, Math.max(options.length - 1, 0));
  const position = useListboxPosition(rootRef, open, 210);

  useEffect(() => {
    if (open)
      listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, safeActiveIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (
        !rootRef.current?.contains(event.target as Node) &&
        !listRef.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (option: number) => {
    onChange(String(option));
    setOpen(false);
  };

  return (
    <div className="number-combobox" ref={rootRef}>
      <input
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open ? `${listId}-${safeActiveIndex}` : undefined}
        aria-autocomplete="list"
        aria-invalid={invalid}
        autoComplete="off"
        inputMode="numeric"
        title={title}
        placeholder={placeholder}
        value={value}
        onChange={(event) => {
          // Digits only: the field feeds a token budget, never an expression.
          onChange(event.target.value.replace(/\D/g, ''));
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (
            !rootRef.current?.contains(event.relatedTarget) &&
            !listRef.current?.contains(event.relatedTarget)
          )
            setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            event.stopPropagation();
            if (!open) setOpen(true);
            else setActiveIndex(Math.min(safeActiveIndex + 1, options.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            event.stopPropagation();
            setActiveIndex(Math.max(safeActiveIndex - 1, 0));
          } else if (event.key === 'Enter' && open && options[safeActiveIndex] !== undefined) {
            event.preventDefault();
            event.stopPropagation();
            choose(options[safeActiveIndex]!);
          } else if (event.key === 'Escape') {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      <button
        type="button"
        className="number-combobox-toggle"
        tabIndex={-1}
        // Deliberately not derived from `label`: an accessible name containing
        // the field's own name makes every getByLabel(field) query ambiguous.
        aria-label={t('Show presets')}
        title={t('Show presets')}
        onClick={() => setOpen((current) => !current)}
      >
        ▾
      </button>
      {open &&
        options.length > 0 &&
        createPortal(
          <div
            className="number-combobox-popover"
            id={listId}
            role="listbox"
            aria-label={t('Token presets')}
            ref={listRef}
            style={position}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {options.map((option, index) => (
              <button
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={String(option) === value}
                data-active={index === safeActiveIndex}
                data-selected={String(option) === value}
                key={option}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option)}
              >
                {optionLabel
                  ? optionLabel(option)
                  : option.toLocaleString(useUIStore.getState().locale)}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
