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
import { AskQuestionTool } from '../tools/question';
import { SandboxManager } from '../sandbox/manager';

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
- Work through the TODO items in order.
- Use the available tools to read, write, and run commands as needed.
- After completing each item, mention which TODO you just finished.
- Do NOT skip items. If one depends on another, complete the dependency first.
- When you finish all items, say "ALL TODOS COMPLETE".`;

  private static readonly SMART_TODO_VERIFY_PROMPT = `You are a QA verification assistant. You were given a plan and the AI attempted to complete it. Now verify the work.

**Original user request:**
{USER_REQUEST}

**Plan:**
{PLAN}

**Instructions:**
1. For EACH TODO item, verify whether it was actually completed by reading files, running tests, and checking diagnostics.
2. Include E2E / integration testing where applicable.
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
- If all items are DONE, end with "ALL TODOS VERIFIED".`;

  // ===== Instance fields =====

  private view?: vscode.WebviewView;
  private registry: ProviderRegistry;
  private profileManager: ProfileManager;
  private modeManager: ModeManager;
  private tools: Map<string, Tool>;
  private extensionUri: vscode.Uri;
  private sessionManager: SessionManager;
  private abortControllers = new Map<string, AbortController>();
  private contextManager: ContextManager;
  private mcpConfigManager: McpConfigManager;
  private mcpClient: McpClient;
  private activeFileContext: { path: string; content: string } | null = null;
  private activeFileEnabled = false;
  private sandboxManager?: SandboxManager;

  constructor(
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
              const ctrl = this.abortControllers.get(activeId);
              if (ctrl) {
                ctrl.abort();
                this.abortControllers.delete(activeId);
              }
            }
            // Cancel any pending askQuestion tool
            const askToolCancel = this.tools.get('askQuestion');
            if (askToolCancel && (askToolCancel as unknown as AskQuestionTool).hasPendingQuestion()) {
              (askToolCancel as unknown as AskQuestionTool).cancelPending();
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
      }
    });

    // Send initial data
    this.sendProviderList();
    this.handleGetModes();
    this.handleGetContext();
    this.sendSessionList();
    this.sendSandboxState();

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
  ): Promise<string> {
    const provider = this.registry.getActiveProvider()!;

    // Get allowed tools based on current mode
    const allToolNames = Array.from(this.tools.keys());
    const allowedToolNames = this.modeManager.getAllowedTools(allToolNames);
    const allowedTools = allowedToolNames.map(name => this.tools.get(name)!.definition);

    // Build system prompt
    let modePrompt = systemPromptOverride ?? this.modeManager.getSystemPrompt();

    // Add context from skills and AGENTS.md
    const contextAddition = this.contextManager.getSystemPromptAddition();
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
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: modePrompt },
      ...history,
      { role: 'user', content: userText },
    ];

    this.sessionManager.addMessage(sessionId, { role: 'user', content: userText });
    this.sessionManager.setSessionStatus(sessionId, 'busy');

    const abortCtrl = new AbortController();
    this.abortControllers.set(sessionId, abortCtrl);

    let responseText = '';
    let firstChunkReceived = false;
    try {
      const model = this.registry.getActiveModelId();

      this.postSessionMessage(sessionId, { type: 'waitingForApi' });

      const response = await provider.sendMessage(
        messages,
        { model, tools: allowedTools, signal: abortCtrl.signal },
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

      if (response.thinking) {
        this.postSessionMessage(sessionId, { type: 'thinking', content: response.thinking });
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          this.postSessionMessage(sessionId, {
            type: 'toolCallStarted',
            name: toolCall.name,
            id: toolCall.id,
          });

          // Emit file activity for sandbox progress tracking
          this.emitFileActivity(sessionId, toolCall.name, toolCall.arguments);

          const tool = this.tools.get(toolCall.name);
          if (tool) {
            // Special handling for askQuestion: post the question to the webview
            // before executing (execute() will block until the user answers)
            if (toolCall.name === 'askQuestion') {
              this.postSessionMessage(sessionId, {
                type: 'askQuestion',
                question: (toolCall.arguments.question as string) || 'The assistant has a question for you.',
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
              continue;
            }

            try {
              const result = await tool.execute(toolCall.arguments);
              this.postSessionMessage(sessionId, {
                type: 'toolCallResult',
                id: toolCall.id,
                name: toolCall.name,
                content: result.content,
                isError: result.isError,
              });
            } catch (toolErr) {
              this.postSessionMessage(sessionId, {
                type: 'toolCallResult',
                id: toolCall.id,
                name: toolCall.name,
                content: `Tool execution error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`,
                isError: true,
              });
            }
          } else {
            this.postSessionMessage(sessionId, {
              type: 'toolCallResult',
              id: toolCall.id,
              name: toolCall.name,
              content: `Unknown tool: ${toolCall.name}`,
              isError: true,
            });
          }
        }
      }

      this.postSessionMessage(sessionId, { type: 'messageComplete' });

      responseText = response.content ?? '';
      if (responseText) {
        this.sessionManager.addMessage(sessionId, {
          role: 'assistant',
          content: responseText,
        });
      }
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
      // Use the session's abort controller if available
      const abortCtrl = this.abortControllers.get(sessionId);
      const response = await provider.sendMessage(
        messages,
        { model, signal: abortCtrl?.signal },  // no tools!
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
      this.postSessionMessage(sessionId, { type: 'messageComplete' });
    } catch (err) {
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
    // Initialize smart-todo state
    this.sessionManager.initSmartTodo(sessionId, userText);

    // If in sandboxed-smart-todo mode, prepend sandbox context to all prompts
    const isSandboxed = this.modeManager.isSandboxedSmartTodoMode();
    const sandboxPreamble = isSandboxed
      ? `**SANDBOX MODE ACTIVE:** You are working inside a sandboxed environment with OS-level isolation. ` +
        `Use runSandboxedCommand for isolated command execution. ` +
        `Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked. ` +
        `Create a sandbox with createSandbox for full git worktree + OS-level isolation if needed.\n\n`
      : '';

    // Notify the webview that we're in smart-todo mode
    this.postSessionMessage(sessionId, {
      type: 'smartTodoUpdate',
      phase: 'planning',
      todos: [],
      iteration: 0,
    });

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

      await this.executePlanLoop(sessionId, userText, todos, sandboxPreamble);
    } catch (err) {
      // Errors in individual rounds are already reported; this catches unexpected breaks
      if (!(err instanceof Error && err.message.includes('abort'))) {
        this.postSessionMessage(sessionId, {
          type: 'error',
          message: `Smart To-Do loop error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
      ? `**SANDBOX MODE ACTIVE:** You are working inside a sandboxed environment with OS-level isolation. ` +
        `Use runSandboxedCommand for isolated command execution. ` +
        `Dangerous commands (sudo, pkill, killall, rm -rf /, etc.) are always blocked. ` +
        `Create a sandbox with createSandbox for full git worktree + OS-level isolation if needed.\n\n`
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

      await this.executePlanLoop(sessionId, smartTodo.userRequest, todos, sandboxPreamble);
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('abort'))) {
        this.postSessionMessage(sessionId, {
          type: 'error',
          message: `Smart To-Do loop error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
    const maxIter = this.sessionManager.getSmartTodo(sessionId)?.maxIterations ?? 5;

    while (iteration < maxIter) {
      // Check if aborted
      if (!this.sessionManager.getSession(sessionId)) { break; }

      // ── Execution pass ──────────────────────────────────────────────
      const execPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_EXECUTION_PROMPT
        .replace('{PLAN}', planText);

      const pendingItems = todos.filter(t => t.status !== 'done').map(t => `- TODO ${t.id}: ${t.title}`).join('\n');
      const execUserMsg = iteration === 0
        ? `Please implement the plan now. Here is the original request:\n\n${userText}`
        : `Some TODOs are still incomplete. Please fix the following items:\n\n${pendingItems}\n\nOriginal request: ${userText}`;

      await this.sendOneLLMRound(sessionId, execUserMsg, undefined, execPrompt);

      // ── Verification pass ───────────────────────────────────────────
      this.sessionManager.setSmartTodoPhase(sessionId, 'verifying');
      iteration = this.sessionManager.incrementVerifyIteration(sessionId);

      this.postSessionMessage(sessionId, {
        type: 'smartTodoUpdate',
        phase: 'verifying',
        todos: this.sessionManager.getSmartTodo(sessionId)?.todos ?? [],
        iteration,
      });

      const verifyPrompt = sandboxPreamble + ChatViewProvider.SMART_TODO_VERIFY_PROMPT
        .replace('{USER_REQUEST}', userText)
        .replace('{PLAN}', planText);

      const verifyResponse = await this.sendOneLLMRound(
        sessionId,
        `Verify the current state of all TODOs. This is verification iteration ${iteration}.`,
        undefined,
        verifyPrompt,
      );

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
        this.postSessionMessage(sessionId, { type: 'messageComplete' });
        break;
      }

      // Loop back to execution
      this.sessionManager.setSmartTodoPhase(sessionId, 'executing');
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

    // Strategy 1: "TODO N: Title — Description"
    const todoRegex = /TODO\s*(\d+)\s*:\s*(.+)/gi;
    let match: RegExpExecArray | null;
    while ((match = todoRegex.exec(text)) !== null) {
      const id = parseInt(match[1], 10);
      const fullText = match[2].trim();
      const dashIndex = fullText.search(/\s[—\-–]\s/);
      const title = dashIndex >= 0 ? fullText.slice(0, dashIndex).trim() : fullText;
      const detail = dashIndex >= 0 ? fullText.slice(dashIndex).replace(/^[\s—\-–]+/, '').trim() : undefined;

      todos.push({ id, title, status: 'pending', detail });
    }

    if (todos.length > 0) { return todos; }

    // Strategy 2: numbered list "1. Title" or "1) Title" — common LLM fallback
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

    // Strategy 3: bullet list "- Title" or "* Title"
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
    this.postMessage({ type: 'chatCleared' });

    for (const msg of session.history) {
      if (msg.role === 'system') { continue; }
      this.postMessage({
        type: 'replayMessage',
        role: msg.role,
        content: msg.content,
      });
    }

    // Flush any buffered messages from background execution
    const buffered = this.sessionManager.drainBuffer(sessionId);
    for (const msg of buffered) {
      this.postMessage(msg);
    }

    // If this session is still busy, let the webview know it's streaming
    if (session.status === 'busy') {
      this.postMessage({ type: 'sessionResumed' });
    }

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

  private handleGetMcpServers() {
    const servers = this.mcpConfigManager.getConfigs();
    const serverList = servers.map(s => ({
      ...s,
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
          <select id="mode-select" title="Select mode"></select>
          <select id="provider-select" title="Select provider">
            <option value="">No providers</option>
          </select>
          <select id="model-select" title="Select model">
            <option value="">No model</option>
          </select>
          <button id="new-chat-btn" title="New chat">+</button>
          <button id="sessions-btn" title="Sessions">\u2630</button>
          <button id="context-btn" title="Context">\u2295</button>
          <button id="settings-btn" title="Settings">\u2699\uFE0E</button>
        </div>
        <div id="file-chips" class="file-chips hidden"></div>
        <div class="input-wrapper">
          <textarea id="message-input" placeholder="Ask YOLO Agent... (@ to reference files)" rows="1" data-autoresize></textarea>
          <button id="send-btn" title="Send" disabled>\u27A4</button>
        </div>
        <div id="autocomplete-dropdown" class="autocomplete-dropdown hidden"></div>
      </div>

      <!-- Messages in middle -->
      <div id="messages"></div>

      <!-- Controls at bottom -->
      <div id="controls-section">
        <div class="control-row">
          <span id="current-mode-display" class="control-value" title="Current mode">Sandbox</span>
          <span class="control-separator">\u00B7</span>
          <button id="active-file-toggle" class="active-file-btn" title="Toggle active file as context">
            <span id="active-file-display">None</span>
          </button>
          <span class="control-separator">\u00B7</span>
          <button class="steering-btn" data-steer="continue">Continue</button>
          <button class="steering-btn" data-steer="retry">Retry</button>
          <button class="steering-btn" data-steer="summarize">Summarize</button>
          <button class="steering-btn" data-steer="expand">Expand</button>
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

    <!-- Settings: Provider List -->
    <div id="settings-view" class="hidden">
      <div id="settings-header">
        <button id="settings-back-btn" title="Back to chat">\u2190</button>
        <span class="header-title">Settings</span>
      </div>
      <div id="settings-tabs">
        <button id="tab-providers" class="tab-btn active">Providers</button>
        <button id="tab-mcp" class="tab-btn">MCP Servers</button>
      </div>
      <div id="settings-content">
        <div id="providers-panel">
          <div id="profiles-list"></div>
          <button id="add-profile-btn" class="primary-btn">+ Add Provider</button>
        </div>
        <div id="mcp-panel" class="hidden">
          <div id="mcp-servers-inline-list"></div>
          <button id="mcp-settings-btn" class="primary-btn">Manage MCP Servers</button>
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
          <h3>AGENTS.md Files</h3>
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
