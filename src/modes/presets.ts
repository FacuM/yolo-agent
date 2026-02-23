import { Mode, ModeId, BuiltinMode } from './types';

export const BUILT_IN_MODES: Record<'agent' | 'ask' | 'plan', BuiltinMode> = {
  agent: {
    id: 'agent' as const,
    name: 'Agent',
    description: 'Full autonomy - can use all tools',
    systemPrompt: 'You are an AI coding assistant with access to tools. Use tools when helpful to complete the user\'s request.',
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },

  ask: {
    id: 'ask' as const,
    name: 'Ask',
    description: 'Chat only - no tool execution',
    systemPrompt: 'You are a helpful AI assistant. Answer questions based on your knowledge. Do not attempt to use tools.',
    toolPermissions: {
      readFile: 'deny',
      writeFile: 'deny',
      listFiles: 'deny',
      runTerminal: 'deny',
      getDiagnostics: 'deny',
    },
    isBuiltIn: true,
  },

  plan: {
    id: 'plan' as const,
    name: 'Plan',
    description: 'Read-only access - can view but not modify',
    systemPrompt: 'You are a planning assistant. You can read files and explore the codebase, but cannot make changes. Help the user plan their work.',
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'deny',
      listFiles: 'allow',
      runTerminal: 'deny',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },
};

export const DEFAULT_MODE: ModeId = 'agent';
