import type { TtsSettingsValue, TtsContext, SpeechRequest, AssetsStatus } from './types';
export class TtsController {
  constructor(options: {
    invoke: (action: string, args?: Record<string, unknown>) => Promise<unknown>;
    getContext: () => TtsContext;
    onSettings: () => void;
    onTtsEvent: (listener: (event: unknown) => void) => () => void;
    onError: (error: unknown) => void;
    onStateChange: () => void;
  });
  config: TtsSettingsValue;
  active: null | {
    sourceId: string;
    messageId: string;
    receiving: boolean;
    complete: boolean;
    error: string;
    private?: boolean;
    cacheKey?: string;
    player: { snapshot: () => { playing: boolean; paused: boolean; buffering: boolean } };
  };
  host: HTMLElement | null;
  formRoot: HTMLElement | null;
  localize(): void;
  init(): Promise<TtsSettingsValue>;
  attach(host: HTMLElement): void;
  detach(): void;
  setConfig(config: TtsSettingsValue): void;
  syncMessages(): void;
  start(request: SpeechRequest): Promise<void>;
  stop(hide?: boolean): void;
  disposeTest(): void;
  setLocalAssets(status: AssetsStatus | null, failed?: boolean): void;
  settingsHTML(): string;
  bindSettings(root: HTMLElement): void;
  cancelSettings(): void;
  saveSettings(): Promise<TtsSettingsValue | undefined>;
  formStatus(message: string, error?: boolean): void;
}
