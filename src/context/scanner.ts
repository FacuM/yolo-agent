import * as vscode from 'vscode';
import * as path from 'path';
import { Skill, AgentsMd } from './types';

/**
 * Parses YAML frontmatter from markdown content
 * Returns an object with the parsed frontmatter and remaining content
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; content: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: {}, content };
  }

  const frontmatter: Record<string, unknown> = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      let value: unknown = line.slice(colonIndex + 1).trim();

      // Parse boolean values
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      // Parse array values (comma-separated)
      else if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map((v: string) => v.trim())
          .filter((v: string) => v.length > 0);
      }
      // Remove quotes from string values
      else if (typeof value === 'string' && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
        value = value.slice(1, -1);
      }

      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: match[2].trim() };
}

/**
 * Scans the workspace for skill files and AGENTS.md files
 * Watches for changes and emits events when files are added/modified/removed
 */
export class ContextScanner {
  private skills: Map<string, Skill> = new Map();
  private agentsMdFiles: Map<string, AgentsMd> = new Map();
  private contextWatchers: vscode.FileSystemWatcher[] = [];
  private skillsWatchers: vscode.FileSystemWatcher[] = [];
  private _onDidChangeContext = new vscode.EventEmitter<void>();
  private workspaceFolder: vscode.WorkspaceFolder | undefined;

  readonly onDidChangeContext = this._onDidChangeContext.event;

  constructor() {
    // Get the first workspace folder
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  }

  /**
   * Scan the workspace for skills and AGENTS.md files
   */
  async scanWorkspace(): Promise<void> {
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!this.workspaceFolder) {
      return;
    }

