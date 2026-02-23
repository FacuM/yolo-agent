import * as vscode from 'vscode';
import * as path from 'path';
import { Tool, ToolResult } from './types';

export class GetDiagnosticsTool implements Tool {
  definition = {
    name: 'getDiagnostics',
    description:
      'Get VS Code diagnostics (errors, warnings) for a specific file or the entire workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional relative file path. If omitted, returns diagnostics for all files.',
        },
        severity: {
          type: 'string',
          enum: ['error', 'warning', 'info', 'hint'],
          description: 'Optional filter by severity level',
        },
      },
      required: [],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const filePath = params.path as string | undefined;
    const severity = params.severity as string | undefined;

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    let diagnostics: [vscode.Uri, vscode.Diagnostic[]][];

    if (filePath && workspaceFolder) {
      const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);
      const fileDiags = vscode.languages.getDiagnostics(fullPath);
      diagnostics = [[fullPath, fileDiags]];
    } else {
      diagnostics = vscode.languages.getDiagnostics();
    }

    const severityFilter = severity
      ? this.parseSeverity(severity)
      : undefined;

    const results: string[] = [];

    for (const [uri, diags] of diagnostics) {
      const filtered = severityFilter !== undefined
        ? diags.filter((d) => d.severity === severityFilter)
        : diags;

      if (filtered.length === 0) {continue;}

      const relativePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
        : uri.fsPath;

      for (const diag of filtered) {
        const severityLabel = this.severityToString(diag.severity);
        const line = diag.range.start.line + 1;
        const col = diag.range.start.character + 1;
        results.push(
          `${relativePath}:${line}:${col} [${severityLabel}] ${diag.message}`
        );
      }
    }

    if (results.length === 0) {
      return { content: 'No diagnostics found.' };
    }

    return { content: results.join('\n') };
  }

  private parseSeverity(s: string): vscode.DiagnosticSeverity | undefined {
    switch (s.toLowerCase()) {
      case 'error': return vscode.DiagnosticSeverity.Error;
      case 'warning': return vscode.DiagnosticSeverity.Warning;
      case 'info': return vscode.DiagnosticSeverity.Information;
      case 'hint': return vscode.DiagnosticSeverity.Hint;
      default: return undefined;
    }
  }

  private severityToString(s: vscode.DiagnosticSeverity): string {
    switch (s) {
      case vscode.DiagnosticSeverity.Error: return 'error';
      case vscode.DiagnosticSeverity.Warning: return 'warning';
      case vscode.DiagnosticSeverity.Information: return 'info';
      case vscode.DiagnosticSeverity.Hint: return 'hint';
    }
  }
}
