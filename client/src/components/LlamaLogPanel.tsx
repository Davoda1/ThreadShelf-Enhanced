import { t, useI18n, formatNumber } from '../i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { GenerationModel, LlamaRuntimeDiagnostics } from '../types';
import { toast } from '../toast';
import { copyText } from '../utils';

interface LlamaLogPanelProps {
  readonly model?: GenerationModel;
  readonly active: boolean;
}

const gib = (bytes: number): string =>
  `${formatNumber(bytes / 1024 ** 3, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GiB`;

const placementLabel = (diagnostics: LlamaRuntimeDiagnostics): string => {
  const { offload } = diagnostics;
  if (offload.mode === 'cpu') return t('CPU only');
  if (offload.mode === 'gpu') return `GPU ${formatNumber(offload.gpuPercent ?? 100)}%`;
  if (offload.mode === 'hybrid') {
    return `GPU ${formatNumber(offload.gpuPercent ?? 0)}% · CPU ${formatNumber(offload.cpuPercent ?? 0)}%`;
  }
  if (diagnostics.devices.length > 0) return t('GPU available · placement pending');
  return t('Compute placement unknown');
};

export function LlamaLogPanel({ model, active }: LlamaLogPanelProps) {
  useI18n();
  const [diagnostics, setDiagnostics] = useState<LlamaRuntimeDiagnostics | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const refresh = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await api.generationLlamaLogs(controller.signal);
        if (!disposed) {
          setDiagnostics(next);
          setError('');
        }
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === 'AbortError') return;
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Could not read logs.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), active || open ? 1_000 : 8_000);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [active, open]);

  useEffect(() => {
    if (open && preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [diagnostics?.logs, open]);

  const freeVram = useMemo(
    () => diagnostics?.devices.reduce((total, device) => total + device.freeBytes, 0) ?? 0,
    [diagnostics?.devices],
  );
  const tooLargeForVram = Boolean(model?.sizeBytes && freeVram && model.sizeBytes > freeVram);

  return (
    <div className="llama-diagnostics" data-mode={diagnostics?.offload.mode ?? 'unknown'}>
      <div className="llama-placement">
        <div>
          <strong>
            {diagnostics ? placementLabel(diagnostics) : t('Inspecting CPU/GPU placement…')}
          </strong>
          {diagnostics?.offload.gpuLayers !== undefined && (
            <span>
              {formatNumber(diagnostics.offload.gpuLayers)}/
              {formatNumber(diagnostics.offload.totalLayers ?? 0)}
              {t(' model layers on GPU')}
            </span>
          )}
          {diagnostics?.devices.length ? (
            <span>
              {diagnostics.devices
                .map((device) =>
                  t('{device} · {size} free', {
                    device: `${device.id} ${device.name}`,
                    size: gib(device.freeBytes),
                  }),
                )
                .join(' · ')}
            </span>
          ) : diagnostics?.deviceDetectionSupported ? (
            <span>{t('No accelerator reported by this llama.cpp executable.')}</span>
          ) : (
            <span>{t('VRAM/device reporting is unavailable for this executable.')}</span>
          )}
        </div>
        {diagnostics?.offload.deviceBufferMiB && (
          <span className="llama-buffer-split">
            {Object.entries(diagnostics.offload.deviceBufferMiB)
              .map(
                ([device, mib]) =>
                  `${device}: ${formatNumber(mib, { maximumFractionDigits: 0 })} MiB`,
              )
              .join(' · ')}
          </span>
        )}
      </div>

      {tooLargeForVram && model?.sizeBytes && (
        <div className="llama-memory-warning">
          {t('Model file ')}
          {gib(model.sizeBytes)}
          {t(' exceeds currently reported free VRAM ')}
          {gib(freeVram)}
          {t(
            '. Full GPU placement is not possible; auto-fit should use a CPU/GPU mix. Context and compute buffers require additional memory.',
          )}
        </div>
      )}

      <details
        className="llama-log-details"
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          <span>{t('llama.cpp process logs')}</span>
          <span>
            {active
              ? t('live')
              : diagnostics?.source === 'managed'
                ? t('last process')
                : t('diagnostics')}
          </span>
        </summary>
        <div className="llama-log-toolbar">
          <span>
            {diagnostics?.logsTruncated
              ? t('Oldest output was truncated after 4 MiB.')
              : t(
                  'Complete stdout/stderr. Prompts, answers, and model reasoning are not written to process logs.',
                )}
          </span>
          <button
            className="btn sm"
            disabled={!diagnostics?.logs}
            onClick={() => {
              void copyText(diagnostics?.logs ?? '').then((ok) =>
                ok
                  ? toast.success(t('llama.cpp logs copied.'))
                  : toast.error(t('Could not copy logs.')),
              );
            }}
          >
            {t('Copy logs')}
          </button>
        </div>
        {error && <div className="banner err">{t(error)}</div>}
        <pre ref={preRef}>{diagnostics?.logs || 'No managed llama.cpp process logs yet.'}</pre>
      </details>
    </div>
  );
}
