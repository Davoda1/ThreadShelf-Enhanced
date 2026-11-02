import { useEffect, useSyncExternalStore } from 'react';
import { useMatches, useNavigate } from '@tanstack/react-router';
import { TtsController } from './tts-controller.js';
import { invokeTts, onTtsEvent } from './transport';
import { toast } from '../toast';
import { t } from '../i18n';
import { useUIStore } from '../store';
import type { TtsContext, TtsSettingsValue } from './types';

let revision = 0;
const listeners = new Set<() => void>();
const notify = () => {
  revision++;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => revision;
let context: TtsContext = { sourceId: '', private: false };
let navigateSettings = () => {};
export const controller = new TtsController({
  invoke: invokeTts,
  getContext: () => context,
  onTtsEvent,
  onSettings: () => navigateSettings(),
  onStateChange: notify,
  onError: (error) => toast.error(t(error instanceof Error ? error.message : String(error))),
});
let initialization: Promise<TtsSettingsValue> | undefined;
export function ensureTts(): Promise<TtsSettingsValue> {
  initialization ??= controller
    .init()
    .then((value) => {
      controller.setConfig(value);
      return value;
    })
    .catch((error) => {
      initialization = undefined;
      throw error;
    });
  return initialization;
}
export function useTts() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return controller;
}
export function setSpeechContext(value: TtsContext) {
  if (context.sourceId !== value.sourceId || context.private !== value.private)
    controller.stop(true);
  context = value;
}
export function speechSource(collection: string, sourceFile: string, conversationKey = ''): string {
  return JSON.stringify({
    serverUrl: location.origin + '/',
    collection,
    sourceFile,
    conversationKey,
  });
}
/** One app-owned player; source data stays in its existing React components. */
export function TtsRuntime() {
  const locale = useUIStore((state) => state.locale);
  useEffect(() => {
    controller.localize();
  }, [locale]);
  const matches = useMatches(),
    navigate = useNavigate();
  const path = matches[matches.length - 1]?.pathname ?? '';
  useEffect(() => {
    navigateSettings = () => {
      useUIStore.getState().setSettingsTab('tts');
      void navigate({ to: '/settings' });
    };
    const host = document.querySelector<HTMLElement>('.main');
    if (host) controller.attach(host);
    void ensureTts().catch(() => undefined);
    const focus = () => {
      void invokeTts('tts.settings.get')
        .then((value) => controller.setConfig(value as TtsSettingsValue))
        .catch(() => undefined);
    };
    window.addEventListener('focus', focus);
    return () => {
      window.removeEventListener('focus', focus);
      controller.detach();
    };
  }, [navigate]);
  useEffect(() => {
    controller.stop(true);
    if (path !== '/settings') controller.disposeTest();
  }, [path]);
  return null;
}

export function TtsScope({
  sourceId,
  private: privateChat = false,
}: {
  readonly sourceId: string;
  readonly private?: boolean;
}) {
  useEffect(() => {
    setSpeechContext({ sourceId, private: privateChat });
    return () => {
      if (context.sourceId === sourceId) controller.stop(true);
    };
  }, [sourceId, privateChat]);
  return null;
}
