import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { ProfileManager } from '../providers/profile-manager';
import { Tool } from '../tools/types';
import { ModeManager } from '../modes/manager';
import { ModeId } from '../modes/types';
import { ContextManager } from '../context/manager';
import { McpConfigManager } from '../mcp/config';
import { McpClient } from '../mcp/client';
import { McpServerConfig } from '../mcp/types';
import { SessionManager, BufferedMessage, TodoItem, TodoItemStatus, SmartTodoPlan } from '../sessions/manager';
import { ChatMessage, ToolResult as ProviderToolResult } from '../providers/types';
import { AskQuestionTool } from '../tools/question';
import { ExitPlanningModeTool } from '../tools/planning';
import { RunTerminalTool } from '../tools/terminal';
import { LoopDetector } from '../tools/loop-detector';
import { SandboxManager } from '../sandbox/manager';
import { getCompactionSettings, saveCompactionSettings } from '../config/settings';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'yoloAgent.chatView';

  // ===== Smart To-Do prompt templates =====
  private static readonly SMART_TODO_PLANNING_PROMPT = `You are a meticulous software engineering planner.

IMPORTANT RULES — YOU MUST FOLLOW ALL OF THEM:
- If the request is clear enough to plan, produce a plan immediately. Make reasonable assumptions for anything unclear.
- If the request is genuinely ambiguous or missing critical information, you MAY ask clarifying questions INSTEAD of a plan. Format them inside a \`\`\`questions block:

\`\`\`questions
1. <Your question here?>
2. <Another question?>
\`\`\`

- If you produce a plan, you MUST include a \`\`\`plan code block.
- Do NOT mix questions and a plan in the same response — pick one.
- Do NOT explain your reasoning, just output the plan or questions.
- Do NOT use any tools — only output text.
- Do NOT start implementing — only plan.

When producing a plan, use EXACTLY this format:

\`\`\`plan
TODO 1: <Short title> — <Brief description of what must be done>
TODO 2: <Short title> — <Brief description of what must be done>
TODO 3: <Short title> — <Brief description of what must be done>
\`\`\`

Each TODO must be independently verifiable (e.g., "file X exists", "function Y works").
Keep titles concise (under 10 words).
Include an E2E / integration verification step as the last TODO.
For trivial requests, a single TODO is fine — do NOT over-split.`;

  private static readonly SMART_TODO_EXECUTION_PROMPT = `You are an expert AI coding assistant operating in Smart To-Do mode. You have a plan to follow.

**Your plan:**
{PLAN}

**Instructions:**
- Work through the TODO items IN ORDER, starting with the first pending item.
- IMMEDIATELY start creating files and running commands. Do NOT spend time listing files or diagnosing — ACT.
- Do exactly what the user requested and what the plan requires — nothing more, nothing less.
- Use writeFile to create and edit source files.
- Use runTerminal to run shell commands (npm, npx, git, build tools, etc.).
- Use readFile / listFiles only when you need to read EXISTING code you haven't seen yet.
- Prefer editing existing files over creating new files unless a new file is clearly required.
- Do NOT create markdown docs/README/changelogs unless explicitly requested by the user.
- After completing each item, say "TODO N: DONE" and move to the next one.
- Do NOT skip items. If one depends on another, complete the dependency first.
- When you finish all items, say "ALL TODOS COMPLETE".

CRITICAL RULES:
1. You have full tool access. Start writing code and running commands right away.
2. Do NOT loop on listFiles, getDiagnostics, or getSandboxStatus without producing files.
3. If a tool returns an error, READ the error message and follow its instructions. Then try an alternative tool.
4. For running commands: prefer runTerminal. Only use runSandboxedCommand if a sandbox has been created with createSandbox.
5. If you encounter "No sandbox is currently active" error, switch to runTerminal immediately.
6. Your FIRST tool call should be either writeFile or runTerminal — never a read-only tool.`;

  private static readonly SMART_TODO_VERIFY_PROMPT = `You are a QA verification assistant. You were given a plan and the AI attempted to complete it. Now verify the work.

**Original user request:**
{USER_REQUEST}

**Plan:**
{PLAN}

**Instructions:**
1. For EACH TODO item, verify whether it was actually completed based on the workspace files provided below.
2. Check that required files exist, contain the expected code, and look correct.
3. Respond with **exactly** this format for each item:

\`\`\`verification
TODO 1: DONE | <reason>
TODO 2: FAILED | <what's wrong or missing>
TODO 3: DONE | <reason>
...
\`\`\`

Rules:
- Use DONE if the item is fully and correctly implemented.
- Use FAILED if the item is missing, broken, or incomplete — explain why.
- Use IN-PROGRESS if partially done.
- After the verification block, summarize: which items pass, which need work.
- If all items are DONE, end with "ALL TODOS VERIFIED".
- You do NOT have access to tools. Base your verification ONLY on the workspace files shown below.`;

  /** Maximum tool-call ↔ LLM iterations within a single round */
  private static readonly MAX_TOOL_ITERATIONS = 25;

  /** Fraction of context window used before triggering auto-compaction */
  private static readonly CONTEXT_COMPACTION_THRESHOLD = 0.80;

  /** System prompt for compacting conversation context */
  private static readonly COMPACTION_PROMPT = `You are a context compaction assistant. Produce a concise but complete summary that preserves all information needed to continue the work without re-exploring the codebase.

Output format (use these exact headings):

## User Request
The original request and high-level goal. Quote the user's exact words when possible.

## Decisions Made
Key architectural and implementation decisions, with brief rationale.

## Work Completed
What has been done so far, with specific file paths and changes made.

## Remaining Work
What still needs to be done, prioritized.

## Failed Approaches
Approaches that were tried and DID NOT WORK, with the specific error or reason they failed. This section is CRITICAL — it prevents re-attempting the same broken approaches after compaction.

## Files and Symbols
Important file paths, function names, class names, and code patterns discovered. Include line numbers where relevant.

## Errors and Fixes
Errors encountered and how they were resolved (or if they remain unresolved).

## Context to Preserve
Any constraints, user preferences, environment details, or important context that would be lost without explicit preservation.

## Next Step
The single most important next action to take.

Keep each section compact and information-dense. This summary will replace the full conversation history, so nothing important should be omitted.`;

  // ===== Instance fields =====

  public view?: vscode.WebviewView;
  private registry: ProviderRegistry;
  private profileManager: ProfileManager;
  private modeManager: ModeManager;
  private tools: Map<string, Tool>;
  private extensionUri: vscode.Uri;
  private sessionManager: SessionManager;
  private abortControllers = new Map<string, AbortController>();
  private cancelledSessions = new Set<string>();
  private contextManager: ContextManager;
  private mcpConfigManager: McpConfigManager;
  private mcpClient: McpClient;
  private activeFileContext: { path: string; content: string } | null = null;
  private activeFileEnabled = false;
  private planningMode = false;
  private sandboxManager?: SandboxManager;
  private globalState: vscode.Memento;
  private compactionResolver: ((action: 'compacted' | 'cancelled') => void) | null = null;
  private compactionPendingSessionId: string | null = null;

  constructor(
    globalState: vscode.Memento,
    extensionUri: vscode.Uri,
    registry: ProviderRegistry,
    profileManager: ProfileManager,
    modeManager: ModeManager,
    tools: Map<string, Tool>,
    contextManager: ContextManager,
    mcpConfigManager: McpConfigManager,
    mcpClient: McpClient,
    sandboxManager?: SandboxManager
  ) {
    this.globalState = globalState;
    this.extensionUri = extensionUri;
    this.registry = registry;
    this.profileManager = profileManager;
    this.modeManager = modeManager;
    this.tools = tools;
    this.contextManager = contextManager;
    this.mcpConfigManager = mcpConfigManager;
    this.mcpClient = mcpClient;
    this.sandboxManager = sandboxManager;
    this.sessionManager = new SessionManager();

    // Notify webview whenever session list changes
    this.sessionManager.onDidChange = () => {
      this.sendSessionList();
    };
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        // Chat messages
        case 'sendMessage':
          await this.handleSendMessage(message.text, message.signal, message.fileReferences);
          break;
        case 'switchProvider':
          this.registry.setActiveProvider(message.providerId);
          await this.sendModelListForActiveProvider();
          break;
        case 'switchModel':
          this.registry.setActiveModelId(message.modelId);
          break;
        case 'getProviders':
          this.sendProviderList();
          break;
        case 'getModels':
          await this.sendModelList(message.providerId);
          break;
        case 'getModelsForActiveProvider':
          await this.sendModelListForActiveProvider();
          break;
        case 'cancelRequest':
          {
            const activeId = this.sessionManager.getActiveSessionId();
            if (activeId) {
              this.cancelledSessions.add(activeId);
              if (this.compactionPendingSessionId === activeId && this.compactionResolver) {
                this.compactionResolver('cancelled');
                this.compactionResolver = null;
                this.compactionPendingSessionId = null;
              }
              const ctrl = this.abortControllers.get(activeId);
              if (ctrl) {
                ctrl.abort();
                this.abortControllers.delete(activeId);
              }
              this.sessionManager.setSessionStatus(activeId, 'idle');
            }
            // Cancel any pending askQuestion tool
            const askToolCancel = this.tools.get('askQuestion');
            if (askToolCancel && (askToolCancel as unknown as AskQuestionTool).hasPendingQuestion()) {
              (askToolCancel as unknown as AskQuestionTool).cancelPending();
            }
            // Cancel any pending exitPlanningMode tool
            const exitPlanTool = this.tools.get('exitPlanningMode');
            if (exitPlanTool && (exitPlanTool as unknown as ExitPlanningModeTool).hasPendingDecision()) {
              (exitPlanTool as unknown as ExitPlanningModeTool).cancelPending();
            }
          }
          break;
        case 'newChat':
          this.handleNewChat();
          break;
        case 'getSessions':
          this.sendSessionList();
          break;
        case 'switchSession':
          this.handleSwitchSession(message.sessionId);
          break;
        case 'deleteSession':
          this.handleDeleteSession(message.sessionId);
          break;
        case 'getModes':
          this.handleGetModes();
          break;
        case 'togglePlanningMode':
          this.planningMode = !!message.enabled;
          this.postMessage({ type: 'planningModeChanged', enabled: this.planningMode });
          break;
        case 'proceedWithPlan':
          {
            // Disable planning mode — we're moving to implementation.
            this.planningMode = false;
            this.postMessage({ type: 'planningModeChanged', enabled: false });
            const planText = message.planText as string;
            if (planText && this.modeManager.isSmartTodoMode()) {
              // ── Smart To-Do shortcut ──
              // The user already has a fully-formed plan from the planning
              // phase.  Parse TODOs directly from it and jump straight into the
              // execute→verify loop, skipping the redundant LLM planning call
              // that would re-interpret the plan in an unpredictable format.
              const session = this.sessionManager.getOrCreateActiveSession(
                this.registry.getActiveProviderId(),
                this.registry.getActiveModelId(),
              );
              const sessionId = session.id;
              const userText = planText;

              // Save message & initialise Smart To-Do state
              this.sessionManager.addMessage(sessionId, { role: 'user', content: userText });
              this.sessionManager.initSmartTodo(sessionId, userText);

              const isSandboxed = this.modeManager.isSandboxedSmartTodoMode();
              const sandboxPreamble = isSandboxed
                ? `**SANDBOX MODE ACTIVE:** You are working inside a sandboxed environment. ` +
                  `Use runTerminal for running commands (it enforces software-level restrictions automatically). ` +
                  `If you need full OS-level isolation, first call createSandbox, then use runSandboxedCommand. ` +
                  `Do NOT call runSandboxedCommand unless you have called createSandbox first. ` +
                  `Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked.\n\n`
                : '';

              // Parse TODOs from the plan the user already approved
              let todos = this.parseTodosFromPlan(planText);
              if (todos.length === 0) {
                // Absolute fallback: treat the whole plan as a single task
                todos = [{ id: 1, title: 'Complete plan', status: 'pending' as TodoItemStatus, detail: planText }];
              }

              this.postSessionMessage(sessionId, {
                type: 'smartTodoUpdate',
                phase: 'executing',
                todos,
                iteration: 0,
              });

              try {
                await this.executePlanLoop(sessionId, userText, todos, sandboxPreamble);
              } catch (err) {
                if (!(err instanceof Error && err.message.includes('abort'))) {
                  this.postSessionMessage(sessionId, {
                    type: 'error',
                    message: `Smart To-Do loop error: ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
                this.cancelledSessions.delete(sessionId);
                this.sessionManager.setSessionStatus(sessionId, 'idle');
              }
            } else if (planText) {
              // Non-Smart-To-Do mode: send the plan as an implementation prompt
              const implementPrompt = `Implement the following plan. Follow it step by step, using the tools available to you. Do not ask for confirmation — just execute each step.\n\n---\n${planText}\n---`;
              await this.handleSendMessage(implementPrompt);
            }
          }
          break;
        case 'exitPlanningModeDecision':
          {
            const exitTool = this.tools.get('exitPlanningMode');
            if (exitTool && (exitTool as unknown as ExitPlanningModeTool).hasPendingDecision()) {
              const accepted = !!message.accepted;
              if (accepted) {
                this.planningMode = false;
                this.postMessage({ type: 'planningModeChanged', enabled: false });
              }
              (exitTool as unknown as ExitPlanningModeTool).resolveDecision(accepted);
            }
          }
          break;
        case 'setMode':
          if (message.modeId) {
            await this.modeManager.setCurrentMode(message.modeId as ModeId);
            this.postMessage({
              type: 'modeChanged',
              mode: this.modeManager.getCurrentMode(),
            });
          }
          break;

        // Profile CRUD messages
        case 'getProfiles':
          await this.sendProfiles();
          break;
        case 'saveProfile':
          await this.handleSaveProfile(message.profile, message.apiKey);
          break;
        case 'deleteProfile':
          await this.handleDeleteProfile(message.profileId);
          break;
        case 'validateApiKey':
          await this.handleValidateApiKey(message);
          break;
        case 'getModelsForProfile':
          await this.handleGetModelsForProfile(message);
          break;

        // Context messages
        case 'getContext':
          this.handleGetContext();
          break;
        case 'setSkillEnabled':
          this.handleSetSkillEnabled(message.sourcePath, message.enabled);
          break;

        // MCP messages
        case 'getMcpServers':
          this.handleGetMcpServers();
          break;
        case 'saveMcpServer':
          await this.handleSaveMcpServer(message.server);
          break;
        case 'deleteMcpServer':
          await this.handleDeleteMcpServer(message.serverId);
          break;
        case 'testMcpConnection':
          await this.handleTestMcpConnection(message.server);
          break;
        case 'openMcpGlobalSettings':
          await this.handleOpenMcpGlobalSettings();
          break;
        case 'openMcpWorkspaceSettings':
          await this.handleOpenMcpWorkspaceSettings();
          break;
        case 'compactContext':
          await this.handleCompactContext();
          break;
        case 'compactNow': {
          const targetSessionId = this.compactionPendingSessionId ?? this.sessionManager.getActiveSessionId();
          if (targetSessionId) {
            await this.performCompaction(targetSessionId);
            this.sendContextUsage(targetSessionId);
            this.postSessionMessage(targetSessionId, { type: 'compactionComplete' });
          }
          if (this.compactionResolver) {
            this.compactionResolver('compacted');
            this.compactionResolver = null;
          }
          this.compactionPendingSessionId = null;
          break;
        }
        case 'compactWithDigest': {
          const targetSessionId = this.compactionPendingSessionId ?? this.sessionManager.getActiveSessionId();
          if (targetSessionId && message.editedDigest) {
            await this.performCompactionWithDigest(targetSessionId, message.editedDigest);
            this.sendContextUsage(targetSessionId);
            this.postSessionMessage(targetSessionId, { type: 'compactionComplete' });
          }
          if (this.compactionResolver) {
            this.compactionResolver('compacted');
            this.compactionResolver = null;
          }
          this.compactionPendingSessionId = null;
          break;
        }
        case 'compactCancel':
          if (this.compactionResolver) {
            this.compactionResolver('cancelled');
            this.compactionResolver = null;
          }
          this.compactionPendingSessionId = null;
          break;
        case 'getCompactionSettings':
          this.postMessage({
            type: 'compactionSettings',
            ...getCompactionSettings(this.globalState),
          });
          break;
        case 'saveCompactionSettings':
          await saveCompactionSettings(this.globalState, {
            method: message.method,
            timeoutSeconds: message.timeoutSeconds,
          });
          this.postMessage({
            type: 'compactionSettings',
            ...getCompactionSettings(this.globalState),
          });
          break;

        // Active file context
        case 'toggleActiveFile':
          this.activeFileEnabled = !this.activeFileEnabled;
          this.postMessage({
            type: 'activeFileToggled',
            enabled: this.activeFileEnabled,
            file: this.activeFileContext?.path ?? null,
          });
          break;
        case 'getActiveFile':
          this.sendActiveFileState();
          break;

        // File reference search
        case 'searchFiles':
          await this.handleSearchFiles(message.query);
          break;
        case 'readFileReference':
          await this.handleReadFileReference(message.path);
          break;

        // Sandbox apply/discard
        case 'applySandbox':
          await this.handleApplySandbox();
          break;
        case 'discardSandbox':
          await this.handleDiscardSandbox();
          break;
      }
    });

    // Send initial data
    this.sendProviderList();
    this.handleGetModes();
    this.handleGetContext();
    this.sendSessionList();
    this.sendSandboxState();

    // Auto-restore the active session so the webview picks up where it left off
    const activeSession = this.sessionManager.getActiveSession();
    if (activeSession) {
      this.handleSwitchSession(activeSession.id);
    }

    // Re-send provider list after registry finishes re-initializing
    this.registry.onDidChangeProviders(() => {
      this.sendProviderList();
    });

    // Listen for sandbox state changes
    if (this.sandboxManager) {
      this.sandboxManager.onDidChangeSandbox(() => {
        this.sendSandboxState();
      });
    }

    // Track active editor for file context
    const updateActiveFile = (editor: vscode.TextEditor | undefined) => {
      if (editor && editor.document.uri.scheme === 'file') {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const fullPath = editor.document.uri.fsPath;
        const relativePath = workspaceFolder
          ? fullPath.replace(workspaceFolder.uri.fsPath + '/', '')
          : fullPath;
        this.activeFileContext = {
          path: relativePath,
          content: editor.document.getText(),
        };
      } else {
        this.activeFileContext = null;
      }
      this.sendActiveFileState();
    };

    // Listen for editor changes
    vscode.window.onDidChangeActiveTextEditor(updateActiveFile);
    // Set initial active file
    updateActiveFile(vscode.window.activeTextEditor);
  }

  // --- Chat handlers ---

  /**
   * Send a message to the active session's webview, or buffer it if the session is in the background.
   */
  private postSessionMessage(sessionId: string, message: Record<string, unknown>): void {
    if (this.sessionManager.isActiveSession(sessionId)) {
      this.postMessage(message);
    } else {
      this.sessionManager.bufferMessage(sessionId, message as BufferedMessage);
    }
  }

  private async handleSendMessage(text: string, signal?: unknown, fileReferences?: string[]): Promise<void> {
    const provider = this.registry.getActiveProvider();
    if (!provider) {
      this.postMessage({
        type: 'error',
        message: 'No active provider. Please add a provider in settings.',
      });
      return;
    }

    // Get or create the active session
    const session = this.sessionManager.getOrCreateActiveSession(
      this.registry.getActiveProviderId(),
      this.registry.getActiveModelId()
    );
    const sessionId = session.id;

    // Auto-title from first user message
    this.sessionManager.updateTitleFromMessage(sessionId, text);

    // --- Planning mode bypasses Smart To-Do ---
    // When the user has the Plan checkbox active, always do a direct LLM round
    // with a planning-focused system prompt, regardless of the current mode.
    if (this.planningMode) {
      this.cancelledSessions.delete(sessionId);
      const planningPrompt = `You are a software engineering planner. Your ONLY job is to produce a detailed implementation plan.

=== CRITICAL: READ-ONLY MODE ===
You are strictly prohibited from making changes:
- No creating files
- No editing files
- No deleting/moving/copying files
- No writing via shell redirection/heredocs
- No commands that change system state

You SHOULD use only read-only exploration tools to inspect the codebase and produce an accurate plan with real paths and existing patterns.

After gathering context, output your plan in the following structure:

## Goal
One-sentence summary of what will be implemented.

## Steps
For each step:
- **File**: exact path to create or modify
- **Change**: what to do (with code sketches when helpful)
- **Why**: brief rationale

## Risks & Edge Cases
Anything to watch out for.

## Verification
How to confirm the implementation works.

### Critical Files for Implementation
List 3-5 most critical files and one reason each.

IMPORTANT RULES:
- Do NOT attempt to create, write, or modify any files.
- Do NOT say "I'll implement this now" or similar — you are ONLY planning.
- Output ONLY the plan, no preamble or commentary before or after it.
- Be specific: reference real file paths and existing code you found.`;
      await this.sendOneLLMRound(sessionId, text, fileReferences, planningPrompt);
      return;
    }

    // --- Smart To-Do orchestration ---
    if (this.modeManager.isSmartTodoMode()) {
      // Check if we're resuming after clarification questions
      const smartTodo = this.sessionManager.getSmartTodo(sessionId);
      if (smartTodo && this.sessionManager.isAwaitingClarification(sessionId)) {
        await this.resumePlanningWithAnswers(sessionId, text, smartTodo);
        return;
      }

      await this.runSmartTodoFlow(sessionId, text, fileReferences);
      return;
    }

    // --- Check for pending askQuestion tool ---
    const askTool = this.tools.get('askQuestion');
    if (askTool && (askTool as unknown as AskQuestionTool).hasPendingQuestion()) {
      // The user is answering a question the LLM asked via the askQuestion tool.
      // Show the answer in the webview and resolve the pending promise.
      this.postSessionMessage(sessionId, { type: 'questionAnswered' });
      (askTool as unknown as AskQuestionTool).resolveAnswer(text);
      return;
    }

    // Clear any stale cancellation flag from a previous run
    this.cancelledSessions.delete(sessionId);

    // --- Normal flow ---
    await this.sendOneLLMRound(sessionId, text, fileReferences);
  }

  /**
   * Perform a single LLM round-trip: build messages, call provider, handle
   * tool calls, update session history. Shared by normal and smart-todo flows.
   */
  private async sendOneLLMRound(
    sessionId: string,
    userText: string,
    fileReferences?: string[],
    systemPromptOverride?: string,
    /** When true, read-only tools (listFiles, getDiagnostics, getSandboxStatus) are removed from the palette so weak LLMs cannot spin on them. */
    restrictReadOnlyTools?: boolean,
    /** When true, messages added to history are marked as internal (hidden from replay). */
    internal?: boolean,
  ): Promise<string> {
    const provider = this.registry.getActiveProvider()!;

    // Get allowed tools based on current mode
    const allToolNames = Array.from(this.tools.keys());
    let allowedToolNames = this.modeManager.getAllowedTools(allToolNames);

    // Filter out runSandboxedCommand when no sandbox is active — prevents the LLM
    // from calling a tool that will always fail and spinning in a loop.
    if (!this.sandboxManager?.getSandboxInfo().isActive) {
      allowedToolNames = allowedToolNames.filter(n => n !== 'runSandboxedCommand');
    }

    // Planning mode: restrict to read-only tools + exitPlanningMode + askQuestion
    if (this.planningMode) {
      const PLANNING_ALLOWED = new Set([
        'readFile', 'listFiles', 'getDiagnostics', 'getSandboxStatus',
        'askQuestion', 'exitPlanningMode',
      ]);
      allowedToolNames = allowedToolNames.filter(n => PLANNING_ALLOWED.has(n));
    }

    // During execution rounds, remove read-only tools so weak LLMs cannot spin
    // on listFiles/getDiagnostics/getSandboxStatus without ever writing files.
    // readFile is kept because the LLM may need to read existing code for modifications.
    if (restrictReadOnlyTools) {
      const EXECUTION_BLOCKED_TOOLS = new Set(['listFiles', 'getDiagnostics', 'getSandboxStatus']);
      allowedToolNames = allowedToolNames.filter(n => !EXECUTION_BLOCKED_TOOLS.has(n));
    }

    const allowedTools = allowedToolNames.map(name => this.tools.get(name)!.definition);

    // Build system prompt
    let modePrompt = systemPromptOverride ?? this.modeManager.getSystemPrompt();

    // Add context from skills and context files (AGENTS.md, .github/*.md, .*/rules/*.md)
    // Pass the user message so skill trigger keywords can be matched
    const contextAddition = this.contextManager.getSystemPromptAddition(userText);
    if (contextAddition) {
      modePrompt += '\n\n' + contextAddition;
    }

    // Add active file context if enabled
    if (this.activeFileEnabled && this.activeFileContext) {
      modePrompt += `\n\n--- Active File Context ---\nThe user currently has "${this.activeFileContext.path}" open. Its contents:\n\`\`\`\n${this.activeFileContext.content}\n\`\`\``;
    }

    // Add file references context
    if (fileReferences && fileReferences.length > 0) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const fileContents: string[] = [];
        for (const refPath of fileReferences) {
          try {
            const uri = vscode.Uri.joinPath(workspaceFolder.uri, refPath);
            const doc = await vscode.workspace.openTextDocument(uri);
            fileContents.push(`--- ${refPath} ---\n\`\`\`\n${doc.getText()}\n\`\`\``);
          } catch {
            fileContents.push(`--- ${refPath} ---\n(Could not read file)`);
          }
        }
        modePrompt += `\n\n--- Referenced Files ---\n${fileContents.join('\n\n')}`;
      }
    }

    const history = this.sessionManager.getHistory(sessionId);
    const messages: ChatMessage[] = [
      { role: 'system', content: modePrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    this.sessionManager.addMessage(sessionId, { role: 'user', content: userText, internal });
    this.sessionManager.setSessionStatus(sessionId, 'busy');

    const abortCtrl = new AbortController();
    this.abortControllers.set(sessionId, abortCtrl);

    let responseText = '';
    let firstChunkReceived = false;
    try {
      const model = this.registry.getActiveModelId();
      const requestOpts = { model, tools: allowedTools, signal: abortCtrl.signal };
      const onChunk = (chunk: string) => {
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          this.postSessionMessage(sessionId, { type: 'apiResponseStarted' });
        }
        this.postSessionMessage(sessionId, { type: 'streamChunk', content: chunk });
      };

      let toolIteration = 0;
      let keepLooping = true;
      // Use cumulative nudge count from the smart-todo plan if available,
      // so that nudge escalation persists across execute→verify→execute cycles.
      const smartTodo = this.sessionManager.getSmartTodo(sessionId);
      const loopDetector = new LoopDetector(smartTodo?.cumulativeNudges ?? 0);

      while (keepLooping) {
        // Check abort before each provider call
        if (abortCtrl.signal.aborted) { break; }

        // Reset streaming state for each LLM call so UI shows waiting indicator
        firstChunkReceived = false;
        this.postSessionMessage(sessionId, { type: 'waitingForApi' });

        // ── Pre-overflow check: context compaction based on settings ──
        const preCheckUsage = this.sessionManager.getTokenUsage(sessionId);
        const contextLimit = await this.getActiveContextWindow();
        // Use inputTokens (last API call's full prompt size) as the context pressure metric.
        // This avoids the double-counting that occurred when summing input + output tokens.
        const contextUsed = preCheckUsage.inputTokens;
        if (contextLimit > 0 && contextUsed > contextLimit * ChatViewProvider.CONTEXT_COMPACTION_THRESHOLD && toolIteration > 0) {
          const settings = getCompactionSettings(this.globalState);
          const percentage = Math.round((contextUsed / contextLimit) * 100);

          if (settings.method === 'automatic') {
            // Current behavior: compact immediately
            this.postSessionMessage(sessionId, {
              type: 'streamChunk',
              content: '\n\n\u26A0\uFE0F *Context usage at ' + percentage + '% — auto-compacting to avoid overflow...*\n',
            });
            await this.performCompaction(sessionId);
          } else {
            // Semi-automatic or manual: pause and wait for user action
            const digest = this.buildConversationDigest(sessionId);

            if (settings.method === 'semi-automatic') {
              this.postSessionMessage(sessionId, {
                type: 'compactionCountdown',
                timeout: settings.timeoutSeconds,
                digest,
                percentage,
              });
            } else {
              // manual
              this.postSessionMessage(sessionId, {
                type: 'compactionPending',
                digest,
                percentage,
              });
            }

            // Pause: wait for user action
            this.compactionPendingSessionId = sessionId;
            const action = await new Promise<'compacted' | 'cancelled'>((resolve) => {
              this.compactionResolver = resolve;
            });
            this.compactionResolver = null;
            this.compactionPendingSessionId = null;

            if (action === 'cancelled') {
              // User cancelled — continue without compaction (risky but their choice)
              this.postSessionMessage(sessionId, { type: 'compactionComplete' });
              const cancelledHistory = this.sessionManager.getHistory(sessionId);
              messages.length = 0;
              messages.push({ role: 'system', content: modePrompt });
              messages.push(...cancelledHistory);
              messages.push({ role: 'user', content: 'Continue from where you left off. Here is what was happening: you were in tool iteration ' + toolIteration + ' of an ongoing task.' });
              this.sendContextUsage(sessionId);
              continue;
            }
          }

          // Rebuild messages from compacted history
          const compactedHistory = this.sessionManager.getHistory(sessionId);
          messages.length = 0;
          messages.push({ role: 'system', content: modePrompt });
          messages.push(...compactedHistory);
          messages.push({ role: 'user', content: 'Continue from where you left off. Here is what was happening: you were in tool iteration ' + toolIteration + ' of an ongoing task.' });
          this.sendContextUsage(sessionId);
        }

        const response = await provider.sendMessage(messages, requestOpts, onChunk);
        if (!firstChunkReceived) {
          this.postSessionMessage(sessionId, { type: 'apiResponseStarted' });
        }

        // Track token usage from this response
        if (response.usage) {
          this.sessionManager.addTokenUsage(sessionId, response.usage.inputTokens, response.usage.outputTokens);
          this.sendContextUsage(sessionId);
        }

        if (response.thinking) {
          this.postSessionMessage(sessionId, { type: 'thinking', content: response.thinking });
        }

        // ── If the LLM requested tool calls, execute & feed results back ──
        if (response.toolCalls && response.toolCalls.length > 0 && toolIteration < ChatViewProvider.MAX_TOOL_ITERATIONS) {
          toolIteration++;

          // Store assistant turn (with tool-call metadata) in conversation + history
          const assistantMsg: ChatMessage = {
            role: 'assistant',
            content: response.content ?? '',
            toolCalls: response.toolCalls,
            internal,
          };
          messages.push(assistantMsg);
          this.sessionManager.addMessage(sessionId, assistantMsg);

          // Execute each tool and collect results
          const toolResults: ProviderToolResult[] = [];
          for (const toolCall of response.toolCalls) {
            // Check abort between tool executions
            if (abortCtrl.signal.aborted) { break; }

            this.postSessionMessage(sessionId, {
              type: 'toolCallStarted',
              name: toolCall.name,
              id: toolCall.id,
              args: toolCall.arguments,
            });

            // Emit file activity for sandbox progress tracking
            this.emitFileActivity(sessionId, toolCall.name, toolCall.arguments);

            const tool = this.tools.get(toolCall.name);
            if (tool) {
              // Special handling for askQuestion
              if (toolCall.name === 'askQuestion') {
                this.postSessionMessage(sessionId, {
                  type: 'askQuestion',
                  question: (toolCall.arguments.question as string) || 'The assistant has a question for you.',
                  toolCallId: toolCall.id,
                });
              }

              // Special handling for exitPlanningMode
              if (toolCall.name === 'exitPlanningMode') {
                this.postSessionMessage(sessionId, {
                  type: 'exitPlanningModeRequest',
                  reason: (toolCall.arguments.reason as string) || 'The assistant wants to exit planning mode.',
                  toolCallId: toolCall.id,
                });
              }

              // Validate required parameters before execution
              const validationError = this.validateToolParams(tool, toolCall.arguments);
              if (validationError) {
                this.postSessionMessage(sessionId, {
                  type: 'toolCallResult',
                  id: toolCall.id,
                  name: toolCall.name,
                  content: validationError,
                  isError: true,
                });
                toolResults.push({ toolCallId: toolCall.id, content: validationError, isError: true });
                continue;
              }

              try {
                // Wire up real-time terminal streaming for runTerminal tool
                if (toolCall.name === 'runTerminal' && tool instanceof RunTerminalTool) {
                  (tool as RunTerminalTool).onOutput = (chunk: string) => {
                    this.postSessionMessage(sessionId, {
                      type: 'terminalOutput',
                      toolCallId: toolCall.id,
                      chunk,
                    });
                  };
                }

                const result = await tool.execute(toolCall.arguments);
                this.postSessionMessage(sessionId, {
                  type: 'toolCallResult',
                  id: toolCall.id,
                  name: toolCall.name,
                  content: result.content,
                  isError: result.isError,
                });
                toolResults.push({ toolCallId: toolCall.id, content: result.content, isError: result.isError });
              } catch (toolErr) {
                const errContent = `Tool execution error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
                this.postSessionMessage(sessionId, {
                  type: 'toolCallResult',
                  id: toolCall.id,
                  name: toolCall.name,
                  content: errContent,
                  isError: true,
                });
                toolResults.push({ toolCallId: toolCall.id, content: errContent, isError: true });
              }
            } else {
              const errContent = `Unknown tool: ${toolCall.name}`;
              this.postSessionMessage(sessionId, {
                type: 'toolCallResult',
                id: toolCall.id,
                name: toolCall.name,
                content: errContent,
                isError: true,
              });
              toolResults.push({ toolCallId: toolCall.id, content: errContent, isError: true });
            }
          }

          // Add tool results to conversation + history so the LLM sees them
          const toolResultsMsg: ChatMessage = { role: 'user', content: '', toolResults, internal };
          messages.push(toolResultsMsg);
          this.sessionManager.addMessage(sessionId, toolResultsMsg);

          // If aborted during tool execution, break out immediately
          if (abortCtrl.signal.aborted) { break; }

          // ── Loop detection via LoopDetector ──
          const callSigs = response.toolCalls.map(tc => `${tc.name}:${JSON.stringify(tc.arguments)}`).join('|');
          const loopResult = loopDetector.recordRound(
            {
              toolNames: response.toolCalls.map(tc => tc.name),
              signature: callSigs,
              errors: response.toolCalls.map((_, i) => !!toolResults[i]?.isError),
            },
            this.planningMode,
          );

          if (loopResult.shouldNudge) {
            if (loopResult.shouldForceBreak) {
              const forceMsg = this.planningMode
                ? '[SYSTEM] Stopping tool loop: you have been re-reading the same files. ' +
                  'Output your implementation plan NOW using the required format (## Goal, ## Steps, ## Risks & Edge Cases, ## Verification). ' +
                  'Use the context you have already gathered.'
                : '[SYSTEM] Stopping tool loop: repeated non-productive iterations after multiple warnings. ' +
                  'Summarize what you have done so far and what still needs to be done.';
              messages.push({ role: 'user', content: forceMsg });
              this.sessionManager.addMessage(sessionId, { role: 'user', content: forceMsg });

              this.postSessionMessage(sessionId, {
                type: 'streamChunk',
                content: '\n\n\u26A0\uFE0F *Detected persistent loop — forcing tool-loop exit.*\n',
              });
              keepLooping = false;
              break;
            }

            // Build a targeted nudge message
            let nudgeBody: string;
            if (this.planningMode) {
              nudgeBody = '[SYSTEM] You are reading the same files repeatedly. ' +
                'You have gathered enough context. ' +
                'STOP using tools and OUTPUT your implementation plan NOW using the required format (## Goal, ## Steps, ## Risks & Edge Cases, ## Verification).';
            } else {
              nudgeBody = '[SYSTEM] You are spinning without making progress. ';
              if (loopResult.repeatedErrorTools.length > 0) {
                const toolList = loopResult.repeatedErrorTools.join(', ');
                nudgeBody += `The following tool(s) have FAILED: ${toolList}. STOP using them and try alternatives. `;
                if (loopResult.repeatedErrorTools.includes('runSandboxedCommand')) {
                  nudgeBody += 'runSandboxedCommand requires createSandbox first — use runTerminal instead. ';
                }
              }
              nudgeBody += 'STOP and ACT NOW:\n' +
                '- Use writeFile to create source files\n' +
                '- Use runTerminal to run shell commands (npm, npx, etc.)\n' +
                '- Do NOT use runSandboxedCommand unless you have called createSandbox first\n' +
                '- If a tool returned an error, STOP calling it and try an alternative tool\n' +
                'Implement the next pending TODO item RIGHT NOW with writeFile or runTerminal.';
            }

            const nudge: ChatMessage = { role: 'user', content: nudgeBody };
            messages.push(nudge);
            this.sessionManager.addMessage(sessionId, nudge);
            loopDetector.reset();
          }

          // Loop back: the LLM will be called again with tool results
        } else {
          // No tool calls (or max iterations reached) — this is the final response
          responseText = response.content ?? '';
          if (responseText) {
            this.sessionManager.addMessage(sessionId, { role: 'assistant', content: responseText });
          }

          if (toolIteration >= ChatViewProvider.MAX_TOOL_ITERATIONS && response.toolCalls?.length) {
            this.postSessionMessage(sessionId, {
              type: 'streamChunk',
              content: '\n\n\u26A0\uFE0F *Reached maximum tool iterations. Stopping.*\n',
            });
          }

          keepLooping = false;
        }
      }

      // If aborted during the tool loop (not via thrown error), handle it here
      if (abortCtrl.signal.aborted) {
        // Persist cumulative nudge count back to smart-todo plan
        if (smartTodo) { smartTodo.cumulativeNudges = loopDetector.nudgeCount; }
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n*[Generation stopped]*',
        });
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return '[CANCELLED]';
      }

      // Persist cumulative nudge count back to smart-todo plan
      if (smartTodo) { smartTodo.cumulativeNudges = loopDetector.nudgeCount; }

      this.postSessionMessage(sessionId, { type: 'messageComplete' });
      this.sessionManager.setSessionStatus(sessionId, 'idle');
    } catch (err) {
      // Handle abort/cancellation gracefully
      if (abortCtrl.signal.aborted || (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort')))) {
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n*[Generation stopped]*',
        });
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return '[CANCELLED]';
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      this.postSessionMessage(sessionId, {
        type: 'error',
        message: errMsg,
      });
      this.sessionManager.setSessionStatus(sessionId, 'error');
      // Return error message instead of re-throwing so callers (like smart-todo) can continue
      return `[ERROR] ${errMsg}`;
    } finally {
      this.abortControllers.delete(sessionId);
      if (this.compactionPendingSessionId === sessionId) {
        this.compactionPendingSessionId = null;
        this.compactionResolver = null;
      }
    }

    return responseText;
  }

  // ===== Smart To-Do orchestration =====

  /**
   * Isolated planning call: no tools, no history, no context additions.
   * This gives the LLM the best chance to produce a clean plan.
   */
  private async sendPlanningRound(
    sessionId: string,
    systemPrompt: string,
    userText: string,
  ): Promise<string> {
    const provider = this.registry.getActiveProvider()!;
    const model = this.registry.getActiveModelId();

    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ];

    this.postSessionMessage(sessionId, { type: 'waitingForApi' });

    let responseText = '';
    let firstChunkReceived = false;
    try {
      // Ensure an abort controller exists so Stop works during planning/verification
      if (!this.abortControllers.has(sessionId)) {
        this.abortControllers.set(sessionId, new AbortController());
      }
      const abortCtrl = this.abortControllers.get(sessionId)!;

      // If already cancelled before we start, bail early
      if (abortCtrl.signal.aborted || this.cancelledSessions.has(sessionId)) {
        return '';
      }

      const response = await provider.sendMessage(
        messages,
        { model, signal: abortCtrl.signal },  // no tools!
        (chunk) => {
          if (!firstChunkReceived) {
            firstChunkReceived = true;
            this.postSessionMessage(sessionId, { type: 'apiResponseStarted' });
          }
          this.postSessionMessage(sessionId, { type: 'streamChunk', content: chunk });
        }
      );
      if (!firstChunkReceived) {
        this.postSessionMessage(sessionId, { type: 'apiResponseStarted' });
      }
      responseText = response.content ?? '';

      // Track token usage from planning round
      if (response.usage) {
        this.sessionManager.addTokenUsage(sessionId, response.usage.inputTokens, response.usage.outputTokens);
        this.sendContextUsage(sessionId);
      }

      this.postSessionMessage(sessionId, { type: 'messageComplete' });
    } catch (err) {
      // Handle abort/cancellation gracefully — don't show as error
      if (this.cancelledSessions.has(sessionId) ||
          (err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort')))) {
        this.cancelledSessions.add(sessionId);
        return '';
      }
      this.postSessionMessage(sessionId, {
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    return responseText;
  }

  /**
   * Full Smart To-Do lifecycle:
   *  1. Planning  — ask the AI to produce a structured plan
   *  2. Execution — ask the AI to implement the plan
   *  3. Verification — ask the AI to verify every TODO; loop back to 2 if needed
   */
  private async runSmartTodoFlow(
    sessionId: string,
    userText: string,
    fileReferences?: string[],
  ): Promise<void> {
    // Clear any stale cancellation flag from a previous run
    this.cancelledSessions.delete(sessionId);

    // Save the original user message in history (visible in replay)
    this.sessionManager.addMessage(sessionId, { role: 'user', content: userText });

    // Initialize smart-todo state
    this.sessionManager.initSmartTodo(sessionId, userText);

    // If in sandboxed-smart-todo mode, prepend sandbox context to all prompts
    const isSandboxed = this.modeManager.isSandboxedSmartTodoMode();
    const sandboxPreamble = isSandboxed
      ? `**SANDBOX MODE ACTIVE:** You are working inside a sandboxed environment. ` +
        `Use runTerminal for running commands (it enforces software-level restrictions automatically). ` +
        `If you need full OS-level isolation, first call createSandbox, then use runSandboxedCommand. ` +
        `Do NOT call runSandboxedCommand unless you have called createSandbox first. ` +
        `Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked.\n\n`
      : '';

    // Notify the webview that we're in smart-todo mode
    this.postSessionMessage(sessionId, {
      type: 'smartTodoUpdate',
      phase: 'planning',
      todos: [],
      iteration: 0,
    });

    // Ensure an abort controller exists for the planning phase so Stop works
    if (!this.abortControllers.has(sessionId)) {
      this.abortControllers.set(sessionId, new AbortController());
    }

    // ── Phase 1: Planning (isolated call — no tools, no history) ────────
    try {
      const planningPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_PLANNING_PROMPT;
      const planResponse = await this.sendPlanningRound(
        sessionId,
        planningPrompt,
        userText,
      );

      // Check if the LLM asked clarifying questions instead of producing a plan
      const questions = this.extractClarificationQuestions(planResponse);
      let todos = this.parseTodosFromPlan(planResponse);

      if (todos.length === 0 && questions) {
        // The LLM is asking for clarification — pause and wait for user input
        this.sessionManager.setClarificationState(sessionId, questions, fileReferences);
        this.postSessionMessage(sessionId, {
          type: 'smartTodoUpdate',
          phase: 'awaiting-clarification',
          todos: [],
          iteration: 0,
        });
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        return;
      }

      // If no plan and no questions, retry once with a stronger nudge
      if (todos.length === 0) {
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n\u26A0\uFE0F Plan format not detected. Retrying planning phase...\n',
        });

        const retryPrompt = sandboxPreamble + `CRITICAL: You MUST respond with ONLY a plan block. Nothing else.\n\n\`\`\`plan\nTODO 1: <Title> \u2014 <Description>\nTODO 2: <Title> \u2014 <Description>\n\`\`\`\n\nThe user request is below. Create a plan for it. Do NOT ask questions. Do NOT explain. ONLY output the plan block.`;
        const retryResponse = await this.sendPlanningRound(
          sessionId,
          retryPrompt,
          userText,
        );
        todos = this.parseTodosFromPlan(retryResponse);
      }

      // If still no plan, create a single catch-all TODO from the user request
      if (todos.length === 0) {
        todos = [{ id: 1, title: 'Complete user request', status: 'pending' as TodoItemStatus, detail: userText }];
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n\u26A0\uFE0F Could not extract structured TODOs. Using a single task for the full request.\n',
        });
      }

      if (this.cancelledSessions.has(sessionId)) {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      await this.executePlanLoop(sessionId, userText, todos, sandboxPreamble);
    } catch (err) {
      // Errors in individual rounds are already reported; this catches unexpected breaks
      if (!(err instanceof Error && err.message.includes('abort'))) {
        this.postSessionMessage(sessionId, {
          type: 'error',
          message: `Smart To-Do loop error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      // Ensure session goes idle on any error/abort
      this.cancelledSessions.delete(sessionId);
      this.sessionManager.setSessionStatus(sessionId, 'idle');
    }
  }

  /**
   * Resume planning after the user answered clarification questions.
   */
  private async resumePlanningWithAnswers(
    sessionId: string,
    userAnswers: string,
    smartTodo: SmartTodoPlan,
  ): Promise<void> {
    const isSandboxed = this.modeManager.isSandboxedSmartTodoMode();
    const sandboxPreamble = isSandboxed
      ? `**SANDBOX MODE ACTIVE:** You are working inside a sandboxed environment. ` +
        `Use runTerminal for running commands (it enforces software-level restrictions automatically). ` +
        `If you need full OS-level isolation, first call createSandbox, then use runSandboxedCommand. ` +
        `Do NOT call runSandboxedCommand unless you have called createSandbox first. ` +
        `Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked.\n\n`
      : '';

    // Notify the webview we're back to planning
    this.postSessionMessage(sessionId, {
      type: 'smartTodoUpdate',
      phase: 'planning',
      todos: [],
      iteration: 0,
    });

    const combinedRequest = `Original request: ${smartTodo.userRequest}\n\nYour clarification questions:\n${smartTodo.clarificationQuestions}\n\nUser's answers:\n${userAnswers}\n\nNow produce the plan based on this information.`;

    try {
      const planningPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_PLANNING_PROMPT;
      const planResponse = await this.sendPlanningRound(
        sessionId,
        planningPrompt,
        combinedRequest,
      );

      // Check for another round of questions
      const questions = this.extractClarificationQuestions(planResponse);
      let todos = this.parseTodosFromPlan(planResponse);

      if (todos.length === 0 && questions) {
        // Still asking questions — pause again
        this.sessionManager.setClarificationState(sessionId, questions, smartTodo.fileReferences);
        this.postSessionMessage(sessionId, {
          type: 'smartTodoUpdate',
          phase: 'awaiting-clarification',
          todos: [],
          iteration: 0,
        });
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        return;
      }

      // Fallback: force a plan
      if (todos.length === 0) {
        todos = [{ id: 1, title: 'Complete user request', status: 'pending' as TodoItemStatus, detail: smartTodo.userRequest }];
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n\u26A0\uFE0F Could not extract structured TODOs. Using a single task for the full request.\n',
        });
      }

      if (this.cancelledSessions.has(sessionId)) {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      await this.executePlanLoop(sessionId, smartTodo.userRequest, todos, sandboxPreamble);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('abort'))) {
        this.postSessionMessage(sessionId, {
          type: 'error',
          message: `Smart To-Do loop error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      this.cancelledSessions.delete(sessionId);
      this.sessionManager.setSessionStatus(sessionId, 'idle');
    }
  }

  /**
   * Execute the plan loop (Phase 2–3): Execute → Verify, repeated until done.
   */
  private async executePlanLoop(
    sessionId: string,
    userText: string,
    todos: TodoItem[],
    sandboxPreamble: string,
  ): Promise<void> {
    // ── Auto-create sandbox if in sandboxed mode and no sandbox exists yet ──
    const isSandboxed = this.modeManager.isSandboxedSmartTodoMode();
    if (isSandboxed && this.sandboxManager && !this.sandboxManager.getSandboxInfo().isActive) {
      try {
        // Derive a feature name from the user request (first few words)
        const featureName = userText
          .replace(/[^a-zA-Z0-9 ]/g, '')
          .trim()
          .split(/\s+/)
          .slice(0, 4)
          .join('-')
          .toLowerCase()
          .slice(0, 40) || 'task';

        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: `\n\n\uD83D\uDD12 **Creating sandbox branch for isolated development...**\n`,
        });

        const config = await this.sandboxManager.createSandbox(featureName);
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: `\u2705 Sandbox created: branch \`${config.branchName}\` at \`${config.worktreePath}\`\n\n`,
        });
      } catch (err) {
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: `\n\n\u26A0\uFE0F Sandbox creation failed: ${err instanceof Error ? err.message : String(err)}. Continuing without sandbox isolation.\n\n`,
        });
      }
    }

    this.sessionManager.setSmartTodoItems(sessionId, todos);
    this.sessionManager.setSmartTodoPhase(sessionId, 'executing');

    this.postSessionMessage(sessionId, {
      type: 'smartTodoUpdate',
      phase: 'executing',
      todos,
      iteration: 0,
    });

    // Build the plan text for subsequent prompts
    const planText = this.formatPlanText(todos);

    // ── Phase 2–3: Execute → Verify loop ─────────────────────────────
    let iteration = 0;
    let consecutiveNonProductiveRounds = 0;
    const maxIter = this.sessionManager.getSmartTodo(sessionId)?.maxIterations ?? 5;

    while (iteration < maxIter) {
      // Check if aborted
      if (!this.sessionManager.getSession(sessionId) || this.cancelledSessions.has(sessionId)) {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: '\n\n*[Generation stopped]*',
        });
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      // ── Execution pass ──────────────────────────────────────────────
      const execPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_EXECUTION_PROMPT
        .replace('{PLAN}', planText);

      const pendingItems = todos.filter(t => t.status !== 'done').map(t => `- TODO ${t.id}: ${t.title}`).join('\n');
      const execUserMsg = iteration === 0
        ? `Please implement the plan now. Here is the original request:\n\n${userText}`
        : `Some TODOs are still incomplete. Please fix the following items:\n\n${pendingItems}\n\nOriginal request: ${userText}`;

      // Snapshot of files before execution to detect if anything was actually written
      const filesBefore = new Map<string, number>();
      try {
        const listTool = this.tools.get('listFiles');
        if (listTool) {
          const listing = await listTool.execute({ pattern: '**/*' });
          if (!listing.isError) {
            listing.content.split('\n').filter(f => f.trim()).forEach(f => filesBefore.set(f, 0));
          }
        }
      } catch { /* ignore */ }

      // Restrict read-only tools (listFiles, getDiagnostics, getSandboxStatus) during execution
      // so weak LLMs are forced to use writeFile/runTerminal instead of spinning on reads.
      // Mark as internal so these orchestration messages don't appear in session replay.
      const execResult = await this.sendOneLLMRound(sessionId, execUserMsg, undefined, execPrompt, true, true);

      // Check if cancelled during execution round
      if (this.cancelledSessions.has(sessionId) || execResult === '[CANCELLED]') {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      // Check if execution was productive: compare files after execution
      // Consider productive if: new files appeared, file count changed, or
      // the execution response contains evidence of work (tool calls / terminal output)
      let executionProductive = false;
      try {
        const listTool = this.tools.get('listFiles');
        if (listTool) {
          const listing = await listTool.execute({ pattern: '**/*' });
          if (!listing.isError) {
            const filesAfter = listing.content.split('\n').filter(f => f.trim());
            // Productive if any new files appeared or the file count changed
            executionProductive = filesAfter.some(f => !filesBefore.has(f)) || filesAfter.length !== filesBefore.size;
          }
        }
      } catch { /* treat as non-productive if we can't check */ }

      // Also consider productive if the LLM response references completed work
      // (tool calls that ran terminal commands or wrote files count as progress)
      if (!executionProductive && execResult && execResult !== '[CANCELLED]' && !execResult.startsWith('[ERROR]')) {
        // The round made tool calls — check if any were write/terminal operations
        const history = this.sessionManager.getHistory(sessionId);
        const recentMessages = history.slice(-10);
        const hadWriteOps = recentMessages.some(m =>
          m.toolCalls?.some(tc =>
            ['writeFile', 'runTerminal', 'runSandboxedCommand'].includes(tc.name)
          )
        );
        if (hadWriteOps) {
          executionProductive = true;
        }
      }

      if (executionProductive) {
        consecutiveNonProductiveRounds = 0;
      } else {
        consecutiveNonProductiveRounds++;
        if (consecutiveNonProductiveRounds >= 2) {
          // Before giving up, check if the remaining TODOs are actually just verification-type tasks
          const remainingTodos = todos.filter(t => t.status !== 'done');
          const allVerificationLike = remainingTodos.every(t =>
            /verif|test|confirm|check|run.*server|start.*server|open.*browser/i.test(t.title + ' ' + (t.detail || ''))
          );

          if (allVerificationLike) {
            // Verification-style TODOs that don't produce files — mark as done and stop
            for (const todo of remainingTodos) {
              todo.status = 'done';
              this.sessionManager.updateSmartTodoItem(sessionId, todo.id, 'done');
            }
            this.postSessionMessage(sessionId, {
              type: 'streamChunk',
              content: '\n\n\u2705 **Remaining verification tasks completed (no file changes needed).**\n',
            });
            this.postSessionMessage(sessionId, {
              type: 'smartTodoUpdate',
              phase: 'executing',
              todos: this.sessionManager.getSmartTodo(sessionId)?.todos ?? [],
              iteration,
            });
            await this.sendSandboxResult(sessionId);
            this.postSessionMessage(sessionId, { type: 'messageComplete' });
            break;
          }

          this.postSessionMessage(sessionId, {
            type: 'streamChunk',
            content: '\n\n\u26A0\uFE0F **Agent could not make further progress after 2 consecutive execution rounds.**\n' +
              'Try a different model, simplify the request, or complete the remaining steps manually.\n',
          });
          await this.sendSandboxResult(sessionId);
          this.postSessionMessage(sessionId, { type: 'messageComplete' });
          break;
        }
      }

      // Check cancellation before verification
      if (this.cancelledSessions.has(sessionId)) {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      // Ensure abort controller exists for the verification round
      if (!this.abortControllers.has(sessionId)) {
        this.abortControllers.set(sessionId, new AbortController());
      }

      // ── Verification pass (tool-free to prevent spinning) ──────────
      this.sessionManager.setSmartTodoPhase(sessionId, 'verifying');
      iteration = this.sessionManager.incrementVerifyIteration(sessionId);

      this.postSessionMessage(sessionId, {
        type: 'smartTodoUpdate',
        phase: 'verifying',
        todos: this.sessionManager.getSmartTodo(sessionId)?.todos ?? [],
        iteration,
      });

      // Gather workspace context ourselves so the LLM doesn't need tools
      let workspaceContext = '';
      try {
        const listTool = this.tools.get('listFiles');
        if (listTool) {
          const listing = await listTool.execute({ pattern: '**/*' });
          workspaceContext += `\n\n--- Files in workspace ---\n${listing.content}`;
        }
        // Read key files (small ones) so the LLM can check content
        const listing = await this.tools.get('listFiles')?.execute({ pattern: '**/*' });
        if (listing && !listing.isError) {
          const files = listing.content.split('\n').filter(f => f.trim());
          // Read first 10 relevant files (skip node_modules, binaries, etc.)
          const readableFiles = files
            .filter(f => /\.(ts|tsx|js|jsx|json|html|css|md|yml|yaml|toml|cfg|txt)$/i.test(f))
            .slice(0, 10);
          for (const file of readableFiles) {
            try {
              const readTool = this.tools.get('readFile');
              if (readTool) {
                const content = await readTool.execute({ path: file });
                if (!content.isError && content.content.length < 5000) {
                  workspaceContext += `\n\n--- ${file} ---\n${content.content}`;
                }
              }
            } catch { /* skip unreadable files */ }
          }
        }
      } catch { /* workspace scan failed, LLM will verify with what it knows */ }

      const verifyPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_VERIFY_PROMPT
        .replace('{USER_REQUEST}', userText)
        .replace('{PLAN}', planText)
        + workspaceContext;

      // Use tool-free sendPlanningRound to prevent the LLM from spinning on listFiles
      const verifyResponse = await this.sendPlanningRound(
        sessionId,
        verifyPrompt,
        `Verify the current state of all TODOs. This is verification iteration ${iteration}. Based on the workspace files shown above, determine which TODOs are DONE and which have FAILED.`,
      );

      // Check if cancelled during verification round
      if (this.cancelledSessions.has(sessionId)) {
        this.cancelledSessions.delete(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        this.sessionManager.setSessionStatus(sessionId, 'idle');
        return;
      }

      // Parse verification results and update todo statuses
      this.parseVerificationResponse(sessionId, verifyResponse, todos);

      this.postSessionMessage(sessionId, {
        type: 'smartTodoUpdate',
        phase: this.sessionManager.allTodosDone(sessionId) ? 'executing' : 'verifying',
        todos: this.sessionManager.getSmartTodo(sessionId)?.todos ?? [],
        iteration,
      });

      // Check completion
      if (this.sessionManager.allTodosDone(sessionId)) {
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: `\n\n\u2705 **All TODOs verified complete after ${iteration} iteration(s).**\n`,
        });
        await this.sendSandboxResult(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        break;
      }

      // If max iterations reached, report and stop
      if (this.sessionManager.hasReachedMaxIterations(sessionId)) {
        const remaining = todos.filter(t => t.status !== 'done');
        const summary = remaining.map(t => `- TODO ${t.id}: ${t.title} (${t.status})`).join('\n');
        this.postSessionMessage(sessionId, {
          type: 'streamChunk',
          content: `\n\n\u26A0\uFE0F **Reached max iterations (${maxIter}).** Remaining items:\n${summary}\n`,
        });
        await this.sendSandboxResult(sessionId);
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        break;
      }

      // Loop back to execution — reset failed/in-progress TODOs to pending
      // so the next execution round knows what to retry
      for (const todo of todos) {
        if (todo.status === 'failed' || todo.status === 'in-progress') {
          todo.status = 'pending';
          this.sessionManager.updateSmartTodoItem(sessionId, todo.id, 'pending');
        }
      }
      this.sessionManager.setSmartTodoPhase(sessionId, 'executing');

      this.postSessionMessage(sessionId, {
        type: 'smartTodoUpdate',
        phase: 'executing',
        todos: this.sessionManager.getSmartTodo(sessionId)?.todos ?? [],
        iteration,
      });
    }
  }

  /**
   * Extract clarification questions from LLM response.
   * Returns the questions text if found, or null if no questions detected.
   */
  private extractClarificationQuestions(response: string): string | null {
    // Strategy 1: explicit ```questions block
    const questionsBlock = response.match(/```questions\s*\n([\s\S]*?)```/);
    if (questionsBlock) {
      return questionsBlock[1].trim();
    }

    // Strategy 2: response has multiple question marks and no plan block
    const hasPlanBlock = /```plan\s*\n/.test(response);
    if (hasPlanBlock) { return null; }

    const questionLines = response.split('\n').filter(line => line.trim().endsWith('?'));
    if (questionLines.length >= 2) {
      return questionLines.map(l => l.trim()).join('\n');
    }

    return null;
  }

  /**
   * Parse a ```plan block into TodoItems.
   */
  private parseTodosFromPlan(response: string): TodoItem[] {
    const todos: TodoItem[] = [];

    // Try to extract from a ```plan ... ``` block first
    const planBlockMatch = response.match(/```plan\s*\n([\s\S]*?)```/);
    const text = planBlockMatch ? planBlockMatch[1] : response;

    let match: RegExpExecArray | null;

    // ── Strategy 1: "TODO N: Title — Description" (canonical format) ──
    const todoRegex = /TODO\s*(\d+)\s*:\s*(.+)/gi;
    while ((match = todoRegex.exec(text)) !== null) {
      const id = parseInt(match[1], 10);
      const fullText = match[2].trim();
      const dashIndex = fullText.search(/\s[—\-–]\s/);
      const title = dashIndex >= 0 ? fullText.slice(0, dashIndex).trim() : fullText;
      const detail = dashIndex >= 0 ? fullText.slice(dashIndex).replace(/^[\s—\-–]+/, '').trim() : undefined;

      todos.push({ id, title, status: 'pending', detail });
    }

    if (todos.length > 0) { return todos; }

    // ── Strategy 2: Structured "## Steps" / "## Goal" format ──────────
    // Many LLMs produce plans with markdown headers instead of ```plan blocks.
    // Check this BEFORE generic numbered/bullet lists to avoid picking up sub-step numbers.
    const hasStructuredFormat = /^##\s*(Goal|Steps|Verification)/mi.test(text);
    if (hasStructuredFormat) {
      // Extract file-change groups from "## Steps" section.
      // Each group is a "- File: ..." block (with or without bold markers).
      const stepsMatch = text.match(/##\s*Steps\s*\n([\s\S]*?)(?=\n##|$)/);
      if (stepsMatch) {
        const stepsText = stepsMatch[1];

        // Split on "- File:" or "- **File**:" lines (each starts a new TODO).
        // Accept both bold (**File**:) and plain (File:) formats.
        const fileGroups = stepsText.split(/(?=^\s*-\s*(?:\*\*)?File(?:\*\*)?:\s)/m).filter(b => b.trim());

        if (fileGroups.length > 0 && /^\s*-\s*(?:\*\*)?File(?:\*\*)?:/m.test(fileGroups[0])) {
          // Each group starts with "- File: <path>" — treat as one TODO per file
          let stepId = 1;
          for (const group of fileGroups) {
            const fileMatch = group.match(/(?:\*\*)?File(?:\*\*)?:\s*`?([^`\n]+)`?/i);
            const changeMatch = group.match(/(?:\*\*)?Change(?:\*\*)?:\s*\n?([\s\S]*?)(?=\n\s*-\s*(?:(?:\*\*)?(?:File|Why|Reason)(?:\*\*)?:)|$)/i);

            const filePath = fileMatch ? fileMatch[1].trim() : '';
            let changeDesc = '';

            if (changeMatch) {
              // Summarize the change: take first meaningful line or first numbered sub-step
              const changeLines = changeMatch[1].split('\n').map(l => l.trim()).filter(l => l.length > 3);
              const firstStep = changeLines.find(l => /^\d+[.)]\s/.test(l));
              if (firstStep) {
                changeDesc = firstStep.replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '').trim();
                // Count sub-steps to show scope
                const subStepCount = changeLines.filter(l => /^\d+[.)]\s/.test(l)).length;
                if (subStepCount > 1) {
                  changeDesc += ` (+${subStepCount - 1} more change${subStepCount > 2 ? 's' : ''})`;
                }
              } else if (changeLines.length > 0) {
                changeDesc = changeLines[0].replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
              }
            }

            const title = filePath
              ? `${changeDesc ? changeDesc.slice(0, 50) : 'Update'} (${filePath})`
              : (changeDesc || group.trim().split('\n')[0].replace(/^[-*]\s*/, '').trim()).slice(0, 80);

            todos.push({ id: stepId++, title: title.slice(0, 80), status: 'pending', detail: group.trim() });
          }
        } else {
          // No "- File:" groups found — try numbered or bullet items within ## Steps
          const numberedStepRegex = /^\s*(\d+)[.)\]]\s+(.+)/gm;
          let stepId = 1;
          while ((match = numberedStepRegex.exec(stepsText)) !== null) {
            const fullText = match[2].replace(/\*\*/g, '').trim();
            if (fullText.length < 5) { continue; }
            todos.push({ id: stepId++, title: fullText.slice(0, 80), status: 'pending', detail: fullText });
          }
          if (todos.length === 0) {
            // Try bullet items
            const bulletStepRegex = /^\s*[-*]\s+(.+)/gm;
            while ((match = bulletStepRegex.exec(stepsText)) !== null) {
              const fullText = match[1].replace(/\*\*/g, '').trim();
              if (fullText.length < 5) { continue; }
              todos.push({ id: stepId++, title: fullText.slice(0, 80), status: 'pending', detail: fullText });
            }
          }
        }
      }

      // If no Steps section matched, fall back to "## Goal" as a single TODO
      if (todos.length === 0) {
        const goalMatch = text.match(/##\s*Goal\s*\n+(.+)/i);
        if (goalMatch) {
          todos.push({ id: 1, title: goalMatch[1].trim().slice(0, 80), status: 'pending', detail: text.trim() });
        }
      }

      // Append a verification TODO from "## Verification" section if present
      if (todos.length > 0) {
        const verifyMatch = text.match(/##\s*Verification\s*\n+([\s\S]*?)(?=\n##|$)/);
        if (verifyMatch) {
          const nextId = Math.max(...todos.map(t => t.id)) + 1;
          todos.push({ id: nextId, title: 'Verify implementation', status: 'pending', detail: verifyMatch[1].trim() });
        }
      }

      if (todos.length > 0) { return todos; }
    }

    // ── Strategy 3: Numbered list "1. Title" or "1) Title" (generic fallback) ──
    const numberedRegex = /^\s*(?:\*\*)?\s*(\d+)[.)\]]\s*(.+)/gm;
    while ((match = numberedRegex.exec(text)) !== null) {
      const id = parseInt(match[1], 10);
      const fullText = match[2].replace(/\*\*/g, '').trim();
      const dashIndex = fullText.search(/\s[—\-–:]\s/);
      const title = dashIndex >= 0 ? fullText.slice(0, dashIndex).trim() : fullText;
      const detail = dashIndex >= 0 ? fullText.slice(dashIndex).replace(/^[\s—\-–:]+/, '').trim() : undefined;

      todos.push({ id, title: title.slice(0, 80), status: 'pending', detail });
    }

    if (todos.length > 0) { return todos; }

    // ── Strategy 4: Bullet list "- Title" or "* Title" ──
    const bulletRegex = /^\s*[-*]\s+(.+)/gm;
    let bulletId = 1;
    while ((match = bulletRegex.exec(text)) !== null) {
      const fullText = match[1].replace(/\*\*/g, '').trim();
      if (fullText.length < 5) { continue; }  // skip trivial lines
      const dashIndex = fullText.search(/\s[—\-–:]\s/);
      const title = dashIndex >= 0 ? fullText.slice(0, dashIndex).trim() : fullText;
      const detail = dashIndex >= 0 ? fullText.slice(dashIndex).replace(/^[\s—\-–:]+/, '').trim() : undefined;

      todos.push({ id: bulletId++, title: title.slice(0, 80), status: 'pending', detail });
    }

    return todos;
  }

  /**
   * Validate that required tool parameters are present and of expected types.
   * Returns an error message string if validation fails, or null if valid.
   */
  private validateToolParams(tool: Tool, args: Record<string, unknown>): string | null {
    const schema = tool.definition.parameters as Record<string, unknown>;
    const required = (schema.required ?? []) as string[];
    const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;

    const missing: string[] = [];
    const wrongType: string[] = [];

    for (const param of required) {
      const value = args[param];
      if (value === undefined || value === null) {
        missing.push(param);
        continue;
      }
      const expectedType = properties[param]?.type;
      if (expectedType && typeof value !== expectedType) {
        wrongType.push(`${param} (expected ${expectedType}, got ${typeof value})`);
      }
    }

    if (missing.length > 0 || wrongType.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) { parts.push(`Missing required parameters: ${missing.join(', ')}`); }
      if (wrongType.length > 0) { parts.push(`Wrong parameter types: ${wrongType.join(', ')}`); }
      return parts.join('. ');
    }

    return null;
  }

  /**
   * Format todos into a readable plan text for prompt injection.
   */
  private formatPlanText(todos: TodoItem[]): string {
    if (todos.length === 0) { return '(No structured plan available)'; }
    return todos.map(t =>
      `TODO ${t.id}: ${t.title}${t.detail ? ' — ' + t.detail : ''} [${t.status.toUpperCase()}]`
    ).join('\n');
  }

  /**
   * Parse a ```verification block and update todo statuses.
   */
  private parseVerificationResponse(sessionId: string, response: string, todos: TodoItem[]): void {
    // Try ```verification block first, fall back to full response
    const verifyBlockMatch = response.match(/```verification\s*\n([\s\S]*?)```/);
    const text = verifyBlockMatch ? verifyBlockMatch[1] : response;

    const lineRegex = /TODO\s*(\d+)\s*:\s*(DONE|FAILED|IN-PROGRESS|IN_PROGRESS)\s*\|?\s*(.*)/gi;
    let match: RegExpExecArray | null;
    while ((match = lineRegex.exec(text)) !== null) {
      const id = parseInt(match[1], 10);
      const rawStatus = match[2].toUpperCase().replace('-', '_');
      let status: TodoItemStatus;
      if (rawStatus === 'DONE') { status = 'done'; }
      else if (rawStatus === 'FAILED') { status = 'failed'; }
      else { status = 'in-progress'; }

      this.sessionManager.updateSmartTodoItem(sessionId, id, status);

      // Also update the local array so loop checks are accurate
      const todo = todos.find(t => t.id === id);
      if (todo) { todo.status = status; }
    }

    // If response contains "ALL TODOS VERIFIED", mark everything done
    if (/ALL\s+TODOS?\s+VERIFIED/i.test(response)) {
      for (const todo of todos) {
        if (todo.status !== 'done') {
          todo.status = 'done';
          this.sessionManager.updateSmartTodoItem(sessionId, todo.id, 'done');
        }
      }
    }
  }

  // --- Session handlers ---

  private handleNewChat(): void {
    const session = this.sessionManager.createSession(
      this.registry.getActiveProviderId(),
      this.registry.getActiveModelId()
    );
    this.sessionManager.switchSession(session.id);
    this.postMessage({ type: 'chatCleared' });
    this.sendSessionList();
  }

  private handleSwitchSession(sessionId: string): void {
    const session = this.sessionManager.switchSession(sessionId);
    if (!session) { return; }

    // Replay session's conversation history to the webview
    // Skip internal orchestration messages (marked by smart-todo flow)
    this.postMessage({ type: 'chatCleared' });

    for (const msg of session.history) {
      if (msg.role === 'system') { continue; }
      if (msg.internal) { continue; }
      // Skip empty tool-result messages (they have no visible content)
      if (msg.role === 'user' && !msg.content && msg.toolResults) { continue; }
      this.postMessage({
        type: 'replayMessage',
        role: msg.role,
        content: msg.content,
      });
    }

    // Restore smart-todo state if this session has an active plan
    const smartTodo = this.sessionManager.getSmartTodo(sessionId);
    if (smartTodo) {
      this.postMessage({
        type: 'smartTodoUpdate',
        phase: smartTodo.phase,
        todos: smartTodo.todos,
        iteration: smartTodo.verifyIterations,
      });
    }

    // Restore sandbox state
    this.sendSandboxState();

    // Flush any buffered messages from background execution
    const buffered = this.sessionManager.drainBuffer(sessionId);
    for (const msg of buffered) {
      this.postMessage(msg);
    }

    // If this session is still busy, let the webview know it's streaming
    if (session.status === 'busy') {
      this.postMessage({ type: 'sessionResumed' });
    }

    // Send context usage for this session
    this.sendContextUsage(sessionId);

    this.sendSessionList();
  }

  private handleDeleteSession(sessionId: string): void {
    // Abort if running
    const ctrl = this.abortControllers.get(sessionId);
    if (ctrl) {
      ctrl.abort();
      this.abortControllers.delete(sessionId);
    }

    this.sessionManager.deleteSession(sessionId);

    // If that was the active session, switch view
    const activeSession = this.sessionManager.getActiveSession();
    if (activeSession) {
      this.handleSwitchSession(activeSession.id);
    } else {
      this.postMessage({ type: 'chatCleared' });
    }
    this.sendSessionList();
  }

  private sendSessionList(): void {
    const sessions = this.sessionManager.getSessionList();
    this.postMessage({
      type: 'sessions',
      sessions,
      activeSessionId: this.sessionManager.getActiveSessionId(),
    });
  }

  // --- Profile handlers ---

  private async sendProfiles(): Promise<void> {
    const profiles = await this.profileManager.getProfilesWithStatus();
    this.postMessage({ type: 'profiles', profiles });
  }

  private async handleSaveProfile(
    profile: { id?: string; name: string; apiKind: string; baseUrl: string; modelId: string; enabled: boolean },
    apiKey?: string
  ): Promise<void> {
    try {
      const saved = await this.profileManager.saveProfile(
        {
          id: profile.id,
          name: profile.name,
          apiKind: profile.apiKind as 'anthropic' | 'openai' | 'openai-compatible',
          baseUrl: profile.baseUrl,
          modelId: profile.modelId,
          enabled: profile.enabled,
        },
        apiKey
      );
      this.postMessage({ type: 'profileSaved', profile: saved });
      await this.sendProfiles();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleDeleteProfile(profileId: string): Promise<void> {
    try {
      await this.profileManager.deleteProfile(profileId);
      this.postMessage({ type: 'profileDeleted', profileId });
      await this.sendProfiles();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleValidateApiKey(message: {
    apiKind: string;
    baseUrl: string;
    apiKey: string;
    requestId: string;
  }): Promise<void> {
    try {
      const valid = await this.registry.validateApiKey(
        message.apiKind,
        message.baseUrl,
        message.apiKey
      );
      this.postMessage({
        type: 'validationResult',
        requestId: message.requestId,
        valid,
      });
    } catch {
      this.postMessage({
        type: 'validationResult',
        requestId: message.requestId,
        valid: false,
      });
    }
  }

  private async handleGetModelsForProfile(message: {
    apiKind: string;
    baseUrl: string;
    apiKey: string;
    requestId: string;
  }): Promise<void> {
    try {
      const models = await this.registry.listModelsWithKey(
        message.apiKind,
        message.baseUrl,
        message.apiKey
      );
      this.postMessage({
        type: 'modelsForProfile',
        requestId: message.requestId,
        models,
      });
    } catch {
      this.postMessage({
        type: 'modelsForProfile',
        requestId: message.requestId,
        models: [],
      });
    }
  }

  // --- File reference handlers ---

  private async handleSearchFiles(query: string): Promise<void> {
    if (!query || query.length < 1) {
      this.postMessage({ type: 'fileSearchResults', files: [] });
      return;
    }

    try {
      const pattern = `**/*${query}*`;
      const uris = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 20);
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      const files = uris.map(uri => {
        const fullPath = uri.fsPath;
        const relativePath = workspaceFolder
          ? fullPath.replace(workspaceFolder.uri.fsPath + '/', '')
          : fullPath;
        return relativePath;
      }).sort((a, b) => a.length - b.length);

      this.postMessage({ type: 'fileSearchResults', files });
    } catch {
      this.postMessage({ type: 'fileSearchResults', files: [] });
    }
  }

  private async handleReadFileReference(relativePath: string): Promise<void> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this.postMessage({ type: 'fileReferenceContent', path: relativePath, content: null });
        return;
      }

      const uri = vscode.Uri.joinPath(workspaceFolder.uri, relativePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      this.postMessage({
        type: 'fileReferenceContent',
        path: relativePath,
        content: doc.getText(),
      });
    } catch {
      this.postMessage({ type: 'fileReferenceContent', path: relativePath, content: null });
    }
  }

  // --- Active file handlers ---

  private sendActiveFileState(): void {
    this.postMessage({
      type: 'activeFileState',
      enabled: this.activeFileEnabled,
      file: this.activeFileContext?.path ?? null,
    });
  }

  // --- Mode handlers ---

  private handleGetModes() {
    const modes = this.modeManager.getAllModes();
    const currentMode = this.modeManager.getCurrentMode();
    this.postMessage({
      type: 'modes',
      modes,
      currentModeId: currentMode.id,
    });
  }

  // --- Context handlers ---

  private handleGetContext() {
    const context = this.contextManager.getContextInjection();
    this.postMessage({
      type: 'context',
      skills: context.skills,
      agentsMd: context.agentsMd,
    });
  }

  private handleSetSkillEnabled(sourcePath: string, enabled: boolean) {
    this.contextManager.setSkillEnabled(sourcePath, enabled);
    // Re-send the updated context
    this.handleGetContext();
  }

  // --- MCP handlers ---

  /** Called externally when MCP configs change to refresh the webview */
  public refreshMcpTools(): void {
    if (this.view) {
      this.handleGetMcpServers();
    }
  }

  private handleGetMcpServers() {
    const servers = this.mcpConfigManager.getConfigs();
    const serverList = servers.map(s => ({
      ...s,
      status: this.mcpClient.getServerStatus(s.id).status,
      statusError: this.mcpClient.getServerStatus(s.id).error,
      connected: this.mcpClient.isConnected(s.id),
    }));
    this.postMessage({
      type: 'mcpServers',
      servers: serverList,
    });
  }

  private async handleSaveMcpServer(server: McpServerConfig) {
    try {
      await this.mcpConfigManager.saveConfig(server);
      this.postMessage({ type: 'mcpServerSaved', server });
      await this.handleGetMcpServers();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleDeleteMcpServer(serverId: string) {
    try {
      await this.mcpConfigManager.deleteConfig(serverId);
      this.postMessage({ type: 'mcpServerDeleted', serverId });
      await this.handleGetMcpServers();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleTestMcpConnection(server: McpServerConfig) {
    try {
      // Test connection by creating a temporary client
      const testClient = new McpClient();
      await testClient.connect(server);
      const tools = testClient.getToolsForServer(server.id);
      await testClient.disconnect(server.id);

      this.postMessage({
        type: 'mcpConnectionTest',
        success: true,
        toolCount: tools.length,
      });
    } catch (err) {
      this.postMessage({
        type: 'mcpConnectionTest',
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleOpenMcpGlobalSettings(): Promise<void> {
    try {
      await this.mcpConfigManager.openGlobalSettingsFile();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleOpenMcpWorkspaceSettings(): Promise<void> {
    try {
      await this.mcpConfigManager.openWorkspaceSettingsFile();
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // --- Helpers ---

  /**
   * Extract file paths from tool arguments and emit a fileActivity message
   * so the webview can show which files the model is working on.
   */
  private emitFileActivity(
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>
  ): void {
    // Only emit when sandbox is active
    if (!this.sandboxManager || !this.sandboxManager.getSandboxInfo().isActive) {
      return;
    }

    let filePath: string | undefined;
    let action: 'read' | 'write' | 'list' | 'command' | 'sandbox' = 'command';

    switch (toolName) {
      case 'readFile':
        filePath = args.path as string | undefined;
        action = 'read';
        break;
      case 'writeFile':
        filePath = args.path as string | undefined;
        action = 'write';
        break;
      case 'listFiles':
        filePath = args.pattern as string | undefined;
        action = 'list';
        break;
      case 'runTerminal':
      case 'runSandboxedCommand':
        filePath = args.command as string | undefined;
        action = 'command';
        break;
      case 'createSandbox':
      case 'exitSandbox':
      case 'getSandboxStatus':
        filePath = toolName;
        action = 'sandbox';
        break;
      case 'getDiagnostics':
        filePath = (args.path as string | undefined) ?? 'workspace';
        action = 'read';
        break;
      default:
        // For any other tool (including MCP tools), show the tool name
        filePath = toolName;
        action = 'command';
        break;
    }

    if (!filePath) { return; }

    this.postSessionMessage(sessionId, {
      type: 'fileActivity',
      file: filePath,
      action,
      timestamp: Date.now(),
    });
  }

  /**
   * Apply sandbox changes: merge into main branch and clean up.
   */
  private async handleApplySandbox(): Promise<void> {
    if (!this.sandboxManager) { return; }

    this.postMessage({ type: 'sandboxActionStarted', action: 'apply' });

    const result = await this.sandboxManager.applySandbox();

    this.postMessage({
      type: 'sandboxActionResult',
      action: 'apply',
      success: result.success,
      message: result.message,
    });

    this.sendSandboxState();
  }

  /**
   * Discard sandbox changes: remove worktree and delete branch.
   */
  private async handleDiscardSandbox(): Promise<void> {
    if (!this.sandboxManager) { return; }

    this.postMessage({ type: 'sandboxActionStarted', action: 'discard' });

    const result = await this.sandboxManager.discardSandbox();

    this.postMessage({
      type: 'sandboxActionResult',
      action: 'discard',
      success: result.success,
      message: result.message,
    });

    this.sendSandboxState();
  }

  /**
   * Send a sandbox result card to the webview after the plan loop finishes.
   * Shows changed files and Apply/Undo buttons.
   */
  private async sendSandboxResult(sessionId: string): Promise<void> {
    if (!this.sandboxManager) { return; }
    const info = this.sandboxManager.getSandboxInfo();
    if (!info.isActive || !info.config) { return; }

    const diff = await this.sandboxManager.getSandboxDiff();

    this.postSessionMessage(sessionId, {
      type: 'sandboxResult',
      branchName: info.config.branchName,
      worktreePath: info.config.worktreePath,
      files: diff.files,
      summary: diff.summary,
    });
  }

  /**
   * Send the current sandbox state to the webview.
   */
  private sendSandboxState(): void {
    if (!this.sandboxManager) {
      this.postMessage({ type: 'sandboxState', active: false });
      return;
    }

    const info = this.sandboxManager.getSandboxInfo();
    this.postMessage({
      type: 'sandboxState',
      active: info.isActive,
      branchName: info.config?.branchName ?? null,
      worktreePath: info.config?.worktreePath ?? null,
      osIsolation: info.osLevelIsolation,
    });
  }

  private sendProviderList(): void {
    this.postMessage({
      type: 'providers',
      providers: this.registry.getAllProviders(),
      activeProviderId: this.registry.getActiveProviderId(),
      activeModelId: this.registry.getActiveModelId(),
    });
  }

  private async sendModelList(providerId: string): Promise<void> {
    const models = await this.registry.getModelsForProvider(providerId);
    this.postMessage({ type: 'models', models });
  }

  private async sendModelListForActiveProvider(): Promise<void> {
    const activeId = this.registry.getActiveProviderId();
    if (!activeId) { return; }
    const models = await this.registry.getModelsForProvider(activeId);
    this.postMessage({
      type: 'models',
      models,
      activeModelId: this.registry.getActiveModelId(),
    });
  }

  private postMessage(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  // ===== Context usage tracking & compaction =====

  /**
   * Get the context window size for the currently active model.
   */
  private async getActiveContextWindow(): Promise<number> {
    const activeProviderId = this.registry.getActiveProviderId();
    if (!activeProviderId) { return 0; }
    const models = await this.registry.getModelsForProvider(activeProviderId);
    const activeModelId = this.registry.getActiveModelId();
    const model = models.find(m => m.id === activeModelId);
    return model?.contextWindow ?? 0;
  }

  /**
   * Send current context usage info to the webview.
   */
  private async sendContextUsage(sessionId: string): Promise<void> {
    const usage = this.sessionManager.getTokenUsage(sessionId);
    const contextWindow = await this.getActiveContextWindow();
    // Use inputTokens as the primary context usage metric — it represents the full
    // prompt size from the last API call (all prior messages + system prompt).
    // Output tokens are tracked separately for display but don't add to context pressure
    // since they're already included in the next call's input_tokens.
    const percentage = contextWindow > 0 ? Math.min(Math.round((usage.inputTokens / contextWindow) * 100), 100) : 0;

    this.postSessionMessage(sessionId, {
      type: 'contextUsage',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens,
      contextWindow,
      percentage,
    });
  }

  /**
   * Build a role-labeled digest of the conversation for compaction.
   */
  private buildConversationDigest(sessionId: string): string {
    const history = this.sessionManager.getHistory(sessionId);
    return history
      .filter(m => !m.internal || m.content.includes('[Compacted conversation context]'))
      .map(m => {
        let prefix = m.role.toUpperCase();
        if (m.toolCalls?.length) { prefix += ' (with tool calls: ' + m.toolCalls.map(tc => tc.name).join(', ') + ')'; }
        if (m.toolResults?.length) { prefix += ' (tool results)'; }
        return `[${prefix}]: ${m.content.slice(0, 2000)}`;
      })
      .join('\n\n');
  }

  /**
   * Perform context compaction: ask the LLM to summarize the conversation,
   * then replace the history with the compacted summary.
   */
  private async performCompaction(sessionId: string): Promise<void> {
    const history = this.sessionManager.getHistory(sessionId);
    if (history.length <= 1) { return; }

    const digest = this.buildConversationDigest(sessionId);
    await this.performCompactionWithDigest(sessionId, digest);
  }

  /**
   * Perform compaction using a (possibly user-edited) digest.
   */
  private async performCompactionWithDigest(sessionId: string, editedDigest: string): Promise<void> {
    const provider = this.registry.getActiveProvider();
    if (!provider) { return; }

    try {
      const model = this.registry.getActiveModelId();
      const summaryResponse = await provider.sendMessage(
        [
          { role: 'system', content: ChatViewProvider.COMPACTION_PROMPT },
          { role: 'user', content: `Here is the conversation to summarize:\n\n${editedDigest}` },
        ],
        { model, maxTokens: 2048 },
        () => {} // No streaming needed for compaction
      );

      const summary = summaryResponse.content || 'No summary generated.';
      this.sessionManager.compactHistory(sessionId, summary);

      this.postSessionMessage(sessionId, {
        type: 'streamChunk',
        content: '\n\n\u2705 *Context compacted successfully.*\n',
      });
    } catch (err) {
      this.postSessionMessage(sessionId, {
        type: 'streamChunk',
        content: '\n\n\u26A0\uFE0F *Context compaction failed: ' + (err instanceof Error ? err.message : String(err)) + '*\n',
      });
    }
  }

  /**
   * Handle user-initiated compaction (clicking the context tracker).
   */
  private async handleCompactContext(): Promise<void> {
    const activeId = this.sessionManager.getActiveSessionId();
    if (!activeId) { return; }

    const session = this.sessionManager.getActiveSession();
    if (!session || session.status === 'busy') {
      this.postMessage({ type: 'error', message: 'Cannot compact while the agent is busy.' });
      return;
    }

    this.postMessage({
      type: 'streamChunk',
      content: '\n\n\u{1F504} *Compacting context...*\n',
    });

    await this.performCompaction(activeId);
    this.sendContextUsage(activeId);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'ui', 'styles.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'src', 'webview', 'ui', 'main.js')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link href="${stylesUri}" rel="stylesheet">
  <title>YOLO Agent</title>
</head>
<body>
  <div id="app">
    <!-- Chat View -->
    <div id="chat-view">
      <!-- Input area at top -->
      <div id="input-section">
        <div class="input-header">
          <div id="mode-picker" class="mode-picker">
            <button id="mode-picker-btn" class="mode-picker-btn" title="Select mode"></button>
            <div id="mode-dropdown" class="mode-dropdown hidden"></div>
          </div>
          <select id="provider-select" title="Select provider">
            <option value="">No providers</option>
          </select>
          <div id="model-picker" class="model-picker">
            <input id="model-input" type="text" placeholder="Search models…" title="Select model" autocomplete="off" spellcheck="false" />
            <div id="model-dropdown" class="model-dropdown hidden"></div>
          </div>
          <button id="new-chat-btn" title="New chat">+</button>
          <button id="sessions-btn" title="Sessions">\u2630</button>
          <button id="context-btn" title="Context">\u2295</button>
          <button id="settings-btn" title="Settings">\u2699\uFE0E</button>
        </div>
        <div id="file-chips" class="file-chips hidden"></div>
        <div class="input-wrapper">
          <textarea id="message-input" placeholder="Ask YOLO Agent... (@ to reference files)" rows="1" data-autoresize></textarea>
          <div class="send-btn-group">
            <button id="send-btn" title="Send">\u27A4</button>
            <button id="send-mode-btn" class="send-mode-caret" title="Send mode">\u25BE</button>
            <div id="send-mode-menu" class="send-mode-menu hidden">
              <button class="send-mode-option" data-mode="steer" title="Interrupt &amp; send immediately (Enter)">\u26A1 Steer <kbd>Enter</kbd></button>
              <button class="send-mode-option" data-mode="queue" title="Add to queue (Ctrl+Enter)">\u{1F4CB} Queue <kbd>Ctrl+Enter</kbd></button>
            </div>
          </div>
        </div>
        <div id="autocomplete-dropdown" class="autocomplete-dropdown hidden"></div>
        <div class="steering-row">
          <button class="steering-btn" data-steer="continue">Continue</button>
          <button class="steering-btn" data-steer="retry">Retry</button>
          <button class="steering-btn" data-steer="summarize">Summarize</button>
          <button class="steering-btn" data-steer="expand">Expand</button>
        </div>
      </div>

      <!-- Messages in middle -->
      <div id="messages"></div>

      <!-- Compaction countdown banner -->
      <div id="compaction-banner" class="compaction-banner hidden">
        <span id="compaction-banner-text"></span>
        <div class="compaction-banner-actions">
          <button id="compaction-edit-btn" class="secondary-btn btn-sm">Edit Context</button>
          <button id="compaction-now-btn" class="primary-btn btn-sm">Compact Now</button>
        </div>
      </div>

      <!-- Controls at bottom -->
      <div id="controls-section">
        <div class="control-row">
          <span id="current-mode-display" class="control-value" title="Current mode">Sandbox</span>
          <span class="control-separator">\u00B7</span>
          <label id="planning-toggle" class="planning-toggle" title="Restrict tools to read-only (planning mode)">
            <input type="checkbox" id="planning-checkbox" />
            <span class="planning-label">Plan</span>
          </label>
          <span class="control-separator">\u00B7</span>
          <button id="active-file-toggle" class="active-file-btn" title="Toggle active file as context">
            <span id="active-file-display">None</span>
          </button>
          <span class="control-separator">\u00B7</span>
          <button id="context-tracker" class="context-tracker" title="Click to compact context">
            <span id="context-tracker-bar" class="context-tracker-bar"><span id="context-tracker-fill" class="context-tracker-fill"></span></span>
            <span id="context-tracker-label" class="context-tracker-label">0%</span>
          </button>
          <span class="control-separator">\u00B7</span>
          <span style="flex:1"></span>
          <span id="api-spinner" class="api-spinner hidden">
            <span class="spinner-dot"></span> Waiting for API...
          </span>
          <button id="stop-btn" class="stop-btn" title="Stop generation" disabled>\u25A0</button>
        </div>
        <div id="sandbox-activity" class="sandbox-activity hidden">
          <div class="sandbox-activity-header">
            <span class="sandbox-activity-icon">\u{1F6E1}</span>
            <span id="sandbox-branch-name" class="sandbox-branch">sandbox</span>
            <span class="sandbox-activity-dot"></span>
          </div>
          <div id="sandbox-file-list" class="sandbox-file-list"></div>
        </div>
        <div id="sandbox-result" class="sandbox-result hidden">
          <div class="sandbox-result-header">
            <span class="sandbox-result-icon">\u{1F4E6}</span>
            <span class="sandbox-result-title">Sandbox Complete</span>
          </div>
          <div id="sandbox-result-branch" class="sandbox-result-branch"></div>
          <div id="sandbox-result-files" class="sandbox-result-files"></div>
          <div id="sandbox-result-summary" class="sandbox-result-summary"></div>
          <div class="sandbox-result-actions">
            <button id="sandbox-apply-btn" class="sandbox-btn sandbox-btn-apply" title="Merge sandbox branch into your main branch">\u2714 Apply</button>
            <button id="sandbox-discard-btn" class="sandbox-btn sandbox-btn-discard" title="Delete the sandbox branch and worktree">\u2716 Discard</button>
          </div>
          <div id="sandbox-action-status" class="sandbox-action-status hidden"></div>
        </div>
        <div id="queue-section" class="hidden">
          <div class="queue-header">
            <span class="queue-label">Queue</span>
            <span id="queue-count" class="queue-count">0</span>
          </div>
          <div id="queue-list"></div>
        </div>
      </div>
    </div>

    <!-- Sessions Drawer -->
    <div id="sessions-view" class="hidden">
      <div id="sessions-header">
        <button id="sessions-back-btn" title="Back to chat">\u2190</button>
        <span class="header-title">Sessions</span>
      </div>
      <div id="sessions-list"></div>
    </div>

    <!-- Digest Editor (compaction) -->
    <div id="digest-view" class="hidden">
      <div id="digest-header">
        <button id="digest-back-btn" title="Cancel compaction">\u2190</button>
        <span class="header-title">Edit Context Before Compaction</span>
      </div>
      <div id="digest-content">
        <p class="digest-hint">Edit the conversation digest below. The AI will summarize this into a compact context.</p>
        <textarea id="digest-textarea" spellcheck="false"></textarea>
        <div class="digest-actions">
          <button id="digest-compact-btn" class="primary-btn">Compact This</button>
          <button id="digest-cancel-btn" class="secondary-btn">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Settings: Provider List -->
    <div id="settings-view" class="hidden">
      <div id="settings-header">
        <button id="settings-back-btn" title="Back to chat">\u2190</button>
        <span class="header-title">Settings</span>
      </div>
      <div class="settings-container">
        <nav id="settings-sidebar" role="navigation" aria-label="Settings navigation">
          <button class="sidebar-item active" data-tab="general" aria-current="page">
            <span class="sidebar-icon">\u2699</span>
            <span class="sidebar-label">General</span>
          </button>
          <button class="sidebar-item" data-tab="providers">
            <span class="sidebar-icon">\u{1F50C}</span>
            <span class="sidebar-label">Providers</span>
          </button>
          <button class="sidebar-item" data-tab="mcp">
            <span class="sidebar-icon">\u{1F517}</span>
            <span class="sidebar-label">MCP Servers</span>
          </button>
        </nav>
        <div id="settings-content">
          <div id="general-panel">
          <div class="settings-section">
            <h3>Context Compaction</h3>
            <div class="form-group">
              <label>Compaction Method</label>
              <div class="radio-group" id="compaction-method-group">
                <label class="radio-label">
                  <input type="radio" name="compaction-method" value="semi-automatic" checked>
                  <span>Semi-automatic with timeout</span>
                  <span class="radio-description">Waits for you to manually edit context; auto-compacts if no response</span>
                </label>
                <label class="radio-label">
                  <input type="radio" name="compaction-method" value="automatic">
                  <span>Automatic (immediate)</span>
                  <span class="radio-description">Immediately summarizes context automatically</span>
                </label>
                <label class="radio-label">
                  <input type="radio" name="compaction-method" value="manual">
                  <span>Manual</span>
                  <span class="radio-description">Only manual edits will resume the agent</span>
                </label>
              </div>
            </div>
            <div class="form-group" id="timeout-group">
              <label>Automatic compaction timeout</label>
              <div class="timeout-control">
                <input type="range" id="compaction-timeout" min="10" max="300" value="60" step="5" class="timeout-slider">
                <span id="timeout-value" class="timeout-value">60s</span>
              </div>
              <div class="timeout-presets">
                <button class="timeout-preset" data-value="15">15s</button>
                <button class="timeout-preset" data-value="30">30s</button>
                <button class="timeout-preset" data-value="60">60s</button>
                <button class="timeout-preset" data-value="120">2m</button>
                <button class="timeout-preset" data-value="300">5m</button>
              </div>
            </div>
          </div>
          </div>
          <div id="providers-panel" class="hidden">
            <div id="profiles-list"></div>
            <button id="add-profile-btn" class="primary-btn">+ Add Provider</button>
          </div>
          <div id="mcp-panel" class="hidden">
            <div id="mcp-servers-inline-list"></div>
            <button id="mcp-settings-btn" class="primary-btn">Manage MCP Servers</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Settings: Profile Editor -->
    <div id="editor-view" class="hidden">
      <div id="editor-header">
        <button id="editor-back-btn" title="Back to settings">\u2190</button>
        <span id="editor-title" class="header-title">Add Provider</span>
      </div>
      <div id="editor-content">
        <div class="form-group">
          <label for="profile-name">Name</label>
          <input type="text" id="profile-name" placeholder="e.g., My Claude Account">
        </div>
        <div class="form-group">
          <label for="profile-api-kind">API Kind</label>
          <select id="profile-api-kind">
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="openai-compatible">OpenAI Compatible</option>
          </select>
        </div>
        <div class="form-group">
          <label for="profile-base-url">Base URL</label>
          <input type="text" id="profile-base-url" placeholder="https://api.example.com/v1">
        </div>
        <div class="form-group">
          <label for="profile-api-key">API Key</label>
          <div class="input-with-btn">
            <input type="password" id="profile-api-key" placeholder="sk-...">
            <button id="toggle-key-btn" title="Show/hide key" class="icon-btn">\u{1F441}</button>
          </div>
        </div>
        <div class="form-group">
          <label for="profile-model">Model</label>
          <div class="input-with-btn">
            <select id="profile-model">
              <option value="">Enter API key first</option>
            </select>
            <button id="refresh-models-btn" title="Refresh models" class="icon-btn">\u21BB</button>
          </div>
        </div>
        <div class="form-group checkbox-group">
          <label>
            <input type="checkbox" id="profile-enabled" checked>
            Enabled
          </label>
        </div>
        <div class="editor-actions">
          <button id="save-profile-btn" class="primary-btn">Save</button>
          <button id="cancel-profile-btn" class="secondary-btn">Cancel</button>
        </div>
        <div id="delete-profile-area" class="hidden">
          <button id="delete-profile-btn" class="danger-btn">Delete Provider</button>
        </div>
      </div>
    </div>

    <!-- Context View -->
    <div id="context-view" class="hidden">
      <div id="context-header">
        <button id="context-back-btn" title="Back to chat">\u2190</button>
        <span class="header-title">Context</span>
      </div>
      <div id="context-content">
        <div id="context-skills-section">
          <h3>Skills</h3>
          <div id="context-skills-list"></div>
        </div>
        <div id="context-agents-section">
          <h3>Context Files</h3>
          <div id="context-agents-list"></div>
        </div>
      </div>
    </div>

    <!-- MCP Server List View (nested in Settings) -->
    <div id="mcp-view" class="hidden">
      <div id="mcp-header">
        <button id="mcp-back-btn" title="Back to settings">\u2190</button>
        <span class="header-title">MCP Servers</span>
      </div>
      <div id="mcp-content">
        <div class="mcp-settings-actions">
          <button id="edit-mcp-global-settings-btn" class="secondary-btn">🌐 Edit Global Settings</button>
          <button id="edit-mcp-workspace-settings-btn" class="secondary-btn">📁 Edit Workspace Settings</button>
        </div>
        <div class="mcp-json-hint">
          <strong>JSON format</strong>
          <div class="mcp-json-hint-text">Top-level object: <code>{ "version": 1, "servers": [...] }</code>. Each server requires <code>id</code>, <code>name</code>, <code>enabled</code>, and <code>transport</code> (<code>"stdio"</code> or <code>"sse"</code>). For <code>stdio</code>: use <code>command</code>, optional <code>args</code> and <code>env</code>. For <code>sse</code>: use <code>url</code>. Workspace settings override global settings when IDs match.</div>
          <pre class="mcp-json-hint-example">{
  "version": 1,
  "servers": [
    {
      "id": "filesystem",
      "name": "Filesystem",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "env": {
        "NODE_ENV": "production"
      }
    },
    {
      "id": "github",
      "name": "GitHub MCP",
      "enabled": true,
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "\${env:GITHUB_TOKEN}"
      }
    },
    {
      "id": "remote-sse",
      "name": "Remote SSE",
      "enabled": false,
      "transport": "sse",
      "url": "https://example.com/sse"
    }
  ]
}</pre>
        </div>
        <div id="mcp-servers-list"></div>
        <button id="add-mcp-server-btn" class="primary-btn">+ Add MCP Server</button>
      </div>
    </div>

    <!-- MCP Server Editor View -->
    <div id="mcp-editor-view" class="hidden">
      <div id="mcp-editor-header">
        <button id="mcp-editor-back-btn" title="Back to MCP servers">\u2190</button>
        <span id="mcp-editor-title" class="header-title">Add MCP Server</span>
      </div>
      <div id="mcp-editor-content">
        <div class="form-group">
          <label for="mcp-name">Name</label>
          <input type="text" id="mcp-name" placeholder="e.g., filesystem">
        </div>
        <div class="form-group">
          <label for="mcp-transport">Transport</label>
          <select id="mcp-transport">
            <option value="stdio">STDIO</option>
            <option value="sse">SSE</option>
          </select>
        </div>
        <div id="mcp-stdio-group">
          <div class="form-group">
            <label for="mcp-command">Command</label>
            <input type="text" id="mcp-command" placeholder="e.g., npx">
          </div>
          <div class="form-group">
            <label for="mcp-args">Arguments (space-separated)</label>
            <input type="text" id="mcp-args" placeholder="e.g., @modelcontextprotocol/server-filesystem">
          </div>
        </div>
        <div id="mcp-sse-group" class="hidden">
          <div class="form-group">
            <label for="mcp-url">URL</label>
            <input type="text" id="mcp-url" placeholder="https://example.com/sse">
          </div>
        </div>
        <div class="form-group checkbox-group">
          <label>
            <input type="checkbox" id="mcp-enabled" checked>
            Enabled
          </label>
        </div>
        <div class="editor-actions">
          <button id="test-mcp-btn" class="secondary-btn">Test Connection</button>
        </div>
        <div class="editor-actions">
          <button id="save-mcp-btn" class="primary-btn">Save</button>
          <button id="cancel-mcp-btn" class="secondary-btn">Cancel</button>
        </div>
        <div id="delete-mcp-area" class="hidden">
          <button id="delete-mcp-btn" class="danger-btn">Delete Server</button>
        </div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
