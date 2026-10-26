import { useUIStore } from '../store';
import { t, useI18n } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useMasterPromptMutation, useMasterPromptsQuery } from '../queries';
import { toast } from '../toast';

/**
 * Master prompt: the user's own system prompts, one of which is prepended to
 * every generation request. Saved on the local server, so they survive a
 * browser reset. Deliberately one chip wide — the composer already carries the
 * model menu.
 */
export function MasterPromptMenu() {
  useI18n();
  const { data } = useMasterPromptsQuery();
  const create = useMasterPromptMutation(api.createMasterPrompt);
  const update = useMasterPromptMutation((input: { id: string; name: string; text: string }) =>
    api.updateMasterPrompt(input.id, { name: input.name, text: input.text }),
  );
  const remove = useMasterPromptMutation(api.deleteMasterPrompt);
  const activate = useMasterPromptMutation(api.setActiveMasterPrompt);
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');

  const prompts = data?.prompts ?? [];
  const activeId = data?.activeId ?? '';
  const active = prompts.find((prompt) => prompt.id === activeId);
  const saving = create.isPending || update.isPending || remove.isPending || activate.isPending;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const placePopover = () => {
      const root = rootRef.current;
      const popover = root?.querySelector<HTMLElement>('.master-prompt-popover');
      if (!root || !popover) return;

      const trigger = root.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const topbarClearance = window.innerWidth <= 640 ? 60 : 56;
      const spaceAbove = trigger.top - (viewportTop + topbarClearance) - 8;
      const spaceBelow = viewportTop + viewportHeight - trigger.bottom - 20;
      const placement = spaceBelow > spaceAbove ? 'down' : 'up';
      const availableHeight = Math.max(
        96,
        Math.floor(placement === 'down' ? spaceBelow : spaceAbove),
      );
      const safeLeft = viewportLeft + 12;
      const safeRight = viewportLeft + viewportWidth - 12;
      const clampedLeft = Math.min(
        Math.max(trigger.left, safeLeft),
        Math.max(safeLeft, safeRight - popover.offsetWidth),
      );

      root.dataset.popoverPlacement = placement;
      root.style.setProperty('--master-popover-available-height', `${availableHeight}px`);
      root.style.setProperty('--master-popover-shift-x', `${clampedLeft - trigger.left}px`);
    };

    placePopover();
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', placePopover);
    window.addEventListener('scroll', placePopover, true);
    window.visualViewport?.addEventListener('resize', placePopover);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', placePopover);
      window.removeEventListener('scroll', placePopover, true);
      window.visualViewport?.removeEventListener('resize', placePopover);
    };
  }, [open]);

  const edit = (id: string) => {
    const prompt = prompts.find((candidate) => candidate.id === id);
    setEditingId(prompt ? id : '');
    setName(prompt?.name ?? '');
    setText(prompt?.text ?? '');
  };

  const failed = (cause: unknown, fallback: string) =>
    toast.error(cause instanceof Error ? cause.message : fallback);

  const save = () => {
    const body = text.trim();
    if (!body) {
      toast.error(t('A master prompt cannot be empty.'));
      return;
    }
    const done = () => {
      setOpen(false);
      toast.success(t('Master prompt saved and active for every new message.'));
    };
    if (editingId) {
      update.mutate(
        { id: editingId, name: name.trim(), text: body },
        { onSuccess: done, onError: (cause) => failed(cause, 'Could not save the master prompt.') },
      );
    } else {
      create.mutate(
        { name: name.trim(), text: body },
        { onSuccess: done, onError: (cause) => failed(cause, 'Could not save the master prompt.') },
      );
    }
  };

  return (
    <div className="master-prompt" ref={rootRef}>
      <button
        type="button"
        id="masterPromptButton"
        className="master-prompt-chip"
        data-active={Boolean(active)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          active
            ? t('Master prompt: {value0}', { value0: active.name })
            : t('No master prompt — click to add one')
        }
        onClick={() => {
          if (!open) edit(activeId);
          setOpen((current) => !current);
        }}
      >
        {active ? active.name : t('System')}
      </button>

      {open && (
        <div className="master-prompt-popover" role="dialog" aria-label={t('Master prompt')}>
          <div className="master-prompt-tabs">
            <button
              type="button"
              data-active={!activeId}
              title={t('Send no master prompt')}
              disabled={saving}
              onClick={() =>
                activate.mutate('', {
                  onError: (cause) => failed(cause, 'Could not turn the master prompt off.'),
                })
              }
            >
              {t('Off')}
            </button>
            {prompts.map((prompt) => (
              <button
                type="button"
                key={prompt.id}
                data-active={prompt.id === activeId}
                title={prompt.text}
                disabled={saving}
                onClick={() => {
                  edit(prompt.id);
                  activate.mutate(prompt.id, {
                    onError: (cause) => failed(cause, 'Could not switch the master prompt.'),
                  });
                }}
              >
                {prompt.name}
              </button>
            ))}
            <button
              type="button"
              className="master-prompt-new"
              title={t('New master prompt')}
              aria-label={t('New master prompt')}
              onClick={() => edit('')}
            >
              +
            </button>
          </div>

          <input
            className="master-prompt-name"
            aria-label={t('Master prompt name')}
            placeholder={t('Name (optional)')}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
          <textarea
            id="masterPromptText"
            aria-label={t('Master prompt text')}
            placeholder={t('Sent as a system message with every request…')}
            rows={5}
            maxLength={20000}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <div className="master-prompt-foot">
            <span>
              {text.trim().length.toLocaleString(useUIStore.getState().locale)}
              {t(' chars · saved locally')}
            </span>
            {editingId && (
              <button
                type="button"
                className="btn sm ghost"
                disabled={saving}
                onClick={() =>
                  remove.mutate(editingId, {
                    onSuccess: () => edit(''),
                    onError: (cause) => failed(cause, 'Could not delete the master prompt.'),
                  })
                }
              >
                {t('Delete')}
              </button>
            )}
            <button type="button" className="btn sm primary" disabled={saving} onClick={save}>
              {editingId ? t('Save') : t('Add')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
