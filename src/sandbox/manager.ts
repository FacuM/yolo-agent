import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { createInterface } from 'readline';
import { spawn } from 'child_process';

const execAsync = promisify(exec);

export interface SandboxConfig {
  worktreePath: string;
  branchName: string;
  originalPath: string;
  sandboxRoot?: string;  // OS-level sandbox root
}

export interface SandboxInfo {
  isActive: boolean;
  config?: SandboxConfig;
  osLevelIsolation: boolean;
}

export interface ModeSwitchPlan {
  fromMode: string;
  toMode: string;
  reason?: string;
  intendedActions: string[];
  sandboxStatus?: {
    active: boolean;
    branchName?: string;
    uncommittedChanges: boolean;
  };
}

/**
 * Validates command execution against OS-level sandbox constraints
 */
class SandboxCommandValidator {
  /**
   * Build a bubblewrap command that wraps the given command with OS-level isolation
   */
  static buildBwrapWrap(
    command: string,
    sandboxRoot: string,
    workspacePath: string
  ): { wrappedCommand: string; args: string[] } {
    // bubblewrap arguments for a secure sandbox
    const bwrapArgs = [
      // Create new namespace (unprivileged)
      '--unshare-all',
      '--share-net',  // Keep network for npm/pip installs

      // Mount a new proc filesystem
      '--proc', '/proc',

      // Bind mount the sandbox workspace (read-write)
      '--bind', `${sandboxRoot}`, '/',
      // But keep /tmp as tmpfs (don't leak host temp)
      '--dev', '/dev',
      '--tmpfs', '/tmp',

      // Read-only bind mounts for system directories (from sandbox root, not host)
      '--ro-bind', `${sandboxRoot}/usr`, '/usr',
      '--ro-bind', `${sandboxRoot}/lib`, '/lib',
      '--ro-bind', `${sandboxRoot}/lib64`, '/lib64',
      '--ro-bind-try', `${sandboxRoot}/lib/x86_64-linux-gnu`, '/lib/x86_64-linux-gnu',

      // Read-only access to workspace
      '--ro-bind', workspacePath, '/workspace',

      // No access to host home, etc, ssh keys
      '--dir', '/home/sandbox',
      '--setenv', 'HOME', '/home/sandbox',
      '--setenv', 'PATH', '/usr/bin:/bin',
      '--setenv', 'SANDBOX', '1',

      // Die if parent dies
      '--die-with-parent',

      // Execute the command
      '/bin/sh', '-c', command,
    ];

    return {
      wrappedCommand: 'bwrap',
      args: bwrapArgs,
    };
  }
}

/**
 * Manages OS-level sandbox isolation using bubblewrap
 */
class OsLevelSandbox {
  private active = false;
  private sandboxRoot: string | null = null;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Check if bubblewrap is available
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execAsync('which bwrap');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize the OS-level sandbox environment
   */
  async initialize(sandboxPath: string): Promise<void> {
    // Create a minimal root filesystem for the sandbox
    const rootDir = path.join(sandboxPath, '.sandbox-root');

    // Create directory structure
    await fs.mkdir(path.join(rootDir, 'usr', 'bin'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'lib'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'lib64'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'etc'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'tmp'), { recursive: true });
    await fs.mkdir(path.join(rootDir, 'home', 'sandbox'), { recursive: true });

    // Create minimal /etc files
    await fs.writeFile(path.join(rootDir, 'etc', 'passwd'),
      'root:x:0:0:root:/root:/bin/sh\nsandbox:x:1000:1000:sandbox:/home/sandbox:/bin/sh\n');
    await fs.writeFile(path.join(rootDir, 'etc', 'group'),
      'root:x:0:\nsandbox:x:1000:\n');
    await fs.writeFile(path.join(rootDir, 'etc', 'resolv.conf'),
      'nameserver 8.8.8.8\nnameserver 8.8.4.4\n');

    this.sandboxRoot = rootDir;
    this.active = true;
  }

