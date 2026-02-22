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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'yoloAgent.chatView';

  private view?: vscode.WebviewView;
  private registry: ProviderRegistry;
  private profileManager: ProfileManager;
  private modeManager: ModeManager;
  private tools: Map<string, Tool>;
  private extensionUri: vscode.Uri;
  private conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  private contextManager: ContextManager;
  private mcpConfigManager: McpConfigManager;
  private mcpClient: McpClient;

  constructor(
    extensionUri: vscode.Uri,
    registry: ProviderRegistry,
    profileManager: ProfileManager,
    modeManager: ModeManager,
    tools: Map<string, Tool>,
    contextManager: ContextManager,
    mcpConfigManager: McpConfigManager,
    mcpClient: McpClient
  ) {
    this.extensionUri = extensionUri;
    this.registry = registry;
    this.profileManager = profileManager;
    this.modeManager = modeManager;
    this.tools = tools;
    this.contextManager = contextManager;
    this.mcpConfigManager = mcpConfigManager;
    this.mcpClient = mcpClient;
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
          await this.handleSendMessage(message.text);
          break;
        case 'switchProvider':
          this.registry.setActiveProvider(message.providerId);
          break;
        case 'getProviders':
          this.sendProviderList();
          break;
        case 'getModels':
          await this.sendModelList(message.providerId);
          break;
        case 'cancelRequest':
          break;
        case 'newChat':
          this.conversationHistory = [];
          this.postMessage({ type: 'chatCleared' });
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
      }
    });

    // Send initial data
    this.sendProviderList();
    this.handleGetModes();
    this.handleGetContext();

    // Re-send provider list when profiles change
    this.profileManager.onDidChangeProfiles(() => {
      this.sendProviderList();
    });
  }

  // --- Chat handlers ---

  private async handleSendMessage(text: string): Promise<void> {
    const provider = this.registry.getActiveProvider();
    if (!provider) {
      this.postMessage({
        type: 'error',
        message: 'No active provider. Please add a provider in settings.',
      });
      return;
    }

    // Get allowed tools based on current mode
    const allToolNames = Array.from(this.tools.keys());
    const allowedToolNames = this.modeManager.getAllowedTools(allToolNames);
    const allowedTools = allowedToolNames.map(name => this.tools.get(name)!.definition);

    // Add mode system prompt
    let modePrompt = this.modeManager.getSystemPrompt();

    // Add context from skills and AGENTS.md
    const contextAddition = this.contextManager.getSystemPromptAddition();
    if (contextAddition) {
      modePrompt += '\n\n' + contextAddition;
    }

    const userMessage = { role: 'user' as const, content: text };
    const messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }> = [
      { role: 'system', content: modePrompt },
      ...this.conversationHistory,
      userMessage,
    ];

    this.conversationHistory.push({ role: 'user', content: text });

    try {
      const model = this.registry.getActiveModelId();

      const response = await provider.sendMessage(
        messages,
        { model, tools: allowedTools },
        (chunk) => {
          this.postMessage({ type: 'streamChunk', content: chunk });
        }
      );

      // Send thinking content if present (for Claude extended thinking and OpenAI o-series)
      if (response.thinking) {
        this.postMessage({ type: 'thinking', content: response.thinking });
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const toolCall of response.toolCalls) {
          this.postMessage({
            type: 'toolCallStarted',
            name: toolCall.name,
            id: toolCall.id,
          });

          const tool = this.tools.get(toolCall.name);
          if (tool) {
            const result = await tool.execute(toolCall.arguments);
            this.postMessage({
              type: 'toolCallResult',
              id: toolCall.id,
              name: toolCall.name,
              content: result.content,
              isError: result.isError,
            });
          }
        }
      }

      this.postMessage({ type: 'messageComplete' });

      if (response.content) {
        this.conversationHistory.push({
          role: 'assistant',
          content: response.content,
        });
      }
    } catch (err) {
      this.postMessage({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
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

  private sendProviderList(): void {
    this.postMessage({
      type: 'providers',
      providers: this.registry.getAllProviders(),
      activeProviderId: this.registry.getActiveProviderId(),
    });
  }

  private async sendModelList(providerId: string): Promise<void> {
    const models = await this.registry.getModelsForProvider(providerId);
    this.postMessage({ type: 'models', models });
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
      <div id="header">
        <select id="mode-select" title="Select mode"></select>
        <select id="provider-select" title="Select provider">
          <option value="">No providers</option>
        </select>
        <button id="new-chat-btn" title="New chat">+</button>
        <button id="context-btn" title="Context">\u{1F4D6}</button>
        <button id="settings-btn" title="Settings">\u2699</button>
      </div>
      <div id="messages"></div>
      <div id="input-area">
        <textarea id="message-input" placeholder="Ask YOLO Agent..." rows="3"></textarea>
        <button id="send-btn" title="Send">Send</button>
      </div>
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
