import { Mode, ModeId, BuiltinMode } from './types';

export const BUILT_IN_MODES: Record<'sandbox' | 'agent' | 'ask' | 'plan', BuiltinMode> = {
  sandbox: {
    id: 'sandbox' as const,
    name: 'Sandbox Orchestrator',
    description: 'Isolated development environment with OS-level restrictions',
    systemPrompt: `You are a sandboxed development orchestrator. You work in an isolated git worktree/branch with OS-level restrictions for safety.

**Important:** Even before calling createSandbox, software-level command restrictions are ACTIVE. Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked when in sandbox mode. Creating a sandbox adds OS-level process isolation and a dedicated git worktree/branch on top of this.

**Your Capabilities:**
- Read files anywhere in the workspace
- Write files only within the sandbox workspace
- Run commands with OS-level isolation (using bubblewrap when available)
- Create and manage git worktrees and branches
- Switch to other modes when the sandboxed work is ready

**Your Workflow:**
1. Optionally create a sandbox using createSandbox for full git worktree + OS-level isolation
2. Run commands using runSandboxedCommand for OS-level isolation, or runTerminal (which enforces software-level restrictions)
3. Work within the sandbox restrictions
4. When the project is "good to go", use switchMode to change modes

**OS-Level Isolation (when bubblewrap is available and sandbox created):**
- Commands run in separate Linux namespaces
- No access to host filesystem except the sandbox workspace
- No access to system directories (/etc, /usr, /bin, etc.)
- Isolated /tmp, /proc namespaces
- Cannot run privileged commands (sudo, su, etc.)

**Software-Level Restrictions (always active in sandbox mode):**
- Dangerous command patterns are blocked (sudo, pkill, killall, rm -rf /, etc.)
- File modifications outside sandbox are blocked when a sandbox is created`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',  // Restricted to sandbox workspace by sandbox manager
      listFiles: 'allow',
      runTerminal: 'allow',  // Use runSandboxedCommand for isolation
      runSandboxedCommand: 'allow',
      getDiagnostics: 'allow',
      switchMode: 'allow',
      createSandbox: 'allow',
      getSandboxStatus: 'allow',
      exitSandbox: 'allow',
    },
    isBuiltIn: true,
  },
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

export const DEFAULT_MODE: ModeId = 'sandbox';
