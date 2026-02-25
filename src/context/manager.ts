import * as vscode from 'vscode';
import { ContextScanner } from './scanner';
import { Skill, AgentsMd, MemoryBank, ContextInjection } from './types';

/**
 * Manages context from skills and AGENTS.md files
 * Formats context for injection into system prompts
 */
export class ContextManager {
  private scanner: ContextScanner;
  private skills: Map<string, Skill> = new Map();
  private agentsMdFiles: Map<string, AgentsMd> = new Map();
  private memoryBanks: Map<string, MemoryBank> = new Map();

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

    // Update memory bank files
    this.memoryBanks.clear();
    for (const memoryBank of this.scanner.getMemoryBankFiles()) {
      this.memoryBanks.set(memoryBank.path, memoryBank);
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
   * Get all discovered memory-bank files.
   */
  getMemoryBanks(): MemoryBank[] {
    return Array.from(this.memoryBanks.values());
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
   * Maximum characters allowed for the context addition injected into the system prompt.
   * ~100K chars ≈ ~25K tokens — leaves plenty of room for the base system prompt,
   * tool definitions, and conversation history.
   */
  private static readonly MAX_CONTEXT_CHARS = 100_000;

  /**
   * Maximum characters for a single skill / AGENTS.md file.
   */
  private static readonly MAX_SINGLE_FILE_CHARS = 30_000;

  /**
   * Extract trigger phrases from a skill description.
   * Looks for quoted strings like "create an agent", "add a hook", etc.
   * Also splits on commas to catch keyword lists.
   */
  private static extractTriggers(description: string): string[] {
    const triggers: string[] = [];

    // Extract quoted phrases: "create an agent", 'add a hook'
    const quotedRegex = /["']([^"']{3,})["']/g;
    let match;
    while ((match = quotedRegex.exec(description)) !== null) {
      triggers.push(match[1].toLowerCase().trim());
    }

    // If no quoted phrases, fall back to splitting the first sentence by commas
    // and using significant words (3+ chars)
    if (triggers.length === 0 && description) {
      const firstSentence = description.split('.')[0];
      const words = firstSentence
        .toLowerCase()
        .split(/[,;|]+/)
        .map(w => w.trim())
        .filter(w => w.length >= 4);
      triggers.push(...words);
    }

    return triggers;
  }

  /**
   * Check if a user message matches any triggers for a skill.
   */
  private static matchesTriggers(userMessage: string, triggers: string[]): boolean {
    if (triggers.length === 0) { return false; }
    const lowerMessage = userMessage.toLowerCase();
    return triggers.some(trigger => lowerMessage.includes(trigger));
  }

  /**
   * Get the system prompt addition with context.
   * Skills whose trigger keywords match the user message get their full content injected.
   * All other enabled skills appear as a lightweight name + description index.
   *
   * @param userMessage — The current user message (used for keyword matching)
   */
  getSystemPromptAddition(userMessage?: string): string {
    const enabledSkills = this.getEnabledSkills();
    const agentsMdFiles = this.getAgentsMdFiles();
    const memoryBanks = this.getMemoryBanks();

    const parts: string[] = [];
    let totalChars = 0;

    const addPart = (text: string): boolean => {
      if (totalChars + text.length > ContextManager.MAX_CONTEXT_CHARS) {
        return false; // budget exhausted
      }
      parts.push(text);
      totalChars += text.length;
      return true;
    };

    // Add memory bank context first so long-lived project facts are always visible.
    if (memoryBanks.length > 0) {
      addPart('## Memory Bank (Persistent Project Knowledge)\n');
      for (const memoryBank of memoryBanks) {
        const header = `### ${memoryBank.projectName} (${memoryBank.path})`;
        const body = memoryBank.content.slice(0, ContextManager.MAX_SINGLE_FILE_CHARS);
        if (!addPart(header + '\n' + body + '\n')) { break; }
      }
    }

    // Partition skills into triggered (full content) vs. indexed (summary only)
    const triggeredSkills: Skill[] = [];
    const indexedSkills: Skill[] = [];

    for (const skill of enabledSkills) {
      if (userMessage) {
        const triggers = ContextManager.extractTriggers(skill.description);
        // Also match skill name itself
        const nameMatch = userMessage.toLowerCase().includes(skill.name.toLowerCase());
        if (nameMatch || ContextManager.matchesTriggers(userMessage, triggers)) {
          triggeredSkills.push(skill);
          continue;
        }
      }
      indexedSkills.push(skill);
    }

    // Inject full content for triggered skills
    if (triggeredSkills.length > 0) {
      addPart('## Active Skills (matched by your message)\n');
      for (const skill of triggeredSkills) {
        const header = `### ${skill.name}`;
        const desc = skill.description ? `\n${skill.description}` : '';
        const content = skill.content
          ? `\n${skill.content.slice(0, ContextManager.MAX_SINGLE_FILE_CHARS)}`
          : '';
        if (!addPart(header + desc + content + '\n')) { break; }
      }
    }

    // Lightweight index for all other enabled skills
    if (indexedSkills.length > 0) {
      addPart('\n## Available Skills (mention by name or keyword to activate)\n');
      for (const skill of indexedSkills) {
        const line = `- **${skill.name}**: ${skill.description || '(no description)'}`;
        if (!addPart(line + '\n')) { break; }
      }
    }

    // Add AGENTS.md section with per-file size cap
    if (agentsMdFiles.length > 0) {
      addPart('\n## Project Context (AGENTS.md & Rules)\n');
      for (const agentsMd of agentsMdFiles) {
        const truncatedContent = agentsMd.content.slice(0, ContextManager.MAX_SINGLE_FILE_CHARS);
        const header = `### ${agentsMd.projectName}`;
        if (!addPart(header + '\n' + truncatedContent + '\n')) { break; }
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
      memoryBanks: this.getMemoryBanks(),
    };
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.scanner.dispose();
  }
}
