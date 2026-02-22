import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';
import { SandboxManager } from '../sandbox/manager';

export class ReadFileTool implements Tool {
  definition = {
    name: 'readFile',
    description:
      'Read the contents of a file. Returns the file text, optionally limited to a line range.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root',
        },
        startLine: {
          type: 'number',
          description: 'Optional start line (1-indexed)',
        },
        endLine: {
          type: 'number',
          description: 'Optional end line (1-indexed, inclusive)',
        },
      },
      required: ['path'],
    },
  };

  constructor(private sandboxManager?: SandboxManager) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.path as string;
    const startLine = params.startLine as number | undefined;
    const endLine = params.endLine as number | undefined;

    // When a sandbox is active, read from the sandbox worktree
    if (this.sandboxManager) {
      const info = this.sandboxManager.getSandboxInfo();
      if (info.isActive && info.config) {
        const fs = await import('fs/promises');
        const fullPath = path.resolve(info.config.worktreePath, filePath);
        try {
          let text = await fs.readFile(fullPath, 'utf-8');
          if (startLine !== undefined || endLine !== undefined) {
            const lines = text.split('\n');
            const start = (startLine ?? 1) - 1;
            const end = endLine ?? lines.length;
            text = lines.slice(start, end).join('\n');
          }
          return { content: text };
        } catch (err) {
          return {
            content: `Failed to read file "${filePath}" in sandbox: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { content: 'No workspace folder open', isError: true };
    }

    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

    try {
      const fileContent = await vscode.workspace.fs.readFile(fullPath);
      let text = Buffer.from(fileContent).toString('utf-8');

      if (startLine !== undefined || endLine !== undefined) {
        const lines = text.split('\n');
        const start = (startLine ?? 1) - 1;
        const end = endLine ?? lines.length;
        text = lines.slice(start, end).join('\n');
      }

      return { content: text };
    } catch (err) {
      return {
        content: `Failed to read file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

export class WriteFileTool implements Tool {
  private sandboxManager?: SandboxManager;

  definition = {
    name: 'writeFile',
    description:
      'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file from the workspace root',
        },
        content: {
          type: 'string',
          description: 'The content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  };

  constructor(sandboxManager?: SandboxManager) {
    this.sandboxManager = sandboxManager;
  }

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.path as string;
    const content = params.content as string;

    // When a sandbox is active, redirect writes to the sandbox worktree
    if (this.sandboxManager) {
      const info = this.sandboxManager.getSandboxInfo();
      if (info.isActive && info.config) {
        const check = this.sandboxManager.isFilePathAllowed(filePath);
        if (!check.allowed) {
          return {
            content: `File write blocked: ${check.reason}`,
            isError: true,
          };
        }

        // Write to the sandbox worktree instead of the main workspace
        const fs = await import('fs/promises');
        const fullPath = path.resolve(info.config.worktreePath, filePath);
        try {
          await fs.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.writeFile(fullPath, content, 'utf-8');
          return { content: `File written: ${filePath} (in sandbox branch: ${info.config.branchName})` };
        } catch (err) {
          return {
            content: `Failed to write file "${filePath}" in sandbox: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { content: 'No workspace folder open', isError: true };
    }

    const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

    try {
      // Ensure parent directory exists
      const parentDir = vscode.Uri.joinPath(
        workspaceFolder.uri,
        path.dirname(filePath)
      );
      await vscode.workspace.fs.createDirectory(parentDir);

      const encoded = Buffer.from(content, 'utf-8');
      await vscode.workspace.fs.writeFile(fullPath, encoded);
      return { content: `File written: ${filePath}` };
    } catch (err) {
      return {
        content: `Failed to write file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

export class ListFilesTool implements Tool {
  definition = {
    name: 'listFiles',
    description:
      'List files in the workspace matching a glob pattern.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match files (e.g., "**/*.ts", "src/**")',
        },
        exclude: {
          type: 'string',
          description: 'Optional glob pattern to exclude files',
        },
      },
      required: ['pattern'],
    },
  };

  constructor(private sandboxManager?: SandboxManager) {}

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const exclude = params.exclude as string | undefined;

    // When a sandbox is active, list files from the sandbox worktree using glob
    if (this.sandboxManager) {
      const info = this.sandboxManager.getSandboxInfo();
      if (info.isActive && info.config) {
        const fs = await import('fs/promises');
        const { glob } = await import('glob');
        try {
          const matches = await glob(pattern, {
            cwd: info.config.worktreePath,
            ignore: exclude ? [exclude] : ['**/node_modules/**'],
            nodir: true,
          });
          if (matches.length === 0) {
            return { content: 'No files found matching the pattern in sandbox.' };
          }
          return { content: matches.sort().join('\n') };
        } catch (err) {
          return {
            content: `Failed to list files in sandbox: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      }
    }

    try {
      const files = await vscode.workspace.findFiles(
        pattern,
        exclude || '**/node_modules/**',
        500
      );

      if (files.length === 0) {
        return { content: 'No files found matching the pattern.' };
      }

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      const relativePaths = files.map((f) =>
        workspaceFolder
          ? path.relative(workspaceFolder.uri.fsPath, f.fsPath)
          : f.fsPath
      );

      return { content: relativePaths.sort().join('\n') };
    } catch (err) {
      return {
        content: `Failed to list files: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
