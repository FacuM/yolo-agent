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

export interface FeatureSettings {
  chat: {
    enableSlashCommandAutocomplete: boolean;
    enableFileReferenceAutocomplete: boolean;
    enableCommandQueue: boolean;
    showContextTracker: boolean;
    activeFileByDefault: boolean;
    planningModeByDefault: boolean;
  };
  context: {
    includeSkills: boolean;
    includeAgentsMd: boolean;
    includeMemoryBank: boolean;
    compactionThresholdPercent: number;
  };
  agent: {
    maxToolIterations: number;
  };
}

const FEATURE_DEFAULTS: FeatureSettings = {
  chat: {
    enableSlashCommandAutocomplete: true,
    enableFileReferenceAutocomplete: true,
    enableCommandQueue: true,
    showContextTracker: true,
    activeFileByDefault: false,
    planningModeByDefault: false,
  },
  context: {
    includeSkills: true,
    includeAgentsMd: true,
    includeMemoryBank: true,
    compactionThresholdPercent: 80,
  },
  agent: {
    maxToolIterations: 25,
  },
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) { return fallback; }
  const rounded = Math.round(numeric);
  return Math.min(max, Math.max(min, rounded));
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function getConfig<T>(path: string, fallback: T): T {
  return vscode.workspace.getConfiguration().get<T>(path, fallback);
}

export function getFeatureSettings(): FeatureSettings {
  return {
    chat: {
      enableSlashCommandAutocomplete: asBoolean(
        getConfig('yoloAgent.chat.enableSlashCommandAutocomplete', FEATURE_DEFAULTS.chat.enableSlashCommandAutocomplete),
        FEATURE_DEFAULTS.chat.enableSlashCommandAutocomplete
      ),
      enableFileReferenceAutocomplete: asBoolean(
        getConfig('yoloAgent.chat.enableFileReferenceAutocomplete', FEATURE_DEFAULTS.chat.enableFileReferenceAutocomplete),
        FEATURE_DEFAULTS.chat.enableFileReferenceAutocomplete
      ),
      enableCommandQueue: asBoolean(
        getConfig('yoloAgent.chat.enableCommandQueue', FEATURE_DEFAULTS.chat.enableCommandQueue),
        FEATURE_DEFAULTS.chat.enableCommandQueue
      ),
      showContextTracker: asBoolean(
        getConfig('yoloAgent.chat.showContextTracker', FEATURE_DEFAULTS.chat.showContextTracker),
        FEATURE_DEFAULTS.chat.showContextTracker
      ),
      activeFileByDefault: asBoolean(
        getConfig('yoloAgent.chat.activeFileByDefault', FEATURE_DEFAULTS.chat.activeFileByDefault),
        FEATURE_DEFAULTS.chat.activeFileByDefault
      ),
      planningModeByDefault: asBoolean(
        getConfig('yoloAgent.chat.planningModeByDefault', FEATURE_DEFAULTS.chat.planningModeByDefault),
        FEATURE_DEFAULTS.chat.planningModeByDefault
      ),
    },
    context: {
      includeSkills: asBoolean(
        getConfig('yoloAgent.context.includeSkills', FEATURE_DEFAULTS.context.includeSkills),
        FEATURE_DEFAULTS.context.includeSkills
      ),
      includeAgentsMd: asBoolean(
        getConfig('yoloAgent.context.includeAgentsMd', FEATURE_DEFAULTS.context.includeAgentsMd),
        FEATURE_DEFAULTS.context.includeAgentsMd
      ),
      includeMemoryBank: asBoolean(
        getConfig('yoloAgent.context.includeMemoryBank', FEATURE_DEFAULTS.context.includeMemoryBank),
        FEATURE_DEFAULTS.context.includeMemoryBank
      ),
      compactionThresholdPercent: clampInt(
        getConfig('yoloAgent.context.compactionThresholdPercent', FEATURE_DEFAULTS.context.compactionThresholdPercent),
        FEATURE_DEFAULTS.context.compactionThresholdPercent,
        50,
        95
      ),
    },
    agent: {
      maxToolIterations: clampInt(
        getConfig('yoloAgent.agent.maxToolIterations', FEATURE_DEFAULTS.agent.maxToolIterations),
        FEATURE_DEFAULTS.agent.maxToolIterations,
        1,
        200
      ),
    },
  };
}

function buildSettingPath(key: string): { section: string; leaf: string } {
  const parts = key.split('.').filter(Boolean);
  if (parts.length < 2) {
    throw new Error(`Invalid setting key "${key}". Expected "<section>.<name>".`);
  }

  const section = `yoloAgent.${parts.slice(0, -1).join('.')}`;
  const leaf = parts[parts.length - 1];
  return { section, leaf };
}

function normalizeFeatureSettingValue(key: string, value: unknown): unknown {
  switch (key) {
    case 'chat.enableSlashCommandAutocomplete':
    case 'chat.enableFileReferenceAutocomplete':
    case 'chat.enableCommandQueue':
    case 'chat.showContextTracker':
    case 'chat.activeFileByDefault':
    case 'chat.planningModeByDefault':
    case 'context.includeSkills':
    case 'context.includeAgentsMd':
    case 'context.includeMemoryBank':
      return asBoolean(value, false);
    case 'context.compactionThresholdPercent':
      return clampInt(value, FEATURE_DEFAULTS.context.compactionThresholdPercent, 50, 95);
    case 'agent.maxToolIterations':
      return clampInt(value, FEATURE_DEFAULTS.agent.maxToolIterations, 1, 200);
    default:
      return value;
  }
}

/**
 * Update one configurable setting under the `yoloAgent.*` namespace.
 * The key should be relative to `yoloAgent`, for example:
 * - `chat.enableCommandQueue`
 * - `context.compactionThresholdPercent`
 */
export async function updateFeatureSetting(key: string, value: unknown): Promise<void> {
  const { section, leaf } = buildSettingPath(key);
  const normalized = normalizeFeatureSettingValue(key, value);
  const config = vscode.workspace.getConfiguration(section);
  await config.update(leaf, normalized, vscode.ConfigurationTarget.Global);
}
