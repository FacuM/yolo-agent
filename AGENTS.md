# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
npm run compile      # One-shot esbuild build
npm run watch        # Incremental rebuild on file changes
npm run lint         # ESLint (eslint src/)
npm run test:e2e     # VS Code integration tests (mocha, requires compiled output)
```

To run the extension: `npm install && npm run compile`, then press **F5** in VS Code to launch the Extension Development Host.

Build uses **esbuild** (not tsc). See `esbuild.js` for config — it produces two bundles: the extension (`out/extension.js`) and the test suite (`out/test/e2e/`). TypeScript compilation via tsc is only used for type-checking, not for producing output.

Tests are e2e only (no unit tests). They run inside a real VS Code instance via `@vscode/test-electron` with Mocha TDD UI and 30s timeout. Config in `.vscode-test.mjs`.

## Architecture

This is a **VS Code extension** providing an AI coding agent in the sidebar. The core design follows the VS Code extension host ↔ webview split:

- **Extension host** (Node.js): `src/extension.ts` activates managers, registers `ChatViewProvider`, and wires up tools/providers/sessions.
- **Webview** (`src/webview/ui/main.js` + `styles.css`): Renders the chat UI. Communicates with the extension host via `postMessage`/`onDidReceiveMessage`.

### Central Orchestrator: `panel.ts`

[src/webview/panel.ts](src/webview/panel.ts) (`ChatViewProvider`) is the largest and most critical file. It owns:
- The **LLM tool-calling loop** (`sendOneLLMRound`): streams LLM responses, executes tool calls, loops up to `MAX_TOOL_ITERATIONS=25`, with anti-spinning detection (tracks call signatures, detects non-productive rounds, sends nudge messages, force-breaks after 2 nudges).
- The **Smart To-Do flow** (`runSmartTodoFlow`): a 3-phase orchestration loop — (1) Planning (isolated LLM call, no tools, produces a `plan` block), (2) Execution (`sendOneLLMRound` with tools), (3) Verification (isolated LLM call, parses `verification` block). Failed TODOs loop back to execution, up to `maxIterations=5`.
- All webview message routing (dozens of message types).

### Key Subsystems

- **Providers** (`src/providers/`): All implement `LLMProvider` interface (`sendMessage`, `listModels`, `validateApiKey`). Five providers: Anthropic, ClaudeCode (reads `~/.claude/credentials.json`), OpenAI, OpenAI-compatible, KiloGateway. Profiles/API keys stored in VS Code `globalState`/`SecretStorage` via `ProfileManager`.
- **Tools** (`src/tools/`): Each tool has a `{definition, execute()}` shape. Tools: ReadFile, WriteFile, ListFiles, RunTerminal (with real-time streaming + stall detection), GetDiagnostics, AskQuestion (pauses the agent loop for user input), and sandbox tools (Create/Switch/Status/Exit/RunSandboxedCommand).
- **Modes** (`src/modes/`): Six built-in modes (Sandboxed Smart To-Do, Smart To-Do, Sandbox Orchestrator, Agent, Plan, Ask) defined in `presets.ts`. Each mode specifies a system prompt and `toolPermissions` map (`allow`/`deny`/`read-only`). `ModeManager` filters available tools based on active mode.
- **Sandbox** (`src/sandbox/manager.ts`): Two isolation layers — (1) command validation (blocks dangerous patterns like sudo, rm -rf /, etc.), (2) OS-level via bubblewrap (`bwrap`) creating Linux namespaces with restricted filesystem. Uses **git worktrees** for branch isolation.
- **Sessions** (`src/sessions/manager.ts`): Multi-session support with independent history, message buffer (for background sessions), Smart To-Do state, and status tracking per session.
- **MCP** (`src/mcp/`): Client connects to MCP servers via stdio/SSE. `McpToolBridge` wraps MCP tools into the same `Tool` interface used by built-in tools. Server configs persisted in `globalState` via `McpConfigManager`.
- **Context** (`src/context/`): `ContextScanner` watches `.kilo/`, `.claude/`, `.cline/` directories for skill files and `AGENTS.md` files. `ContextManager` formats discovered context for injection into LLM system prompts.

### Data Flow

```
User message → Webview postMessage → panel.ts handleSendMessage()
  → Smart To-Do mode?
    → Yes: runSmartTodoFlow() (plan → execute → verify loop)
    → No:  sendOneLLMRound() (direct tool-calling loop)
  → Provider.sendMessage() streams chunks back → webview renders
  → Tool calls executed → results fed back to LLM → loop continues
