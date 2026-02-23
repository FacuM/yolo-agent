export type ModeId = 'agent' | 'ask' | 'plan' | 'custom';

export type ToolPermission = 'allow' | 'deny' | 'read-only';

export interface BaseMode {
  id: ModeId;
  name: string;
  description: string;
  systemPrompt: string;
  isBuiltIn: boolean;
}

export interface BuiltinMode extends BaseMode {
  id: 'agent' | 'ask' | 'plan';
  isBuiltIn: true;
  toolPermissions: Record<string, ToolPermission>;
}

export interface CustomMode extends BaseMode {
  id: 'custom';
  isBuiltIn: false;
  toolAllowList: string[];
  toolDenyList: string[];
}

export type Mode = BuiltinMode | CustomMode;