    await Promise.all([
      this.scanSkillsDirectory(),
      this.scanAgentsMdFiles(),
    ]);
  }

  /**
   * Scan for skill files in multiple common directories
   * Checks: .yolo-agent/skills, .kilo/skills, .claude/skills, .cline/skills
   */
  private async scanSkillsDirectory(): Promise<void> {
    if (!this.workspaceFolder) {
      return;
    }

    // Define multiple skill directory patterns to check
    const skillsPatterns = [
      new vscode.RelativePattern(this.workspaceFolder, '**/.yolo-agent/skills/**/*.md'),
      new vscode.RelativePattern(this.workspaceFolder, '**/.kilo/skills/**/*.md'),
      new vscode.RelativePattern(this.workspaceFolder, '**/.claude/skills/**/*.md'),
      new vscode.RelativePattern(this.workspaceFolder, '**/.cline/skills/**/*.md'),
    ];

    // Clear existing skills
    this.skills.clear();

    // Scan each pattern and load files
    for (const pattern of skillsPatterns) {
      try {
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
        for (const file of files) {
          await this.loadSkillFile(file);
        }
      } catch {
        // Pattern might not match any files, continue to next pattern
      }
    }
  }

  /**
   * Load a single skill file and parse its frontmatter
   */
  private async loadSkillFile(uri: vscode.Uri): Promise<void> {
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
      const { frontmatter, content: markdownContent } = parseFrontmatter(content);

      const fileName = path.basename(uri.fsPath, '.md');
      const skillName = (frontmatter.name as string) || fileName;
      const description = (frontmatter.description as string) || '';
      const tags = (frontmatter.tags as string[]) || [];

      const skill: Skill = {
        name: skillName,
        description,
        content: markdownContent,
        sourcePath: uri.fsPath,
        tags,
        enabled: true, // Auto-enable all skills by default
      };

      this.skills.set(uri.fsPath, skill);
    } catch (err) {
      console.error(`Failed to load skill file ${uri.fsPath}:`, err);
    }
  }

  /**
   * Scan for context files: AGENTS.md (up to 2 levels deep),
   * .github markdown files, and dot-directory rules (e.g. .kilocode/rules/)
   */
  private async scanAgentsMdFiles(): Promise<void> {
    if (!this.workspaceFolder) {
      return;
    }

    // Look for AGENTS.md files (case-insensitive) at root and up to 2 levels deep
    const patterns = [
      new vscode.RelativePattern(this.workspaceFolder, 'AGENTS.md'),
      new vscode.RelativePattern(this.workspaceFolder, 'agents.md'),
      new vscode.RelativePattern(this.workspaceFolder, '*/AGENTS.md'),
      new vscode.RelativePattern(this.workspaceFolder, '*/agents.md'),
      new vscode.RelativePattern(this.workspaceFolder, '*/*/AGENTS.md'),
      new vscode.RelativePattern(this.workspaceFolder, '*/*/agents.md'),
      // .github markdown files and subdirectories
      new vscode.RelativePattern(this.workspaceFolder, '.github/**/*.md'),
      // .*/rules/ markdown files (e.g. .kilocode/rules/, .cursor/rules/)
      new vscode.RelativePattern(this.workspaceFolder, '.*/rules/**/*.md'),
    ];

    // Clear existing AGENTS.md files
    this.agentsMdFiles.clear();

    for (const pattern of patterns) {
      try {
        const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
        for (const file of files) {
          await this.loadAgentsMdFile(file);
        }
      } catch {
        // Pattern might not match any files, continue
      }
    }
  }

  /**
   * Load a single AGENTS.md file
   */
  private async loadAgentsMdFile(uri: vscode.Uri): Promise<void> {
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
      const relativePath = vscode.workspace.asRelativePath(uri);
      const pathParts = relativePath.split(path.sep);
      const projectName = pathParts.length > 1 ? pathParts[0] : this.workspaceFolder?.name || 'Project';

      const agentsMd: AgentsMd = {
        path: uri.fsPath,
        content,
        projectName,
      };

      this.agentsMdFiles.set(uri.fsPath, agentsMd);
    } catch (err) {
      console.error(`Failed to load AGENTS.md file ${uri.fsPath}:`, err);
    }
  }

  /**
   * Get all discovered skills
   */
  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get all discovered AGENTS.md files
   */
  getAgentsMdFiles(): AgentsMd[] {
    return Array.from(this.agentsMdFiles.values());
  }

  /**
   * Start watching for file changes
   */
  startWatching(): void {
    if (!this.workspaceFolder) {
      return;
    }

    // Watch for changes to skill files in all supported directories
    const skillsPatterns = [
      '**/.yolo-agent/skills/**/*.md',
      '**/.kilo/skills/**/*.md',
      '**/.claude/skills/**/*.md',
      '**/.cline/skills/**/*.md',
    ];

    for (const pattern of skillsPatterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.workspaceFolder, pattern)
      );

      watcher.onDidCreate(async (uri) => {
        await this.loadSkillFile(uri);
        this._onDidChangeContext.fire();
      });

      watcher.onDidChange(async (uri) => {
        await this.loadSkillFile(uri);
        this._onDidChangeContext.fire();
      });

      watcher.onDidDelete((uri) => {
        this.skills.delete(uri.fsPath);
        this._onDidChangeContext.fire();
      });

      this.skillsWatchers.push(watcher);
    }

    // Watch for changes to context files (AGENTS.md, .github/*.md, .*/rules/*.md)
    const contextPatterns = [
      '**/{A,a}gents.md',
      '.github/**/*.md',
      '.*/rules/**/*.md',
    ];

    for (const pattern of contextPatterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(this.workspaceFolder, pattern)
      );

      watcher.onDidCreate(async (uri) => {
        await this.loadAgentsMdFile(uri);
        this._onDidChangeContext.fire();
      });

      watcher.onDidChange(async (uri) => {
        await this.loadAgentsMdFile(uri);
        this._onDidChangeContext.fire();
      });

      watcher.onDidDelete((uri) => {
        this.agentsMdFiles.delete(uri.fsPath);
        this._onDidChangeContext.fire();
      });

      this.contextWatchers.push(watcher);
    }
  }

  /**
   * Dispose of watchers and event emitters
   */
  dispose(): void {
    for (const watcher of this.skillsWatchers) {
      watcher.dispose();
    }
    this.skillsWatchers = [];
    for (const watcher of this.contextWatchers) {
      watcher.dispose();
    }
    this.contextWatchers = [];
    this._onDidChangeContext.dispose();
  }
}
