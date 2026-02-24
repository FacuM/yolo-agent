import * as vscode from 'vscode';

export type CompactionMethod = 'semi-automatic' | 'automatic' | 'manual';

export interface CompactionSettings {
  method: CompactionMethod;
  timeoutSeconds: number;
}

const DEFAULTS: CompactionSettings = {
  method: 'semi-automatic',
  timeoutSeconds: 60,
};

const SETTINGS_KEY = 'yoloAgent.compactionSettings';

function normalizeMethod(method: unknown): CompactionMethod {
  return method === 'automatic' || method === 'manual' || method === 'semi-automatic'
    ? method
    : DEFAULTS.method;
}

function normalizeTimeout(timeout: unknown): number {
  const numeric = typeof timeout === 'number' ? timeout : Number(timeout);
  if (!Number.isFinite(numeric)) { return DEFAULTS.timeoutSeconds; }
  const rounded = Math.round(numeric);
  return Math.min(300, Math.max(10, rounded));
}

function normalizeSettings(settings: Partial<CompactionSettings> | undefined): CompactionSettings {
  return {
    method: normalizeMethod(settings?.method),
    timeoutSeconds: normalizeTimeout(settings?.timeoutSeconds),
  };
}

export function getCompactionSettings(globalState: vscode.Memento): CompactionSettings {
  const stored = globalState.get<Partial<CompactionSettings>>(SETTINGS_KEY);
  return normalizeSettings(stored);
}

export async function saveCompactionSettings(
  globalState: vscode.Memento,
  settings: Partial<CompactionSettings>
): Promise<void> {
  const current = getCompactionSettings(globalState);
  await globalState.update(SETTINGS_KEY, normalizeSettings({ ...current, ...settings }));
}
