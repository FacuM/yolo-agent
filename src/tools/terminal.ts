import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';
import { SandboxManager } from '../sandbox/manager';
import { spawn } from 'child_process';

/**
 * Normalize a cwd path to be relative so it resolves inside the sandbox worktree.
 */
function toRelativeCwd(cwd: string, workspaceRoot?: string): string {
  let p = cwd;
  if (workspaceRoot) {
    const root = workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/';
    if (p === workspaceRoot) { return '.'; }
    if (p.startsWith(root)) { p = p.slice(root.length); }
  }
  p = p.replace(/^\/+/, '');
  return p || '.';
}

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:\[[0-9;]*[a-zA-Z]|\][^\x07]*\x07|\(B)/g, '');
}

/** Max bytes of output to keep before truncating (100 KB). */
const MAX_OUTPUT = 100_000;
const KEEP_HEAD = 40_000;
const KEEP_TAIL = 40_000;

function truncateOutput(s: string): string {
  if (s.length <= MAX_OUTPUT) { return s; }
  const head = s.slice(0, KEEP_HEAD);
  const tail = s.slice(s.length - KEEP_TAIL);
  const skipped = s.length - KEEP_HEAD - KEEP_TAIL;
  return `${head}\n\n... [${skipped} characters truncated] ...\n\n${tail}`;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stalledOut: boolean;
}

export type TerminalOutputCallback = (chunk: string) => void;

export class RunTerminalTool implements Tool {
  private sandboxManager?: SandboxManager;

  /**
   * Optional callback that receives streaming output chunks (batched every 500ms).
   * Set this before calling execute() to get real-time output.
   * Automatically cleared after each execution.
   */
  public onOutput?: TerminalOutputCallback;

  definition = {
    name: 'runTerminal',
    description:
      `Execute a shell command and return its stdout/stderr output.

Commands are monitored in real-time with stall detection:
- If no output is produced for 60s (stall timeout), the command is killed.
- Maximum total runtime is 300s (5 minutes).
- Use 'timeout' and 'stallTimeout' for known long-running commands.

Examples of commands needing higher timeouts:
- npm install / yarn install → timeout: 600
- Large builds → timeout: 600
- Test suites → timeout: 600, stallTimeout: 120`,
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
        timeout: {
          type: 'number',
          description: 'Max total timeout in seconds (default: 300). Use higher values for long-running commands.',
        },
        stallTimeout: {
          type: 'number',
          description: 'Seconds of no output before the command is considered stuck (default: 60)',
        },
      },
      required: ['command'],
    },
  };

  constructor(sandboxManager?: SandboxManager) {
    this.sandboxManager = sandboxManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const cwd = params.cwd as string | undefined;
    const maxTimeoutSec = (params.timeout as number) || 300;
    const stallTimeoutSec = (params.stallTimeout as number) || 60;

    // Check sandbox restrictions if in sandbox mode
    if (this.sandboxManager) {
      const check = this.sandboxManager.isCommandAllowed(command);
      if (!check.allowed) {
        return {
          content: `Command blocked: ${check.reason}`,
          isError: true,
        };
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    // When sandbox is active, run commands in the sandbox worktree
    let effectiveCwd: string | undefined;
    if (this.sandboxManager) {
      const info = this.sandboxManager.getSandboxInfo();
      if (info.isActive && info.config) {
        effectiveCwd = cwd
          ? path.resolve(info.config.worktreePath, toRelativeCwd(cwd, info.config.originalPath))
          : info.config.worktreePath;
      }
    }
    if (!effectiveCwd) {
      effectiveCwd = cwd
        ? vscode.Uri.joinPath(workspaceFolder?.uri ?? vscode.Uri.file('/'), cwd).fsPath
        : workspaceFolder?.uri.fsPath;
    }

    try {
      const result = await this.runWithStreaming(
        command,
        effectiveCwd,
        maxTimeoutSec * 1000,
        stallTimeoutSec * 1000
      );

      // Clean and truncate output
      let output = stripAnsi(result.stdout);
      if (result.stderr) {
        const cleanStderr = stripAnsi(result.stderr);
        output += (output ? '\n--- stderr ---\n' : '') + cleanStderr;
      }
      output = truncateOutput(output);

      if (result.timedOut) {
        output += result.stalledOut
          ? `\n\n⚠ Command stalled — no output for ${stallTimeoutSec}s. Process was terminated.`
          : `\n\n⚠ Command timed out after ${maxTimeoutSec}s. Process was terminated.`;
      }

      const isError = result.exitCode !== null && result.exitCode !== 0;
      if (result.exitCode !== null && result.exitCode !== 0) {
        output += `\nExit code: ${result.exitCode}`;
      }

      return {
        content: output || `Command completed with exit code ${result.exitCode ?? 0}`,
        isError,
      };
    } catch (err) {
      return {
        content: `Failed to run command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    } finally {
      // Always clear the callback after execution
      this.onOutput = undefined;
    }
  }

  /**
   * Spawn a command with real-time output monitoring.
   * - `onOutput` callback receives streaming chunks (batched every 500ms).
   * - Kills process if no output for `stallTimeout` ms.
   * - Kills process if total runtime exceeds `maxTimeout` ms.
   */
  private runWithStreaming(
    command: string,
    cwd: string | undefined,
    maxTimeout: number,
    stallTimeout: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command], {
        cwd: cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      });

      let stdout = '';
      let stderr = '';
      let lastOutputTime = Date.now();
      let outputBuffer = '';
      let resolved = false;

      const flushBuffer = () => {
        if (outputBuffer && this.onOutput) {
          this.onOutput(stripAnsi(outputBuffer));
          outputBuffer = '';
        }
      };

      // Flush streaming output every 500ms to avoid message spam
      const flushTimer = setInterval(flushBuffer, 500);

      const finish = (exitCode: number | null, timedOut: boolean, stalledOut: boolean) => {
        if (resolved) { return; }
        resolved = true;
        clearInterval(flushTimer);
        clearInterval(stallChecker);
        clearTimeout(maxTimer);
        flushBuffer(); // flush remaining buffered output
        resolve({ stdout, stderr, exitCode, timedOut, stalledOut });
      };

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        outputBuffer += chunk;
        lastOutputTime = Date.now();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stderr += chunk;
        outputBuffer += chunk;
        lastOutputTime = Date.now();
      });

      proc.on('close', (code) => {
        finish(code, false, false);
      });

      proc.on('error', (err) => {
        stderr += err.message;
        finish(1, false, false);
      });

      // Stall detection: check every 5s whether output has stopped
      const stallChecker = setInterval(() => {
        if (Date.now() - lastOutputTime > stallTimeout) {
          proc.kill('SIGTERM');
          // Grace period: force kill after 5s if SIGTERM didn't work
          setTimeout(() => {
            if (!resolved) { proc.kill('SIGKILL'); }
          }, 5000);
          finish(null, true, true);
        }
      }, 5000);

      // Absolute max runtime cap
      const maxTimer = setTimeout(() => {
        if (!resolved) {
          proc.kill('SIGTERM');
          setTimeout(() => {
            if (!resolved) { proc.kill('SIGKILL'); }
          }, 5000);
          finish(null, true, false);
        }
      }, maxTimeout);
    });
  }
}