```

### Runtime State

No config files on disk for runtime settings. Everything persists in VS Code:
- Provider profiles: `globalState` key `yoloAgent.profiles`
- API keys: `SecretStorage` with prefix `yoloAgent.apiKey.`
- Active mode/provider/model: `globalState` keys `currentMode`, `activeProviderId`, `activeModelId`

## Key Conventions

- 100% of code was AI-generated (Claude Opus 4.6 and GLM 5). The codebase is experimental.
- The webview JS (`main.js`) and CSS (`styles.css`) are large single files — not built from a framework. Direct DOM manipulation.
- `panel.ts` is ~83KB. Changes here require careful understanding of message routing and the LLM loop state machine.
- External dependency: `bwrap` (bubblewrap) is an optional Linux-only binary for OS-level sandboxing.
- VS Code engine minimum: `1.96.0`.

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:
- Invoke: `npx openskills read <skill-name>` (run in your shell)
  - For multiple: `npx openskills read skill-one,skill-two`
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
</usage>

<available_skills>

<skill>
<name>agent-development</name>
<description>This skill should be used when the user asks to "create an agent", "add an agent", "write a subagent", "agent frontmatter", "when to use description", "agent examples", "agent tools", "agent colors", "autonomous agent", or needs guidance on agent structure, system prompts, triggering conditions, or agent development best practices for Claude Code plugins.</description>
<location>project</location>
</skill>

<skill>
<name>assistant</name>
<description>Main skill for all Pinecone Assistant operations. Read this first! Create, manage, and chat with Pinecone Assistants for document Q&A. Automatically recognizes natural language requests like "create an assistant from my docs" or "ask my assistant about authentication" without requiring slash commands. ALWAYS invoke when using Pinecone Assistant related commands</description>
<location>project</location>
</skill>

<skill>
<name>brainstorming</name>
<description>"You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation."</description>
<location>project</location>
</skill>

<skill>
<name>browsing</name>
<description>Use when you need direct browser control - teaches Chrome DevTools Protocol for controlling existing browser sessions, multi-tab management, form automation, and content extraction via use_browser MCP tool</description>
<location>project</location>
</skill>

<skill>
<name>claude-automation-recommender</name>
<description>Analyze a codebase and recommend Claude Code automations (hooks, subagents, skills, plugins, MCP servers). Use when user asks for automation recommendations, wants to optimize their Claude Code setup, mentions improving Claude Code workflows, asks how to first set up Claude Code for a project, or wants to know what Claude Code features they should use.</description>
<location>project</location>
</skill>

<skill>
<name>claude-md-improver</name>
<description>Audit and improve CLAUDE.md files in repositories. Use when user asks to check, audit, update, improve, or fix CLAUDE.md files. Scans for all CLAUDE.md files, evaluates quality against templates, outputs quality report, then makes targeted updates. Also use when the user mentions "CLAUDE.md maintenance" or "project memory optimization".</description>
<location>project</location>
</skill>

<skill>
<name>code-connect-components</name>
<description>Connects Figma design components to code components using Code Connect. Use when user says "code connect", "connect this component to code", "connect Figma to code", "map this component", "link component to code", "create code connect mapping", "add code connect", "connect design to code", or wants to establish mappings between Figma designs and code implementations. Requires Figma MCP server connection.</description>
<location>project</location>
</skill>

<skill>
<name>command-development</name>
<description>This skill should be used when the user asks to "create a slash command", "add a command", "write a custom command", "define command arguments", "use command frontmatter", "organize commands", "create command with file references", "interactive command", "use AskUserQuestion in command", or needs guidance on slash command structure, YAML frontmatter fields, dynamic arguments, bash execution in commands, user interaction patterns, or command development best practices for Claude Code.</description>
<location>project</location>
</skill>

<skill>
<name>create-design-system-rules</name>
<description>Generates custom design system rules for the user's codebase. Use when user says "create design system rules", "generate rules for my project", "set up design rules", "customize design system guidelines", or wants to establish project-specific conventions for Figma-to-code workflows. Requires Figma MCP server connection.</description>
<location>project</location>
</skill>

<skill>
<name>developing-claude-code-plugins</name>
<description>Use when working on Claude Code plugins (creating, modifying, testing, releasing, or maintaining) - provides streamlined workflows, patterns, and examples for the complete plugin lifecycle</description>
<location>project</location>
</skill>

<skill>
<name>dispatching-parallel-agents</name>
<description>Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies</description>
<location>project</location>
</skill>

<skill>
<name>example-skill</name>
<description>This skill should be used when the user asks to "demonstrate skills", "show skill format", "create a skill template", or discusses skill development patterns. Provides a reference template for creating Claude Code plugin skills.</description>
<location>project</location>
</skill>

<skill>
<name>executing-plans</name>
<description>Use when you have a written implementation plan to execute in a separate session with review checkpoints</description>
<location>project</location>
</skill>

<skill>
<name>finding-duplicate-functions</name>
<description>Use when auditing a codebase for semantic duplication - functions that do the same thing but have different names or implementations. Especially useful for LLM-generated codebases where new functions are often created rather than reusing existing ones.</description>
<location>project</location>
</skill>

<skill>
<name>finishing-a-development-branch</name>
<description>Use when implementation is complete, all tests pass, and you need to decide how to integrate the work - guides completion of development work by presenting structured options for merge, PR, or cleanup</description>
<location>project</location>
</skill>

<skill>
<name>frontend-design</name>
<description>Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.</description>
<location>project</location>
</skill>

<skill>
<name>hf-mcp</name>
<description>Use Hugging Face Hub via MCP server tools. Search models, datasets, Spaces, papers. Get repo details, fetch documentation, run compute jobs, and use Gradio Spaces as AI tools. Available when connected to the HF MCP server.</description>
<location>project</location>
</skill>

<skill>
<name>hook-development</name>
<description>This skill should be used when the user asks to "create a hook", "add a PreToolUse/PostToolUse/Stop hook", "validate tool use", "implement prompt-based hooks", "use ${CLAUDE_PLUGIN_ROOT}", "set up event-driven automation", "block dangerous commands", or mentions hook events (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification). Provides comprehensive guidance for creating and implementing Claude Code plugin hooks with focus on advanced prompt-based hooks API.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-cli</name>
<description>Execute Hugging Face Hub operations using the `hf` CLI. Use when the user needs to download models/datasets/spaces, upload files to Hub repositories, create repos, manage local cache, or run compute jobs on HF infrastructure. Covers authentication, file transfers, repository creation, cache operations, and cloud compute.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-datasets</name>
<description>Create and manage datasets on Hugging Face Hub. Supports initializing repos, defining configs/system prompts, streaming row updates, and SQL-based dataset querying/transformation. Designed to work alongside HF MCP server for comprehensive dataset workflows.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-evaluation</name>
<description>Add and manage evaluation results in Hugging Face model cards. Supports extracting eval tables from README content, importing scores from Artificial Analysis API, and running custom model evaluations with vLLM/lighteval. Works with the model-index metadata format.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-jobs</name>
<description>This skill should be used when users want to run any workload on Hugging Face Jobs infrastructure. Covers UV scripts, Docker-based jobs, hardware selection, cost estimation, authentication with tokens, secrets management, timeout configuration, and result persistence. Designed for general-purpose compute workloads including data processing, inference, experiments, batch jobs, and any Python-based tasks. Should be invoked for tasks involving cloud compute, GPU workloads, or when users mention running jobs on Hugging Face infrastructure without local setup.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-model-trainer</name>
<description>This skill should be used when users want to train or fine-tune language models using TRL (Transformer Reinforcement Learning) on Hugging Face Jobs infrastructure. Covers SFT, DPO, GRPO and reward modeling training methods, plus GGUF conversion for local deployment. Includes guidance on the TRL Jobs package, UV scripts with PEP 723 format, dataset preparation and validation, hardware selection, cost estimation, Trackio monitoring, Hub authentication, and model persistence. Should be invoked for tasks involving cloud GPU training, GGUF conversion, or when users mention training on Hugging Face Jobs without local GPU setup.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-paper-publisher</name>
<description>Publish and manage research papers on Hugging Face Hub. Supports creating paper pages, linking papers to models/datasets, claiming authorship, and generating professional markdown-based research articles.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-tool-builder</name>
<description>Use this skill when the user wants to build tool/scripts or achieve a task where using data from the Hugging Face API would help. This is especially useful when chaining or combining API calls or the task will be repeated/automated. This Skill creates a reusable script to fetch, enrich or process data.</description>
<location>project</location>
</skill>

<skill>
<name>hugging-face-trackio</name>
<description>Track and visualize ML training experiments with Trackio. Use when logging metrics during training (Python API) or retrieving/analyzing logged metrics (CLI). Supports real-time dashboard visualization, HF Space syncing, and JSON output for automation.</description>
<location>project</location>
</skill>

<skill>
<name>implement-design</name>
<description>Translates Figma designs into production-ready code with 1:1 visual fidelity. Use when implementing UI from Figma files, when user mentions "implement design", "generate code", "implement component", "build Figma design", provides Figma URLs, or asks to build components matching Figma specs. Requires Figma MCP server connection.</description>
<location>project</location>
</skill>

<skill>
<name>knowledge-base-generator</name>
<description>Detects when an agent is stuck in a loop hitting the same error or issue repeatedly, then searches the internet (via search-capable MCPs) for matching GitHub issues and known workarounds. Automatically creates or updates an AGENTS.md knowledge base with links and solutions. Triggers on repeated failures, "Same issue" appearing twice, agent looping on the same error, recurring error messages, "still failing", "same error again", "stuck on the same problem".</description>
<location>project</location>
</skill>

<skill>
<name>mcp-cli</name>
<description>Use MCP servers on-demand via the mcp CLI tool - discover tools, resources, and prompts without polluting context with pre-loaded MCP integrations</description>
<location>project</location>
</skill>

<skill>
<name>mcp-integration</name>
<description>This skill should be used when the user asks to "add MCP server", "integrate MCP", "configure MCP in plugin", "use .mcp.json", "set up Model Context Protocol", "connect external service", mentions "${CLAUDE_PLUGIN_ROOT} with MCP", or discusses MCP server types (SSE, stdio, HTTP, WebSocket). Provides comprehensive guidance for integrating Model Context Protocol servers into Claude Code plugins for external tool and service integration.</description>
<location>project</location>
</skill>

<skill>
<name>php-optimization-engineer</name>
<description>Automatically analyzes and optimizes PHP code by identifying performance bottlenecks, memory issues, and applying fixes directly to files. Creates backups before modifications and provides rollback instructions. Use when user wants to optimize PHP code, improve performance, reduce memory usage, refactor for efficiency, profile code, or investigate deeper into performance issues. Triggers on "optimize PHP", "PHP performance", "slow PHP script", "PHP memory issue", "improve PHP code", "PHP bottleneck", "PHP refactoring", "profile PHP", "PHP profiler", "profile code", "investigate performance", "performance investigation", "debug performance", "analyze performance".</description>
<location>project</location>
</skill>

<skill>
<name>playground</name>
<description>Creates interactive HTML playgrounds — self-contained single-file explorers that let users configure something visually through controls, see a live preview, and copy out a prompt. Use when the user asks to make a playground, explorer, or interactive tool for a topic.</description>
<location>project</location>
</skill>

<skill>
<name>plugin-settings</name>
<description>This skill should be used when the user asks about "plugin settings", "store plugin configuration", "user-configurable plugin", ".local.md files", "plugin state files", "read YAML frontmatter", "per-project plugin settings", or wants to make plugin behavior configurable. Documents the .claude/plugin-name.local.md pattern for storing plugin-specific configuration with YAML frontmatter and markdown content.</description>
<location>project</location>
</skill>

<skill>
<name>plugin-structure</name>
<description>This skill should be used when the user asks to "create a plugin", "scaffold a plugin", "understand plugin structure", "organize plugin components", "set up plugin.json", "use ${CLAUDE_PLUGIN_ROOT}", "add commands/agents/skills/hooks", "configure auto-discovery", or needs guidance on plugin directory layout, manifest configuration, component organization, file naming conventions, or Claude Code plugin architecture best practices.</description>
<location>project</location>
</skill>

<skill>
<name>receiving-code-review</name>
<description>Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation</description>
<location>project</location>
</skill>

<skill>
<name>remembering-conversations</name>
<description>Use when user asks 'how should I...' or 'what's the best approach...' after exploring code, OR when you've tried to solve something and are stuck, OR for unfamiliar workflows, OR when user references past work. Searches conversation history.</description>
<location>project</location>
</skill>

<skill>
<name>requesting-code-review</name>
<description>Use when completing tasks, implementing major features, or before merging to verify work meets requirements</description>
<location>project</location>
</skill>

<skill>
<name>skill-creator</name>
<description>Create new skills, improve existing skills, and measure skill performance. Use when users want to create a skill from scratch, update or optimize an existing skill, run evals to test a skill, or benchmark skill performance with variance analysis.</description>
<location>project</location>
</skill>

<skill>
<name>skill-development</name>
<description>This skill should be used when the user wants to "create a skill", "add a skill to plugin", "write a new skill", "improve skill description", "organize skill content", or needs guidance on skill structure, progressive disclosure, or skill development best practices for Claude Code plugins.</description>
<location>project</location>
</skill>

<skill>
<name>slack-messaging</name>
<description>Use when asked to send or read Slack messages, check Slack channels, test Slack integrations, or interact with a Slack workspace from the command line.</description>
<location>project</location>
</skill>

<skill>
<name>stripe-best-practices</name>
<description>Best practices for building Stripe integrations. Use when implementing payment processing, checkout flows, subscriptions, webhooks, Connect platforms, or any Stripe API integration.</description>
<location>project</location>
</skill>

<skill>
<name>subagent-driven-development</name>
<description>Use when executing implementation plans with independent tasks in the current session</description>
<location>project</location>
</skill>

<skill>
<name>systematic-debugging</name>
<description>Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes</description>
<location>project</location>
</skill>

<skill>
<name>test-driven-development</name>
<description>Use when implementing any feature or bugfix, before writing implementation code</description>
<location>project</location>
</skill>

<skill>
<name>using-git-worktrees</name>
<description>Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification</description>
<location>project</location>
</skill>

<skill>
<name>using-superpowers</name>
<description>Use when starting any conversation - establishes how to find and use skills, requiring Skill tool invocation before ANY response including clarifying questions</description>
<location>project</location>
</skill>

<skill>
<name>using-tmux-for-interactive-commands</name>
<description>Use when you need to run interactive CLI tools (vim, git rebase -i, Python REPL, etc.) that require real-time input/output - provides tmux-based approach for controlling interactive sessions through detached sessions and send-keys</description>
<location>project</location>
</skill>

<skill>
<name>verification-before-completion</name>
<description>Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always</description>
<location>project</location>
</skill>

<skill>
<name>workflow</name>
<description>Use when demonstrating plugin workflow features - shows how skills can guide multi-step processes</description>
<location>project</location>
</skill>

<skill>
<name>working-with-claude-code</name>
<description>Use when working with Claude Code CLI, plugins, hooks, MCP servers, skills, configuration, or any Claude Code feature - provides comprehensive official documentation for all aspects of Claude Code</description>
<location>project</location>
</skill>

<skill>
<name>writing-plans</name>
<description>Use when you have a spec or requirements for a multi-step task, before touching code</description>
<location>project</location>
</skill>

<skill>
<name>writing-rules</name>
<description>This skill should be used when the user asks to "create a hookify rule", "write a hook rule", "configure hookify", "add a hookify rule", or needs guidance on hookify rule syntax and patterns.</description>
<location>project</location>
</skill>

<skill>
<name>writing-skills</name>
<description>Use when creating new skills, editing existing skills, or verifying skills work before deployment</description>
<location>project</location>
</skill>

<skill>
<name>youtube-step-extractor</name>
<description>Extract frames from a YouTube video and analyze them to identify a sequence of steps. Use when user provides a YouTube URL and wants to understand the process, tutorial, or workflow shown in the video by examining its visual content frame-by-frame. Triggers on "extract steps from video", "what steps does this video show", "analyze YouTube tutorial", "screenshot a video", "figure out the steps".</description>
<location>project</location>
</skill>

</available_skills>
<!-- SKILLS_TABLE_END -->

</skills_system>