  /**
   * Execute a command within the OS-level sandbox
   */
  async executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!this.active || !this.sandboxRoot) {
      throw new Error('OS-level sandbox not active');
    }

    const { wrappedCommand, args } = SandboxCommandValidator.buildBwrapWrap(
      command,
      this.sandboxRoot,
      this.workspacePath
    );

    return new Promise((resolve, reject) => {
      const proc = spawn(wrappedCommand, args, {
        cwd: cwd || this.workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => { stdout += data; });
      proc.stderr?.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code || 0 });
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Check if sandbox is active
   */
  isActive(): boolean {
    return this.active;
  }

  /**
   * Get the sandbox root path
   */
  getSandboxRoot(): string | null {
    return this.sandboxRoot;
  }

  /**
   * Cleanup the sandbox
   */
  async cleanup(): Promise<void> {
    if (this.sandboxRoot) {
      try {
        await fs.rm(this.sandboxRoot, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
    this.active = false;
    this.sandboxRoot = null;
  }
}

/**
 * Plans and previews mode switches before executing them
 */
export class ModeSwitchPlanner {
  /**
   * Create a plan for switching modes
   */
  static async createPlan(
    fromMode: string,
    toMode: string,
    reason: string | undefined,
    sandboxManager: SandboxManager
  ): Promise<ModeSwitchPlan> {
    const plan: ModeSwitchPlan = {
      fromMode,
      toMode,
      reason,
      intendedActions: [],
    };

    // Get sandbox status
    const sandboxInfo = sandboxManager.getSandboxInfo();
    if (sandboxInfo.isActive && sandboxInfo.config) {
      // Check for uncommitted changes
      const { stdout } = await execAsync(
        `git -C "${sandboxInfo.config.worktreePath}" status --porcelain`,
        { timeout: 5000 }
      ).catch(() => ({ stdout: '' }));

      plan.sandboxStatus = {
        active: true,
        branchName: sandboxInfo.config.branchName,
        uncommittedChanges: stdout.trim().length > 0,
      };

      // Add actions based on target mode
      if (fromMode === 'sandbox' && toMode !== 'sandbox') {
        plan.intendedActions.push(
          `Exit sandbox "${sandboxInfo.config.branchName}"`,
          plan.sandboxStatus.uncommittedChanges
            ? '⚠️ Warning: Sandbox has uncommitted changes'
            : 'Sandbox has no uncommitted changes',
          'Ask whether to keep or delete the sandbox branch',
          `Switch to ${toMode} mode`,
          toMode === 'agent'
            ? '🔓 Full autonomy enabled - all tools and commands available'
            : toMode === 'ask'
            ? '💬 Chat mode - no tool execution'
            : '📖 Plan mode - read-only access',
        );
      }
    } else if (fromMode !== 'sandbox' && toMode === 'sandbox') {
      plan.intendedActions.push(
        'Switch to sandbox mode',
        '🔒 Restricted permissions - OS-level isolation enabled',
        'Agent will need to create a sandbox before making changes',
      );
    } else {
      plan.intendedActions.push(
        `Switch from ${fromMode} to ${toMode} mode`,
        toMode === 'agent'
          ? '🔓 Full autonomy enabled'
          : toMode === 'ask'
          ? '💬 Chat mode - no tool execution'
          : toMode === 'plan'
          ? '📖 Plan mode - read-only access'
          : '🔒 Sandbox mode - restricted permissions',
      );
    }

    return plan;
  }

  /**
   * Format a plan for display to the user
   */
  static formatPlan(plan: ModeSwitchPlan): string {
    const lines = [
      '# Mode Switch Plan',
      '',
      `**From:** ${plan.fromMode}`,
      `**To:** ${plan.toMode}`,
      plan.reason ? `**Reason:** ${plan.reason}` : '',
      '',
      '## Intended Actions:',
    ];

    for (const action of plan.intendedActions) {
      lines.push(`  - ${action}`);
    }

    if (plan.sandboxStatus?.active) {
      lines.push('');
      lines.push('## Sandbox Status:');
      lines.push(`  - Branch: ${plan.sandboxStatus.branchName}`);
      lines.push(`  - Changes: ${plan.sandboxStatus.uncommittedChanges ? '⚠️ Uncommitted' : '✅ Clean'}`);
    }

    return lines.filter((l) => l !== '').join('\n');
  }

  /**
   * Show plan to user and get approval
   */
  static async showPlan(plan: ModeSwitchPlan): Promise<boolean> {
    const formatted = this.formatPlan(plan);

    const choice = await vscode.window.showQuickPick(
      [
        { label: '$(check) Approve - Switch Mode', value: true },
        { label: '$(x) Cancel - Stay in Current Mode', value: false },
        { label: '$(eye) View Full Plan', value: 'view' },
      ],
      {
        placeHolder: `Switch from ${plan.fromMode} to ${plan.toMode} mode?`,
        detail: plan.intendedActions.slice(0, 2).join(' | '),
      }
    );

    if (choice?.value === 'view') {
      // Show full plan in a new document
      const doc = await vscode.workspace.openTextDocument({
        content: formatted,
        language: 'markdown',
      });
      await vscode.window.showTextDocument(doc, { preview: false });

      // Ask again after viewing
      const confirm = await vscode.window.showWarningMessage(
        `Proceed with mode switch to ${plan.toMode}?`,
        { modal: true },
        'Yes, Switch Mode',
        'Cancel'
      );
      return confirm === 'Yes, Switch Mode';
    }

    return choice?.value === true;
  }
}

export class SandboxManager {
  private currentSandbox: SandboxConfig | null = null;
  private osLevelSandbox: OsLevelSandbox | null = null;
  private _onDidChangeSandbox = new vscode.EventEmitter<SandboxInfo>();
  readonly onDidChangeSandbox = this._onDidChangeSandbox.event;

  private readonly RESTRICTED_COMMANDS = [
    'sudo',
    'su',
    'pkill',
    'killall',
    'kill -9',
    'rm -rf /',
    'chmod 000',
    'chown root',
    'mkfs',
    'dd if=',
    ':(){:|:&};:',  // Fork bomb
  ];

  constructor(private workspaceFolder: vscode.WorkspaceFolder) {
    this.osLevelSandbox = new OsLevelSandbox(this.workspaceFolder.uri.fsPath);
  }

  /**
   * Check if OS-level sandboxing is available
   */
  static async isOsLevelSandboxAvailable(): Promise<boolean> {
    return OsLevelSandbox.isAvailable();
  }

  /**
   * Check if currently in a sandbox
   */
  getSandboxInfo(): SandboxInfo {
    return {
      isActive: this.currentSandbox !== null,
      config: this.currentSandbox ?? undefined,
      osLevelIsolation: this.osLevelSandbox?.isActive() ?? false,
    };
  }

  /**
   * Create a new sandbox with git worktree, branch, and OS-level isolation
   */
  async createSandbox(featureName?: string): Promise<SandboxConfig> {
    if (this.currentSandbox) {
      throw new Error('Already in a sandbox. Exit the current sandbox first.');
    }

    const workspacePath = this.workspaceFolder.uri.fsPath;

    // Check if we're in a git repository
    try {
      await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
    } catch {
      throw new Error('Not in a git repository. Cannot create sandbox.');
    }

    // Check OS-level sandbox availability
    const hasOsLevelSandbox = await OsLevelSandbox.isAvailable();

    // Generate branch and worktree names
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const branchName = featureName
      ? `sandbox/${featureName}-${timestamp}`
      : `sandbox/${timestamp}`;

    // Create the worktree path in parent directory
    const parentDir = path.dirname(workspacePath);
    const worktreeName = `${path.basename(workspacePath)}-${timestamp}`;
    const worktreePath = path.join(parentDir, worktreeName);

    // Create the worktree and new branch
    try {
      await execAsync(
        `git worktree add -b "${branchName}" "${worktreePath}"`,
        { cwd: workspacePath }
      );
    } catch (err) {
      throw new Error(`Failed to create git worktree: ${err}`);
    }

    // Initialize OS-level sandbox if available
    if (hasOsLevelSandbox) {
      try {
        await this.osLevelSandbox!.initialize(worktreePath);
      } catch (err) {
        vscode.window.showWarningMessage(
          `OS-level sandbox initialization failed: ${err}. Falling back to software-level restrictions.`
        );
      }
    }

    this.currentSandbox = {
      worktreePath,
      branchName,
      originalPath: workspacePath,
      sandboxRoot: this.osLevelSandbox?.getSandboxRoot() ?? undefined,
    };

    this._onDidChangeSandbox.fire(this.getSandboxInfo());

    const isolationLevel = hasOsLevelSandbox ? 'OS-level (bubblewrap)' : 'software-level';
    vscode.window.showInformationMessage(
      `Sandbox created (${isolationLevel}): ${worktreePath} (branch: ${branchName})`
    );

    return this.currentSandbox;
  }

  /**
   * Exit the current sandbox
   */
  async exitSandbox(keepChanges?: boolean): Promise<void> {
    if (!this.currentSandbox) {
      throw new Error('Not in a sandbox.');
    }

    const { worktreePath, branchName, originalPath } = this.currentSandbox;

    try {
      // Cleanup OS-level sandbox
      if (this.osLevelSandbox?.isActive()) {
        await this.osLevelSandbox.cleanup();
      }

      // Remove the worktree
      await execAsync(`git worktree remove "${worktreePath}"`, {
        cwd: originalPath,
      });

      // Ask if user wants to keep or delete the branch
      if (keepChanges === undefined) {
        const choice = await vscode.window.showQuickPick(
          [
            { label: 'Keep branch', value: true },
            { label: 'Delete branch', value: false },
          ],
          { placeHolder: `What should happen to branch "${branchName}"?` }
        );
        keepChanges = choice?.value ?? true;
      }

      if (!keepChanges) {
        try {
          await execAsync(`git branch -D "${branchName}"`, {
            cwd: originalPath,
          });
        } catch {
          // Branch might have been merged or already deleted
        }
      }
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to clean up sandbox: ${err}`
      );
    } finally {
      this.currentSandbox = null;
      this._onDidChangeSandbox.fire(this.getSandboxInfo());
    }
  }

  /**
   * Execute a command, potentially within OS-level sandbox
   */
  async executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // If OS-level sandbox is active, use it
    if (this.osLevelSandbox?.isActive()) {
      return this.osLevelSandbox.executeCommand(command, cwd);
    }

    // Otherwise, fall back to software-level checks and normal execution
    const check = this.isCommandAllowed(command);
    if (!check.allowed) {
      throw new Error(`Command blocked: ${check.reason}`);
    }

    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || this.workspaceFolder.uri.fsPath,
    });

    return { stdout, stderr, exitCode: 0 };
  }

  /**
   * Check if a command is allowed in the sandbox (software-level fallback)
   */
  isCommandAllowed(command: string): { allowed: boolean; reason?: string } {
    // If OS-level sandbox is active, all commands are contained
    if (this.osLevelSandbox?.isActive()) {
      return { allowed: true };
    }

    const cmdLower = command.toLowerCase().trim();

    // Check for restricted commands
    for (const restricted of this.RESTRICTED_COMMANDS) {
      if (cmdLower.includes(restricted.toLowerCase())) {
        return {
          allowed: false,
          reason: `Command contains restricted pattern: ${restricted}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a file path is allowed for writing
   */
  isFilePathAllowed(filePath: string): { allowed: boolean; reason?: string } {
    if (!this.currentSandbox) {
      return { allowed: true };
    }

    const resolvedPath = path.resolve(
      this.currentSandbox.worktreePath,
      filePath
    );

    if (!resolvedPath.startsWith(this.currentSandbox.worktreePath)) {
      return {
        allowed: false,
        reason: 'Cannot write files outside sandbox workspace',
      };
    }

    return { allowed: true };
  }

  /**
   * Get the current sandbox workspace path
   */
  getCurrentWorkspace(): string {
    return this.currentSandbox?.worktreePath ?? this.workspaceFolder.uri.fsPath;
  }

  /**
   * Get info about the sandbox for display
   */
  getSandboxStatus(): string {
    if (!this.currentSandbox) {
      return 'Not in sandbox';
    }

    const isolationType = this.osLevelSandbox?.isActive()
      ? ' [OS-level]'
      : ' [Software-level]';

    return `Sandbox${isolationType}: ${this.currentSandbox.branchName} @ ${this.currentSandbox.worktreePath}`;
  }

  dispose() {
    this._onDidChangeSandbox.dispose();
  }
}
