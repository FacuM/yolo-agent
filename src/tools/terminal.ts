import * as vscode from 'vscode';
import { Tool, ToolResult } from './types';

export class RunTerminalTool implements Tool {
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

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const command = params.command as string;
    const cwd = params.cwd as string | undefined;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    try {
      // Use VS Code's shell execution via a task
      const shellExec = new vscode.ShellExecution(command, {
        cwd: cwd
          ? vscode.Uri.joinPath(workspaceFolder?.uri ?? vscode.Uri.file('/'), cwd).fsPath
          : workspaceFolder?.uri.fsPath,
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
