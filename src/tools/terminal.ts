import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';
import { SandboxManager } from '../sandbox/manager';

export class RunTerminalTool implements Tool {
  private sandboxManager?: SandboxManager;

  definition = {
    name: 'runTerminal',
    description:
      'Execute a shell command in the VS Code integrated terminal and return the output.',
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

  constructor(sandboxManager?: SandboxManager) {
    this.sandboxManager = sandboxManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const cwd = params.cwd as string | undefined;

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
          ? require('path').resolve(info.config.worktreePath, cwd)
          : info.config.worktreePath;
      }
    }
    if (!effectiveCwd) {
      effectiveCwd = cwd
        ? vscode.Uri.joinPath(workspaceFolder?.uri ?? vscode.Uri.file('/'), cwd).fsPath
        : workspaceFolder?.uri.fsPath;
    }

    try {
      // Use VS Code's shell execution via a task
      const shellExec = new vscode.ShellExecution(command, {
        cwd: effectiveCwd,
      });

      const task = new vscode.Task(
        { type: 'yoloAgent' },
        workspaceFolder ?? vscode.TaskScope.Workspace,
        'YOLO Agent Command',
        'yoloAgent',
        shellExec
      );

      // Collect output via task execution
      const output = await new Promise<string>((resolve, reject) => {
        let taskOutput = '';
        const disposables: vscode.Disposable[] = [];

        const startListener = vscode.tasks.onDidStartTaskProcess((e) => {
          if (e.execution.task === task) {
            // Task started
          }
        });
        disposables.push(startListener);

        const endListener = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution.task === task) {
            disposables.forEach((d) => d.dispose());
            if (e.exitCode === 0) {
              resolve(taskOutput || `Command completed with exit code 0`);
            } else {
              resolve(`Command exited with code ${e.exitCode}`);
            }
          }
        });
        disposables.push(endListener);

        vscode.tasks.executeTask(task).then(undefined, (err) => {
          disposables.forEach((d) => d.dispose());
          reject(err);
        });

        // Timeout after 30 seconds
        setTimeout(() => {
          disposables.forEach((d) => d.dispose());
          resolve(taskOutput || 'Command timed out after 30 seconds');
        }, 30000);
      });

      return { content: output };
    } catch (err) {
      return {
        content: `Failed to run command: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
