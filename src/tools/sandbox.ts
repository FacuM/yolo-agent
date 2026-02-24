import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';
import { SandboxManager, ModeSwitchPlanner } from '../sandbox/manager';
import { ModeManager } from '../modes/manager';

/**
 * Tool for creating a sandbox environment
 */
export class CreateSandboxTool implements Tool {
  definition = {
    name: 'createSandbox',
    description: `Create a new isolated sandbox environment with a git worktree and branch.

Use this tool when you need to:
- Start working on a new feature in isolation
- Create a safe environment to test changes
- Work on a bugfix without affecting the main branch

The sandbox will:
- Create a new git worktree in a separate directory
- Create a new branch for the feature
- Use OS-level isolation (bubblewrap) if available
- Restrict file modifications outside the sandbox workspace

If bubblewrap is available, the sandbox runs with OS-level isolation using Linux namespaces.
Otherwise, software-level restrictions are applied.`,
    parameters: {
      type: 'object',
      properties: {
        featureName: {
          type: 'string',
          description: 'Optional name for the feature/branch (e.g., "fix-auth-bug")',
        },
      },
    },
  };

  constructor(private sandboxManager: SandboxManager) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const featureName = params.featureName as string | undefined;

    try {
      const config = await this.sandboxManager.createSandbox(featureName);
      const osLevelAvailable = await SandboxManager.isOsLevelSandboxAvailable();
      return {
        content: `Sandbox created successfully!
- Branch: ${config.branchName}
- Worktree path: ${config.worktreePath}
- Original workspace: ${config.originalPath}
- OS-level isolation: ${osLevelAvailable ? '✓ Enabled (bubblewrap)' : '✗ Not available, using software-level restrictions'}

You can now work in the isolated environment. When done, use switchMode tool to change modes.`,
      };
    } catch (err) {
      return {
        content: `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

/**
 * Tool for switching modes with user approval
 */
export class SwitchModeTool implements Tool {
  definition = {
    name: 'switchMode',
    description: `Switch to a different operational mode.

This tool will:
1. Create a detailed plan of what will happen
2. Show the plan to the user for approval
3. Wait for user confirmation before proceeding

Available modes:
- sandbox: Isolated orchestrator with OS-level restrictions (default)
- agent: Full autonomy with all tools
- ask: Chat only, no tool execution
Use this when:
- Sandbox work is complete and you need full agent capabilities
- You want to switch from planning to execution
- You need to change your operational constraints`,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['sandbox', 'agent', 'ask'],
          description: 'The mode to switch to',
        },
        reason: {
          type: 'string',
          description: 'Reason for the mode switch (shown in the plan)',
        },
        intendedActions: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of actions you plan to take after the mode switch',
        },
      },
      required: ['mode'],
    },
  };

  constructor(
    private modeManager: ModeManager,
    private sandboxManager?: SandboxManager
  ) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const targetMode = params.mode as string;
    const reason = params.reason as string | undefined;
    const intendedActions = (params.intendedActions as string[]) || [];

    // Validate mode
    const validModes = ['sandbox', 'agent', 'ask'];
    if (!validModes.includes(targetMode)) {
      return {
        content: `Invalid mode: ${targetMode}. Valid modes are: ${validModes.join(', ')}`,
        isError: true,
      };
    }

    const currentMode = this.modeManager.getCurrentMode();

    // Check if sandbox exists
    let exitSandbox = false;
    let keepSandbox = true;

    if (currentMode.id === 'sandbox' && targetMode !== 'sandbox' && this.sandboxManager) {
      const sandboxInfo = this.sandboxManager.getSandboxInfo();
      if (sandboxInfo.isActive) {
        exitSandbox = true;
        // Ask about sandbox handling
        const sandboxChoice = await vscode.window.showQuickPick(
          [
            { label: 'Keep sandbox (switch mode, sandbox stays active)', value: 'keep', detail: 'The sandbox branch and worktree will be preserved' },
            { label: 'Exit sandbox (clean up before switching)', value: 'exit', detail: 'You will be prompted about keeping/deleting the branch' },
            { label: 'Cancel', value: 'cancel', detail: 'Cancel the mode switch' },
          ],
          {
            placeHolder: 'You are in an active sandbox. What would you like to do?',
          }
        );

        if (sandboxChoice?.value === 'exit') {
          keepSandbox = false;
        } else if (sandboxChoice?.value === 'cancel') {
          return {
            content: 'Mode switch cancelled by user.',
          };
        }
      }
    }

    // Create the switch plan
    const plan = await ModeSwitchPlanner.createPlan(
      currentMode.id,
      targetMode,
      reason,
      this.sandboxManager!
    );

    // Add custom intended actions if provided
    if (intendedActions.length > 0) {
      plan.intendedActions.push(...intendedActions);
    }

    // Add sandbox exit action if applicable
    if (exitSandbox && !keepSandbox) {
      plan.intendedActions.push('⚠️ Exit and cleanup the sandbox');
    } else if (exitSandbox && keepSandbox) {
      plan.intendedActions.push('ℹ️ Sandbox will remain active (you can exit it later)');
    }

    // Show plan and get approval
    const approved = await ModeSwitchPlanner.showPlan(plan);

    if (!approved) {
      return {
        content: `Mode switch cancelled by user. Remaining in ${currentMode.id} mode.`,
      };
    }

    // Execute the switch
    try {
      // Exit sandbox if requested
      if (exitSandbox && !keepSandbox && this.sandboxManager) {
        try {
          await this.sandboxManager.exitSandbox();
        } catch (err) {
          return {
            content: `Failed to exit sandbox: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }

      // Switch mode
      await this.modeManager.setCurrentMode(targetMode as any);

      const reasonText = reason ? `\nReason: ${reason}` : '';
      return {
        content: `✓ Switched to ${targetMode} mode.${reasonText}

You now have:
${targetMode === 'agent' ? '- Full autonomy with all tools\n- Unrestricted command execution' : ''}
${targetMode === 'ask' ? '- Chat-only interface\n- No tool execution' : ''}
${targetMode === 'sandbox' ? '- OS-level sandbox isolation (if available)\n- Restricted command execution\n- File modification only within sandbox' : ''}`,
      };
    } catch (err) {
      return {
        content: `Failed to switch mode: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

/**
 * Tool for getting current sandbox status
 */
export class GetSandboxStatusTool implements Tool {
  definition = {
    name: 'getSandboxStatus',
    description: 'Get information about the current sandbox environment.',
    parameters: {
      type: 'object',
      properties: {},
    },
  };

  constructor(private sandboxManager: SandboxManager) {}

  async execute(): Promise<ToolResult> {
    const info = this.sandboxManager.getSandboxInfo();

    if (!info.isActive) {
      return {
        content: `Sandbox Environment: Not created
- Software-level command restrictions: ✓ Active (dangerous commands like sudo, pkill, killall, rm -rf /, etc. are blocked)
- OS-level isolation: ✗ Not active (use createSandbox to enable)
- Git worktree isolation: ✗ Not active (use createSandbox to enable)

Note: Even without a full sandbox environment, dangerous commands are blocked when in sandbox mode. Use createSandbox to additionally get OS-level process isolation and a dedicated git worktree/branch.`,
      };
    }

    return {
      content: `Sandbox Environment: Active
- OS-level isolation: ${info.osLevelIsolation ? '✓ Yes (bubblewrap)' : '✗ No (software-level only)'}
- Software-level command restrictions: ✓ Active
- Branch: ${info.config?.branchName}
- Worktree Path: ${info.config?.worktreePath}
- Original Path: ${info.config?.originalPath}`,
    };
  }
}

/**
 * Tool for exiting the sandbox
 */
export class ExitSandboxTool implements Tool {
  definition = {
    name: 'exitSandbox',
    description: `Exit the current sandbox environment.

Options:
- keepChanges: true to keep the branch, false to delete it
- If not specified, the user will be prompted`,
    parameters: {
      type: 'object',
      properties: {
        keepChanges: {
          type: 'boolean',
          description: 'Whether to keep the branch (true) or delete it (false)',
        },
      },
    },
  };

  constructor(private sandboxManager: SandboxManager) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const keepChanges = params.keepChanges as boolean | undefined;

    try {
      await this.sandboxManager.exitSandbox(keepChanges);
      return {
        content: 'Sandbox exited successfully.',
      };
    } catch (err) {
      return {
        content: `Failed to exit sandbox: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

/**
 * Tool for running commands with OS-level sandbox isolation
 */
export class RunSandboxedCommandTool implements Tool {
  definition = {
    name: 'runSandboxedCommand',
    description: `Execute a shell command with OS-level sandbox isolation.

This tool runs commands within bubblewrap (bwrap) for OS-level isolation when a sandbox is active.
The command will have:
- No access to the host filesystem except the sandbox workspace
- No access to system directories (/etc, /usr, etc.)
- Isolated /tmp, /proc namespaces
- No ability to run privileged commands

If no sandbox is active, this tool falls back to software-level restriction checks.

Use this for:
- Running build commands (npm, make, etc.)
- Executing tests
- Installing dependencies within the sandbox`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory (relative to workspace root)',
        },
      },
      required: ['command'],
    },
  };

  constructor(private sandboxManager: SandboxManager) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const cwd = params.cwd as string | undefined;

    const info = this.sandboxManager.getSandboxInfo();

    if (!info.isActive) {
      return {
        content: `No sandbox is currently active. Use createSandbox first, or use runTerminal for unrestricted execution.`,
        isError: true,
      };
    }

    try {
      const result = await this.sandboxManager.executeCommand(
        command,
        cwd
      );

      let output = result.stdout;
      if (result.stderr) {
        output += output ? '\n' + result.stderr : result.stderr;
      }

      const exitInfo = result.exitCode !== 0
        ? `\nExit code: ${result.exitCode}`
        : '';

      return {
        content: output + exitInfo || 'Command completed',
        isError: result.exitCode !== 0,
      };
    } catch (err) {
      return {
        content: `Failed to run command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
