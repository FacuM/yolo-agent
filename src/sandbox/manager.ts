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

  /** Max total timeout for OS-level sandbox commands (5 minutes). */
  private static MAX_TIMEOUT = 300_000;
  /** Stall timeout — no output for this long triggers kill (60s). */
  private static STALL_TIMEOUT = 60_000;

  /**
   * Execute a command within the OS-level sandbox with stall detection.
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
      let lastOutputTime = Date.now();
      let resolved = false;

      const finish = (exitCode: number, timedOut?: boolean) => {
        if (resolved) { return; }
        resolved = true;
        clearInterval(stallChecker);
        clearTimeout(maxTimer);
        if (timedOut) {
          stderr += '\n⚠ Command timed out / stalled and was terminated.';
        }
        resolve({ stdout, stderr, exitCode });
      };

      proc.stdout?.on('data', (data) => {
        stdout += data;
        lastOutputTime = Date.now();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data;
        lastOutputTime = Date.now();
      });

      proc.on('close', (code) => { finish(code || 0); });
      proc.on('error', (err) => {
        if (!resolved) { reject(err); }
      });

      // Stall detection
      const stallChecker = setInterval(() => {
        if (Date.now() - lastOutputTime > OsLevelSandbox.STALL_TIMEOUT) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!resolved) { proc.kill('SIGKILL'); } }, 5000);
          finish(1, true);
        }
      }, 5000);

      // Max runtime cap
      const maxTimer = setTimeout(() => {
        if (!resolved) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!resolved) { proc.kill('SIGKILL'); } }, 5000);
          finish(1, true);
        }
      }, OsLevelSandbox.MAX_TIMEOUT);
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

    // Ensure we're in a git repository — auto-init if needed
    try {
      await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
    } catch {
      // Not a git repo — initialize one so we can create worktrees
      try {
        await execAsync('git init', { cwd: workspacePath });
        // Need at least one commit for worktrees to work
        await execAsync('git add -A && git commit --allow-empty -m "Initial commit (auto-created by sandbox)"', { cwd: workspacePath });
      } catch (initErr) {
        throw new Error(`Failed to initialize git repository: ${initErr}`);
      }
    }

    // Ensure there is at least one commit (worktrees require HEAD)
    try {
      await execAsync('git rev-parse HEAD', { cwd: workspacePath });
    } catch {
      try {
        await execAsync('git add -A && git commit --allow-empty -m "Initial commit (auto-created by sandbox)"', { cwd: workspacePath });
      } catch {
        // Ignore — we tried our best
      }
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

    // Verify the worktree is a valid git repository before proceeding.
    // git worktree add can occasionally create the directory without a proper .git
    // linkage file (e.g., interrupted operation, filesystem issues).
    try {
      await execAsync('git rev-parse --git-dir', { cwd: worktreePath });
    } catch {
      // Try to repair: remove the half-created worktree directory and retry once
      try {
        await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: workspacePath }).catch(() => {});
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
        await execAsync('git worktree prune', { cwd: workspacePath }).catch(() => {});
        // Delete the orphaned branch so we can retry cleanly
        await execAsync(`git branch -D "${branchName}"`, { cwd: workspacePath }).catch(() => {});
        // Retry worktree creation
        await execAsync(
          `git worktree add -b "${branchName}" "${worktreePath}"`,
          { cwd: workspacePath }
        );
        // Verify the retry
        await execAsync('git rev-parse --git-dir', { cwd: worktreePath });
      } catch (retryErr) {
        throw new Error(
          `Git worktree was created at "${worktreePath}" but is not a valid git repository. ` +
          `Repair attempt failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
      }
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

  /** Max total timeout for commands (5 minutes). */
  private static CMD_MAX_TIMEOUT = 300_000;
  /** Stall timeout for commands (60s). */
  private static CMD_STALL_TIMEOUT = 60_000;

  /**
   * Execute a command, potentially within OS-level sandbox.
   * Uses spawn with real-time stall detection instead of exec.
   */
  async executeCommand(command: string, cwd?: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // If OS-level sandbox is active, use it
    if (this.osLevelSandbox?.isActive()) {
      return this.osLevelSandbox.executeCommand(command, cwd);
    }

    // Otherwise, fall back to software-level checks and spawn-based execution
    const check = this.isCommandAllowed(command);
    if (!check.allowed) {
      throw new Error(`Command blocked: ${check.reason}`);
    }

    const effectiveCwd = cwd || this.workspaceFolder.uri.fsPath;

    return new Promise((resolve, reject) => {
      const proc = spawn('sh', ['-c', command], {
        cwd: effectiveCwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
      });

      let stdout = '';
      let stderr = '';
      let lastOutputTime = Date.now();
      let resolved = false;

      const finish = (exitCode: number, timedOut?: boolean) => {
        if (resolved) { return; }
        resolved = true;
        clearInterval(stallChecker);
        clearTimeout(maxTimer);
        if (timedOut) {
          stderr += '\n⚠ Command timed out / stalled and was terminated.';
        }
        resolve({ stdout, stderr, exitCode });
      };

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
        lastOutputTime = Date.now();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
        lastOutputTime = Date.now();
      });

      proc.on('close', (code) => { finish(code || 0); });
      proc.on('error', (err) => {
        if (!resolved) { reject(err); }
      });

      // Stall detection
      const stallChecker = setInterval(() => {
        if (Date.now() - lastOutputTime > SandboxManager.CMD_STALL_TIMEOUT) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!resolved) { proc.kill('SIGKILL'); } }, 5000);
          finish(1, true);
        }
      }, 5000);

      // Max runtime cap
      const maxTimer = setTimeout(() => {
        if (!resolved) {
          proc.kill('SIGTERM');
          setTimeout(() => { if (!resolved) { proc.kill('SIGKILL'); } }, 5000);
          finish(1, true);
        }
      }, SandboxManager.CMD_MAX_TIMEOUT);
    });
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

    // Normalize path: strip workspace root prefix and leading slashes so
    // absolute paths from the LLM don't escape the worktree
    let safePath = filePath;
    const origRoot = this.currentSandbox.originalPath;
    const rootPrefix = origRoot.endsWith('/') ? origRoot : origRoot + '/';
    if (safePath.startsWith(rootPrefix)) {
      safePath = safePath.slice(rootPrefix.length);
    } else if (safePath === origRoot) {
      safePath = '.';
    }
    safePath = safePath.replace(/^\/+/, '');

    const resolvedPath = path.resolve(
      this.currentSandbox.worktreePath,
      safePath
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

  /**
   * Get a summary of changes in the sandbox worktree vs the base branch.
   * Returns a list of changed files with their status.
   */
  async getSandboxDiff(): Promise<{ files: { status: string; path: string }[]; summary: string }> {
    if (!this.currentSandbox) {
      return { files: [], summary: 'No active sandbox' };
    }

    const { worktreePath, branchName } = this.currentSandbox;
    const execOpts = { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 };

    try {
      // Commit any uncommitted changes first so diff is accurate
      await this.autoCommitWorktree(worktreePath, 'sandbox: auto-commit pending changes');

      // Find the merge-base: the point where the sandbox branched off
      const mergeBase = await this.getMergeBase(worktreePath, branchName);

      // Get diff stat from the merge-base to HEAD (shows ALL sandbox changes)
      const { stdout: diffStat } = await execAsync(
        `git diff --stat ${mergeBase}..HEAD`,
        execOpts
      ).catch(() => ({ stdout: '(no changes)' }));

      // Get list of changed files from merge-base to HEAD
      const { stdout: diffFiles } = await execAsync(
        `git diff --name-status ${mergeBase}..HEAD`,
        execOpts
      ).catch(() => ({ stdout: '' }));

      const files = diffFiles.trim().split('\n').filter(l => l.trim()).map(line => {
        const [status, ...pathParts] = line.split('\t');
        return { status: status.trim(), path: pathParts.join('\t').trim() };
      }).filter(f => f.path);

      return {
        files,
        summary: diffStat.trim() || '(no changes)',
      };
    } catch {
      return { files: [], summary: 'Unable to compute diff' };
    }
  }

  /**
   * Find the merge-base between the sandbox branch and its parent.
   * Falls back to the first commit of the branch if merge-base fails.
   */
  private async getMergeBase(worktreePath: string, branchName: string): Promise<string> {
    const originalPath = this.currentSandbox?.originalPath ?? worktreePath;
    try {
      // Try to get the merge-base from the original repo
      const { stdout: base } = await execAsync(
        `git merge-base HEAD "${branchName}"`,
        { cwd: originalPath }
      );
      return base.trim();
    } catch {
      // Fallback: use the first parent of the first commit on the branch
      try {
        const { stdout: firstCommit } = await execAsync(
          'git rev-list --max-parents=0 HEAD',
          { cwd: worktreePath }
        );
        return firstCommit.trim();
      } catch {
        return 'HEAD~1';
      }
    }
  }

  /**
   * Auto-commit all pending changes in a worktree.
   * Returns true if a commit was made, false if there was nothing to commit.
   * Throws if the commit fails unexpectedly.
   */
  private async autoCommitWorktree(worktreePath: string, message: string): Promise<boolean> {
    const execOpts = { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 };

    // Verify the worktree is still a valid git repository.
    // The .git file (a pointer back to the main repo) can go missing if
    // a tool or command removed it, or if creation was incomplete.
    try {
      await execAsync('git rev-parse --git-dir', execOpts);
    } catch {
      // Attempt repair: recreate the .git linkage file from the parent repo
      const repaired = await this.repairWorktreeGitLink(worktreePath);
      if (!repaired) {
        throw new Error(
          `The worktree at "${worktreePath}" is not a valid git repository ` +
          `(missing .git linkage file) and could not be repaired automatically. ` +
          `You can manually copy any needed files from that directory.`
        );
      }
    }

    // Check if there are uncommitted changes
    const { stdout: status } = await execAsync('git status --porcelain', execOpts);
    if (!status.trim()) {
      return false; // Nothing to commit
    }

    // Stage all changes
    await execAsync('git add -A', execOpts);

    // Commit
    await execAsync(`git commit -m "${message}"`, execOpts);

    // Verify: check that nothing is left uncommitted
    const { stdout: remaining } = await execAsync('git status --porcelain', execOpts);
    if (remaining.trim()) {
      // Some files weren't committed (e.g., .gitignore exclusions) — that's OK
      // but log it for debugging
      console.warn(`[sandbox] After auto-commit, still uncommitted:\n${remaining.trim()}`);
    }

    return true;
  }

  /**
   * Attempt to repair a worktree whose .git linkage file is missing.
   * A git worktree normally has a `.git` *file* (not directory) containing:
   *   gitdir: /path/to/main-repo/.git/worktrees/<name>
   *
   * If this file is deleted, we can reconstruct it from the parent repo.
   * Returns true if repair succeeded, false otherwise.
   */
  private async repairWorktreeGitLink(worktreePath: string): Promise<boolean> {
    if (!this.currentSandbox) { return false; }
    const { originalPath } = this.currentSandbox;
    const gitDir = path.join(originalPath, '.git');

    try {
      // Check whether the main repo .git exists
      const mainGitStat = await fs.stat(gitDir);
      if (!mainGitStat.isDirectory()) { return false; }

      // Look for a worktrees/ entry that points to our worktreePath
      const worktreesDir = path.join(gitDir, 'worktrees');
      let entries: string[];
      try {
        entries = await fs.readdir(worktreesDir);
      } catch {
        return false; // No worktrees directory at all
      }

      for (const entry of entries) {
        const gitdirFile = path.join(worktreesDir, entry, 'gitdir');
        try {
          const gitdirContent = (await fs.readFile(gitdirFile, 'utf8')).trim();
          // The gitdir file in .git/worktrees/<name>/gitdir contains the path
          // to the worktree's .git file (e.g., /path/to/worktree/.git)
          const expectedWorktreeGit = path.join(worktreePath, '.git');
          if (path.resolve(gitdirContent) === path.resolve(expectedWorktreeGit)) {
            // Found the matching worktree entry — recreate the .git linkage file
            const linkTarget = path.join(worktreesDir, entry);
            await fs.writeFile(
              expectedWorktreeGit,
              `gitdir: ${linkTarget}\n`,
              'utf8'
            );
            // Verify the repair
            await execAsync('git rev-parse --git-dir', { cwd: worktreePath });
            console.log(`[sandbox] Repaired .git linkage for worktree at ${worktreePath}`);
            return true;
          }
        } catch {
          continue; // This entry doesn't match or is unreadable
        }
      }

      return false;
    } catch (err) {
      console.warn(`[sandbox] Failed to repair worktree .git linkage: ${err}`);
      return false;
    }
  }

  /**
   * Apply sandbox changes: merge the sandbox branch into the original branch,
   * then clean up the worktree and branch.
   */
  async applySandbox(): Promise<{ success: boolean; message: string }> {
    if (!this.currentSandbox) {
      return { success: false, message: 'No active sandbox to apply.' };
    }

    const { worktreePath, branchName, originalPath } = this.currentSandbox;

    try {
      // 1. Commit any uncommitted changes — this is critical!
      //    If this fails, we must NOT remove the worktree or we lose files.
      try {
        await this.autoCommitWorktree(worktreePath, 'sandbox: final changes');
      } catch (commitErr) {
        return {
          success: false,
          message: `Failed to commit sandbox changes: ${commitErr instanceof Error ? commitErr.message : String(commitErr)}. The worktree at "${worktreePath}" has been preserved — you can commit manually and retry.`,
        };
      }

      // 2. Verify ALL changes are committed before we destroy the worktree
      const { stdout: uncommitted } = await execAsync(
        'git status --porcelain',
        { cwd: worktreePath, maxBuffer: 10 * 1024 * 1024 }
      );
      if (uncommitted.trim()) {
        // There are still uncommitted changes (likely .gitignore'd files, which is OK)
        // But log a warning
        console.warn(`[sandbox] Uncommitted files before worktree removal:\n${uncommitted.trim()}`);
      }

      // 3. Count commits on the sandbox branch to verify there's something to merge
      const mergeBase = await this.getMergeBase(worktreePath, branchName);
      const { stdout: commitCount } = await execAsync(
        `git rev-list --count ${mergeBase}..HEAD`,
        { cwd: worktreePath }
      ).catch(() => ({ stdout: '0' }));

      if (commitCount.trim() === '0') {
        // No commits on the sandbox branch — nothing to merge
        // Still clean up the worktree
        if (this.osLevelSandbox?.isActive()) {
          await this.osLevelSandbox.cleanup();
        }
        await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: originalPath });
        try { await execAsync(`git branch -D "${branchName}"`, { cwd: originalPath }); } catch { /* ignore */ }

        this.currentSandbox = null;
        this._onDidChangeSandbox.fire(this.getSandboxInfo());

        return {
          success: true,
          message: 'Sandbox had no changes to apply. Worktree cleaned up.',
        };
      }

      // 4. Clean up OS-level sandbox
      if (this.osLevelSandbox?.isActive()) {
        await this.osLevelSandbox.cleanup();
      }

      // 5. Remove the worktree (must happen before merge to release the branch lock)
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: originalPath });

      // 6. Get the current branch in the original workspace
      const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: originalPath });

      // 7. Merge the sandbox branch into the current branch
      await execAsync(`git merge "${branchName}" --no-edit`, { cwd: originalPath });

      // 8. Verify the merge brought files in by checking the working tree
      const { stdout: mergedFiles } = await execAsync(
        `git diff --name-only ${mergeBase}..HEAD`,
        { cwd: originalPath, maxBuffer: 10 * 1024 * 1024 }
      ).catch(() => ({ stdout: '' }));

      // 9. Delete the sandbox branch now that it's merged
      try {
        await execAsync(`git branch -d "${branchName}"`, { cwd: originalPath });
      } catch {
        try {
          await execAsync(`git branch -D "${branchName}"`, { cwd: originalPath });
        } catch { /* ignore */ }
      }

      this.currentSandbox = null;
      this._onDidChangeSandbox.fire(this.getSandboxInfo());

      const fileCount = mergedFiles.trim().split('\n').filter(l => l.trim()).length;
      return {
        success: true,
        message: `Sandbox branch "${branchName}" merged into "${currentBranch.trim()}" (${fileCount} file(s) applied).`,
      };
    } catch (err) {
      // If merge failed, try to recover — do NOT clear currentSandbox
      // so the user can retry or discard
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check if the worktree still exists
      try {
        await execAsync(`test -d "${worktreePath}"`);
        // Worktree still exists — user can retry
        return {
          success: false,
          message: `Apply failed: ${errMsg}. The sandbox worktree at "${worktreePath}" is still intact — you can retry or discard.`,
        };
      } catch {
        // Worktree was removed but merge failed — branch should still exist
        this.currentSandbox = null;
        this._onDidChangeSandbox.fire(this.getSandboxInfo());

        return {
          success: false,
          message: `Merge failed: ${errMsg}. The branch "${branchName}" has been kept for manual resolution. Run: git merge "${branchName}" --no-edit`,
        };
      }
    }
  }

  /**
   * Discard sandbox changes: remove the worktree and delete the branch.
   */
  async discardSandbox(): Promise<{ success: boolean; message: string }> {
    if (!this.currentSandbox) {
      return { success: false, message: 'No active sandbox to discard.' };
    }

    const { worktreePath, branchName, originalPath } = this.currentSandbox;

    try {
      // Clean up OS-level sandbox
      if (this.osLevelSandbox?.isActive()) {
        await this.osLevelSandbox.cleanup();
      }

      // Remove the worktree
      await execAsync(`git worktree remove "${worktreePath}" --force`, { cwd: originalPath });

      // Delete the branch
      try {
        await execAsync(`git branch -D "${branchName}"`, { cwd: originalPath });
      } catch {
        // Branch might already be gone
      }

      // Prune any stale worktree references
      await execAsync('git worktree prune', { cwd: originalPath }).catch(() => {});

      this.currentSandbox = null;
      this._onDidChangeSandbox.fire(this.getSandboxInfo());

      return {
        success: true,
        message: `Sandbox discarded. Branch "${branchName}" and worktree removed.`,
      };
    } catch (err) {
      this.currentSandbox = null;
      this._onDidChangeSandbox.fire(this.getSandboxInfo());

      return {
        success: false,
        message: `Cleanup failed: ${err instanceof Error ? err.message : String(err)}. You may need to manually run: git worktree remove "${worktreePath}" && git branch -D "${branchName}"`,
      };
    }
  }

  dispose() {
    this._onDidChangeSandbox.dispose();
  }
}
