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

export function getCompactionSettings(globalState: vscode.Memento): CompactionSettings {
  const stored = globalState.get<Partial<CompactionSettings>>(SETTINGS_KEY);
  return { ...DEFAULTS, ...stored };
}

export async function saveCompactionSettings(
  globalState: vscode.Memento,
  settings: Partial<CompactionSettings>
): Promise<void> {
  const current = getCompactionSettings(globalState);
  await globalState.update(SETTINGS_KEY, { ...current, ...settings });
}
