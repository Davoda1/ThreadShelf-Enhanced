export type TtsProvider =
  'pocket' | 'kokoro' | 'selfhosted' | 'elevenlabs' | 'openrouter' | 'openai-realtime';
export interface TtsProfile {
  voice: string;
  model: string;
  endpoint: string;
  instructions: string;
  timeoutSeconds: number;
  responseFormat: string;
}
export interface TtsSettingsValue extends TtsProfile {
  schemaVersion?: number;
  allowNetworkPlayback?: boolean;
  access?: { canManage: boolean; networkPlaybackEnabled: boolean; requiresApiKey: boolean };
  enabled: boolean;
  includeThinking: boolean;
  showPillSettings: boolean;
  showPillSpeed: boolean;
  showPillVolume: boolean;
  streamingEnabled: boolean;
  volume: number;
  provider: TtsProvider;
  cacheEnabled: boolean;
  preferSavedApiAudio: boolean;
  cacheMaxBytes: number;
  cacheMaxAgeDays: number;
  sessionCacheMaxMiB: number;
  readCode: boolean;
  readCitations: boolean;
  playbackRate: number;
  providerProfiles: Record<TtsProvider, TtsProfile>;
  warning?: string;
  credentialStatus?: Partial<Record<TtsProvider, boolean>>;
}
export interface TtsContext {
  sourceId: string;
  private: boolean;
}
export interface SpeechRequest {
  text: string;
  messageFingerprint: { version: 1; sha256: string };
  sourceId: string;
  messageId: string;
  thinking?: boolean;
  label: string;
  private?: boolean;
}
export interface AssetsStatus {
  supported: boolean;
  platform: string;
  busy: boolean;
  engines: Record<'pocket' | 'kokoro', { installed: boolean; revision?: string; error?: string }>;
}
export interface AssetsPlan {
  fingerprint: string;
  requestedEngines?: ('pocket' | 'kokoro')[];
  engines: ('pocket' | 'kokoro')[];
  platform: string;
  downloadBytes: number;
  requiredFreeBytes: number;
  files: { name: string; bytes: number; cached?: boolean }[];
  licenses?: (string | { name?: string; license?: string })[];
}
export interface InstallProgress {
  state: string;
  downloadedBytes?: number;
  totalBytes?: number;
  file?: string;
}
