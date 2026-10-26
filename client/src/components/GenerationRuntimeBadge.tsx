import { t, useI18n, formatNumber } from '../i18n';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { GenerationRuntimeStatus, LlamaRuntimeDiagnostics } from '../types';
import { toast } from '../toast';

const shortModel = (value?: string): string => {
  if (!value) return '';
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] || value;
};

export function GenerationRuntimeBadge({ detailed = false }: { readonly detailed?: boolean }) {
  useI18n();
  const [runtime, setRuntime] = useState<GenerationRuntimeStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<LlamaRuntimeDiagnostics | null>(null);
  const [ejecting, setEjecting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [response, diagnosticResult] = await Promise.all([
        api.generationRuntime(),
        api.generationLlamaLogs().catch(() => null),
      ]);
      setRuntime(response.runtime);
      if (diagnosticResult) setDiagnostics(diagnosticResult);
    } catch {
      setRuntime(null);
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 3000);
    const onRuntimeChanged = (event: Event) => {
      if (event instanceof CustomEvent && event.detail) {
        setRuntime(event.detail as GenerationRuntimeStatus);
        void api
          .generationLlamaLogs()
          .then(setDiagnostics)
          .catch(() => undefined);
        return;
      }
      void refresh();
    };
    window.addEventListener('threadshelf:generation-runtime-changed', onRuntimeChanged);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('threadshelf:generation-runtime-changed', onRuntimeChanged);
    };
  }, [refresh]);

  const eject = async () => {
    setEjecting(true);
    try {
      const response = await api.ejectGenerationModel(runtime?.model);
      setRuntime(response.runtime);
      window.dispatchEvent(new Event('threadshelf:generation-runtime-changed'));
      toast.success(t('llama.cpp model ejected from memory.'));
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : t('Could not eject the model.'));
    } finally {
      setEjecting(false);
    }
  };

  const active =
    runtime &&
    (runtime.state === 'starting' ||
      runtime.state === 'ready' ||
      (runtime.state === 'external' && Boolean(runtime.model)));
  const deviceBackend = diagnostics?.devices[0]?.id.replace(/\d+$/, '').toUpperCase();
  const compute = (() => {
    if (!runtime || !diagnostics) return t('unknown');
    if (runtime.state === 'stopped') {
      return diagnostics.devices.length > 0
        ? t('idle · GPU ({device})', { device: deviceBackend || t('accelerator') })
        : t('idle · CPU');
    }
    if (diagnostics.offload.mode === 'hybrid') {
      return t('hybrid {percent}% GPU', {
        percent: formatNumber(diagnostics.offload.gpuPercent ?? 0),
      });
    }
    if (diagnostics.offload.mode === 'gpu') return `GPU · ${deviceBackend || t('accelerator')}`;
    if (diagnostics.offload.mode === 'cpu') return 'CPU';
    if (diagnostics.devices.length > 0) return `GPU · ${deviceBackend || t('accelerator')}`;
    return diagnostics.deviceDetectionSupported ? 'CPU' : t('unknown');
  })();
  const installTooltip = [
    diagnostics?.executable
      ? t('Selected executable: {path}', { path: diagnostics.executable })
      : undefined,
    t('Detected compute: {compute}', { compute }),
    '',
    t('Check for a newer stable llama.cpp build:'),
    'npm run setup:llama -- -- --check',
    '',
    t('Install CPU:'),
    'npm run setup:llama -- -- --install --variant cpu',
    '',
    t('Install NVIDIA CUDA:'),
    'npm run setup:llama -- -- --install --variant cuda',
    '',
    t('Install Vulkan GPU:'),
    'npm run setup:llama -- -- --install --variant vulkan',
    '',
    t('macOS: use the cpu variant; Metal is included automatically.'),
  ]
    .filter((line): line is string => line !== undefined)
    .join('\n');
  // Status line such as "GPU · CUDA · ctx 64K · FA on · KV q8_0×q8_0 · MTP 2 · GPU weights 15.8 GiB".
  const gpuWeightsMiB = Object.entries(diagnostics?.offload.deviceBufferMiB ?? {})
    .filter(([device]) => !device.toUpperCase().startsWith('CPU'))
    .reduce((sum, [, sizeMiB]) => sum + sizeMiB, 0);
  const appliedProfile = (diagnostics?.profile ?? []).filter((entry) => entry.applied);
  const runtimeProfile =
    appliedProfile.length > 0 && runtime?.state !== 'stopped'
      ? [
          compute,
          ...appliedProfile.map((entry) => `${entry.setting} ${entry.value}`),
          gpuWeightsMiB > 0
            ? t('GPU weights {size} GiB', {
                size: formatNumber(gpuWeightsMiB / 1024, {
                  maximumFractionDigits: 1,
                  minimumFractionDigits: 1,
                }),
              })
            : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  const runtimeProfileNotes = (diagnostics?.profile ?? [])
    .filter((entry) => entry.note)
    .map((entry) => `${entry.setting}: ${entry.applied ? '' : t('skipped, ')}${entry.note}`)
    .join('\n');
  return (
    <div
      className="global-runtime"
      data-state={runtime?.state || 'unknown'}
      title={runtime?.detail}
    >
      <span className="runtime-dot" aria-hidden="true" />
      <span className="global-runtime-copy">
        <b>
          <span>{runtime?.state === 'starting' ? t('llama.cpp · loading') : t('llama.cpp')}</span>
          <em>{compute}</em>
          <span
            className="runtime-install-help"
            tabIndex={0}
            role="img"
            aria-label={t('llama.cpp CPU and GPU install commands')}
            title={installTooltip}
          >
            ?
          </span>
        </b>
        <span>
          {runtime?.model
            ? shortModel(runtime.model)
            : runtime
              ? t('no model loaded')
              : t('status unavailable')}
        </span>
        {detailed && runtime?.detail && <small>{runtime.detail}</small>}
        {detailed && runtimeProfile && (
          <small className="runtime-profile" title={runtimeProfileNotes || undefined}>
            {runtimeProfile}
          </small>
        )}
      </span>
      {active && (
        <button type="button" disabled={ejecting} onClick={() => void eject()}>
          {ejecting ? '…' : t('Eject')}
        </button>
      )}
    </div>
  );
}
