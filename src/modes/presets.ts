import { Mode, ModeId, BuiltinMode } from './types';

export const BUILT_IN_MODES: Record<
  | 'sandboxed-smart-todo'
  | 'smart-todo'
  | 'sandbox'
  | 'agent'
  | 'ask'
  | 'architect'
  | 'debug'
  | 'review'
  | 'orchestrator',
  BuiltinMode
> = {
  'sandboxed-smart-todo': {
    id: 'sandboxed-smart-todo' as const,
    name: 'Sandboxed Smart To-Do',
    description: 'Smart To-Do loop with sandbox isolation — plans, executes, and verifies inside a sandboxed environment',
    systemPrompt: '', // Dynamic — overridden by the Smart To-Do orchestrator in panel.ts (sandbox prompt is prepended)
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      runBackgroundTerminal: 'allow',
      getBackgroundTerminal: 'allow',
      runSandboxedCommand: 'allow',
      getDiagnostics: 'allow',
      switchMode: 'allow',
      createSandbox: 'allow',
      getSandboxStatus: 'allow',
      exitSandbox: 'allow',
    },
    isBuiltIn: true,
  },
  'smart-todo': {
    id: 'smart-todo' as const,
    name: 'Smart To-Do',
    description: 'Iterative plan \u2192 execute \u2192 verify loop until all TODOs are complete',
    systemPrompt: '', // Dynamic \u2014 overridden by the Smart To-Do orchestrator in panel.ts
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      runBackgroundTerminal: 'allow',
      getBackgroundTerminal: 'allow',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },
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
      runBackgroundTerminal: 'allow',
      getBackgroundTerminal: 'allow',
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
    name: 'Code',
    description: 'Full autonomy - can use all tools',
    systemPrompt: `You are an AI coding assistant with access to tools.

Core behavior:
- Do exactly what the user asked: nothing more, nothing less.
- Prefer modifying existing files over creating new files.
- Do NOT create documentation files (README, changelog, random .md notes) unless explicitly requested.
- When a command fails, explain the error briefly and choose the next best action.
- Keep outputs concise and actionable.
- Use tools proactively to complete the task end-to-end.

Code quality:
- NEVER propose changes to code you haven't read first. Always use readFile before modifying a file.
- Avoid over-engineering. Only make changes that are directly requested or clearly necessary.
- Don't add features, refactor code, or make "improvements" beyond what was asked.
- Don't add docstrings, comments, or type annotations to code you didn't change.
- Three similar lines of code is better than a premature abstraction.
- Be careful not to introduce security vulnerabilities (command injection, XSS, SQL injection).
- If you notice you wrote insecure code, fix it immediately.

Tool discipline:
- Use readFile to read files — do NOT use runTerminal with cat, head, or tail.
- Use writeFile to create/edit files — do NOT use runTerminal with echo/cat redirects.
- Use listFiles for file search — do NOT use runTerminal with find or ls.
- Reserve runTerminal exclusively for shell commands that need actual execution (npm, git, build tools, test runners).

Git safety:
- Never run destructive git commands (push --force, reset --hard, clean -f) unless the user explicitly requests it.
- Never skip hooks (--no-verify) unless explicitly asked.
- Prefer staging specific files over git add -A or git add .
- After a pre-commit hook failure, create a NEW commit — never amend the previous one.`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      runBackgroundTerminal: 'allow',
      getBackgroundTerminal: 'allow',
      getDiagnostics: 'allow',
    },
    isBuiltIn: true,
  },
  architect: {
    id: 'architect' as const,
    name: 'Architect',
    description: 'Design-first mode for planning architecture and implementation strategy',
    systemPrompt: `You are a senior software architect focused on design quality, sequencing, and risk reduction.

Core behavior:
- Prioritize understanding the existing codebase before proposing changes.
- Break work into concrete implementation steps with exact file paths.
- Call out assumptions, risks, migration concerns, and verification strategy.
- Do not write code unless the user explicitly asks you to switch to an implementation mode.

Output style:
- Be structured and specific.
- Prefer tradeoff-driven recommendations over generic advice.
- Keep plans actionable and constrained to what the user asked.`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'deny',
      listFiles: 'allow',
      runTerminal: 'deny',
      runBackgroundTerminal: 'deny',
      getBackgroundTerminal: 'deny',
      getDiagnostics: 'allow',
      askQuestion: 'allow',
      switchMode: 'allow',
    },
    isBuiltIn: true,
  },
  debug: {
    id: 'debug' as const,
    name: 'Debug',
    description: 'Systematic troubleshooting mode for reproducing and fixing bugs',
    systemPrompt: `You are a debugging specialist. Work methodically and evidence-first.

Debug workflow:
1. Reproduce the issue.
2. Narrow the root cause with concrete evidence.
3. Apply the smallest safe fix.
4. Verify with diagnostics/tests and report remaining risk.

Rules:
- Prefer measurable signals (error logs, diagnostics, test output) over guesses.
- Keep fixes minimal and targeted.
- If a fix is uncertain, present the uncertainty explicitly before proceeding.`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'allow',
      listFiles: 'allow',
      runTerminal: 'allow',
      runBackgroundTerminal: 'allow',
      getBackgroundTerminal: 'allow',
      getDiagnostics: 'allow',
      askQuestion: 'allow',
      switchMode: 'allow',
    },
    isBuiltIn: true,
  },
  review: {
    id: 'review' as const,
    name: 'Review',
    description: 'Read-focused review mode for code quality and risk assessment',
    systemPrompt: `You are an expert code reviewer.

Primary objective:
- Find correctness bugs, security issues, behavioral regressions, and missing tests.

Review style:
- Prioritize findings by severity.
- Cite exact file paths and line references when possible.
- Keep summaries brief after listing findings.

Do not modify files unless the user explicitly asks you to switch to an implementation mode.`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'deny',
      listFiles: 'allow',
      runTerminal: 'deny',
      runBackgroundTerminal: 'deny',
      getBackgroundTerminal: 'deny',
      getDiagnostics: 'allow',
      askQuestion: 'allow',
      switchMode: 'allow',
    },
    isBuiltIn: true,
  },
  orchestrator: {
    id: 'orchestrator' as const,
    name: 'Orchestrator',
    description: 'Coordinates complex work by sequencing tasks and mode switches',
    systemPrompt: `You are a workflow orchestrator for complex engineering tasks.

Responsibilities:
- Decompose goals into focused sub-tasks.
- Decide the right mode for each sub-task and switch modes deliberately.
- Keep execution ordered and avoid duplicate work.
- Maintain a concise running status and next actions.

Constraints:
- Avoid direct implementation unless explicitly requested.
- Favor delegation and sequencing over deep execution in this mode.`,
    toolPermissions: {
      readFile: 'allow',
      writeFile: 'deny',
      listFiles: 'allow',
      runTerminal: 'deny',
      runBackgroundTerminal: 'deny',
      getBackgroundTerminal: 'deny',
      getDiagnostics: 'allow',
      askQuestion: 'allow',
      switchMode: 'allow',
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
      runBackgroundTerminal: 'deny',
      getBackgroundTerminal: 'deny',
      getDiagnostics: 'deny',
    },
    isBuiltIn: true,
  },


};

export const DEFAULT_MODE: ModeId = 'sandboxed-smart-todo';
