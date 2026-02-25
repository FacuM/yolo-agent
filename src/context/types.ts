/**
 * Represents a skill loaded from a markdown file in .yolo-agent/skills/
 */
export interface Skill {
  /** The name of the skill (from filename or YAML frontmatter) */
  name: string;
  /** Human-readable description of what the skill does */
  description: string;
  /** The markdown content of the skill file */
  content: string;
  /** Absolute path to the skill source file */
  sourcePath: string;
  /** Tags for categorizing the skill */
  tags: string[];
  /** Whether this skill is currently enabled for injection */
  enabled: boolean;
}

/**
 * Represents an AGENTS.md file found in the workspace
 */
export interface AgentsMd {
  /** Absolute path to the AGENTS.md file */
  path: string;
  /** The content of the AGENTS.md file */
  content: string;
  /** The name of the project/folder containing AGENTS.md */
  projectName: string;
}

/**
 * Represents a memory bank markdown file discovered in the workspace.
 */
export interface MemoryBank {
  /** Absolute path to the memory bank file */
  path: string;
  /** Full markdown content */
  content: string;
  /** Project/folder label */
  projectName: string;
}

/**
 * Controls which discovered context sections are injected into system prompts.
 */
export interface ContextPromptOptions {
  includeSkills: boolean;
  includeAgentsMd: boolean;
  includeMemoryBanks: boolean;
}

/**
 * The formatted context injection for the system prompt
 */
export interface ContextInjection {
  /** The formatted text to add to the system prompt */
  systemPromptAddition: string;
  /** All discovered skills (including disabled ones) */
  skills: Skill[];
  /** All discovered AGENTS.md files */
  agentsMd: AgentsMd[];
  /** All discovered memory-bank files */
  memoryBanks: MemoryBank[];
}
