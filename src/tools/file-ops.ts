import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';

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

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.path as string;
    const startLine = params.startLine as number | undefined;
    const endLine = params.endLine as number | undefined;

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

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.path as string;
    const content = params.content as string;

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

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const pattern = params.pattern as string;
    const exclude = params.exclude as string | undefined;

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
