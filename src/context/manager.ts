import * as vscode from 'vscode';
import { ContextScanner } from './scanner';
import { Skill, AgentsMd, ContextInjection } from './types';

/**
 * Manages context from skills and AGENTS.md files
 * Formats context for injection into system prompts
 */
export class ContextManager {
  private scanner: ContextScanner;
  private skills: Map<string, Skill> = new Map();
  private agentsMdFiles: Map<string, AgentsMd> = new Map();

  constructor() {
    this.scanner = new ContextScanner();

    // Listen for context changes
    this.scanner.onDidChangeContext(() => {
      this.refreshFromScanner();
    });
  }

  /**
   * Initialize the context manager by scanning the workspace
   */
  async initialize(): Promise<void> {
    await this.scanner.scanWorkspace();
    this.scanner.startWatching();
    this.refreshFromScanner();
  }

  /**
   * Refresh local caches from the scanner
   */
  private refreshFromScanner(): void {
    // Preserve enabled state when refreshing
    const skills = this.scanner.getSkills();
    for (const skill of skills) {
      const existing = this.skills.get(skill.sourcePath);
      if (existing) {
        skill.enabled = existing.enabled;
      }
      this.skills.set(skill.sourcePath, skill);
    }

    // Remove skills that no longer exist
    const currentPaths = new Set(skills.map((s) => s.sourcePath));
    for (const path of this.skills.keys()) {
      if (!currentPaths.has(path)) {
        this.skills.delete(path);
      }
    }

    // Update AGENTS.md files
    this.agentsMdFiles.clear();
    for (const agentsMd of this.scanner.getAgentsMdFiles()) {
      this.agentsMdFiles.set(agentsMd.path, agentsMd);
    }
  }

  /**
   * Get all skills
   */
  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get enabled skills only
   */
  getEnabledSkills(): Skill[] {
    return Array.from(this.skills.values()).filter((s) => s.enabled);
  }

  /**
   * Get all AGENTS.md files
   */
  getAgentsMdFiles(): AgentsMd[] {
    return Array.from(this.agentsMdFiles.values());
  }

  /**
   * Enable or disable a skill by its source path
   */
  setSkillEnabled(sourcePath: string, enabled: boolean): void {
    const skill = this.skills.get(sourcePath);
    if (skill) {
      skill.enabled = enabled;
    }
  }

  /**
   * Get the system prompt addition with all enabled context
   */
  getSystemPromptAddition(): string {
    const enabledSkills = this.getEnabledSkills();
    const agentsMdFiles = this.getAgentsMdFiles();

    const parts: string[] = [];

    // Add skills section
    if (enabledSkills.length > 0) {
      parts.push('## Available Skills\n');
      for (const skill of enabledSkills) {
        parts.push(`### ${skill.name}`);
        if (skill.description) {
          parts.push(skill.description);
        }
        if (skill.content) {
          parts.push(skill.content);
        }
        parts.push('');
      }
    }

    // Add AGENTS.md section
    if (agentsMdFiles.length > 0) {
      parts.push('## Project Context (AGENTS.md & Rules)\n');
      for (const agentsMd of agentsMdFiles) {
        parts.push(`### ${agentsMd.projectName}`);
        parts.push(agentsMd.content);
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  /**
   * Get the full context injection object
   */
  getContextInjection(): ContextInjection {
    return {
      systemPromptAddition: this.getSystemPromptAddition(),
      skills: this.getSkills(),
      agentsMd: this.getAgentsMdFiles(),
    };
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.scanner.dispose();
  }
}
