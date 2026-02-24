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

// ────────────────────────────────────────────────────────────────────────────
//  Background process tracking
// ────────────────────────────────────────────────────────────────────────────

interface BackgroundProcess {
  id: number;
  command: string;
  pid: number | undefined;
  startedAt: number;
  /** Rolling buffer of the last N chars of combined stdout+stderr. */
  output: string;
  exitCode: number | null;
  finished: boolean;
  error?: string;
}

/** Max chars kept per background process output buffer. */
const BG_OUTPUT_LIMIT = 50_000;

/** Shared registry so both tools can access the same state. */
const backgroundProcesses = new Map<number, BackgroundProcess>();
let nextBgId = 1;

// ────────────────────────────────────────────────────────────────────────────
//  RunBackgroundTerminalTool
// ────────────────────────────────────────────────────────────────────────────

/**
 * Launches a shell command in the background and returns immediately.
 * Ideal for long-running processes such as dev servers, watchers, or builds.
 */
export class RunBackgroundTerminalTool implements Tool {
  private sandboxManager?: SandboxManager;

  definition = {
    name: 'runBackgroundTerminal',
    description:
      `Launch a shell command in the background and return immediately without waiting for it to finish.
Use this for long-running processes that should stay alive while you continue working:
- Dev servers (npm run dev, python -m http.server, etc.)
- File watchers (tsc --watch, nodemon, etc.)
- Build processes running in watch mode
- Any command that is not expected to terminate quickly

Returns a process ID you can later pass to getBackgroundTerminal to check output or status.
The process is NOT subject to stall/timeout detection — it runs until it exits on its own or is explicitly checked.`,
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run in the background',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory (relative to workspace root)',
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

    // Sandbox validation
    if (this.sandboxManager) {
      const check = this.sandboxManager.isCommandAllowed(command);
      if (!check.allowed) {
        return { content: `Command blocked: ${check.reason}`, isError: true };
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

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
      const id = nextBgId++;
      const proc = spawn('sh', ['-c', command], {
        cwd: effectiveCwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // run in its own process group
        env: {
          ...process.env,
          FORCE_COLOR: '0',
          NO_COLOR: '1',
          TERM: 'dumb',
        },
      });

      // Allow the parent Node process to exit even if this child is still running
      proc.unref();

      const entry: BackgroundProcess = {
        id,
        command,
        pid: proc.pid,
        startedAt: Date.now(),
        output: '',
        exitCode: null,
        finished: false,
      };
      backgroundProcesses.set(id, entry);

      const appendOutput = (chunk: string) => {
        entry.output += stripAnsi(chunk);
        if (entry.output.length > BG_OUTPUT_LIMIT) {
          entry.output = entry.output.slice(entry.output.length - BG_OUTPUT_LIMIT);
        }
      };

      proc.stdout?.on('data', (data: Buffer) => appendOutput(data.toString()));
      proc.stderr?.on('data', (data: Buffer) => appendOutput(data.toString()));

      proc.on('close', (code) => {
        entry.exitCode = code;
        entry.finished = true;
      });

      proc.on('error', (err) => {
        entry.error = err.message;
        entry.finished = true;
      });

      return {
        content: `Background process started (id=${id}, pid=${proc.pid ?? 'unknown'}).\nCommand: ${command}\nUse getBackgroundTerminal with id=${id} to check output and status later.`,
      };
    } catch (err) {
      return {
        content: `Failed to start background command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  GetBackgroundTerminalTool
// ────────────────────────────────────────────────────────────────────────────

/**
 * Retrieve the current output and status of a background process launched
 * by runBackgroundTerminal.
 */
export class GetBackgroundTerminalTool implements Tool {
  definition = {
    name: 'getBackgroundTerminal',
    description:
      `Check the output and status of a background process started with runBackgroundTerminal.
Pass the process id returned when the command was launched.
Returns the accumulated output buffer plus whether the process is still running.`,
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The background process id returned by runBackgroundTerminal',
        },
      },
      required: ['id'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const id = params.id as number;
    const entry = backgroundProcesses.get(id);

    if (!entry) {
      const knownIds = [...backgroundProcesses.keys()];
      return {
        content: knownIds.length
          ? `No background process with id=${id}. Active ids: ${knownIds.join(', ')}`
          : 'No background processes have been started yet.',
        isError: true,
      };
    }

    const elapsed = ((Date.now() - entry.startedAt) / 1000).toFixed(1);
    const status = entry.finished
      ? `Finished (exit code ${entry.exitCode ?? 'unknown'}${entry.error ? `, error: ${entry.error}` : ''})`
      : 'Running';

    const output = truncateOutput(entry.output) || '(no output yet)';

    return {
      content: `Background process id=${id}\nCommand: ${entry.command}\nPID: ${entry.pid ?? 'unknown'}\nStatus: ${status}\nElapsed: ${elapsed}s\n\n--- output ---\n${output}`,
    };
  }
}
