import * as vscode from 'vscode';
import { ProviderRegistry } from '../providers/registry';
import { ProfileManager } from '../providers/profile-manager';
import { Tool } from '../tools/types';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'yoloAgent.chatView';

  private view?: vscode.WebviewView;
  private registry: ProviderRegistry;
  private profileManager: ProfileManager;
  private tools: Map<string, Tool>;
  private extensionUri: vscode.Uri;
  private conversationHistory: { role: string; content: string }[] = [];

  constructor(
    extensionUri: vscode.Uri,
    registry: ProviderRegistry,
    profileManager: ProfileManager,
    tools: Map<string, Tool>
  ) {
    this.extensionUri = extensionUri;
    this.registry = registry;
    this.profileManager = profileManager;
    this.tools = tools;
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
      }
    });

    // Send initial data
    this.sendProviderList();

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

    this.conversationHistory.push({ role: 'user', content: text });

    const toolDefs = Array.from(this.tools.values()).map((t) => t.definition);

    try {
      const model = this.registry.getActiveModelId();

      const response = await provider.sendMessage(
        this.conversationHistory.map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: m.content,
        })),
        { model, tools: toolDefs },
        (chunk) => {
          this.postMessage({ type: 'streamChunk', content: chunk });
        }
      );

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
        <select id="provider-select" title="Select provider">
          <option value="">No providers</option>
        </select>
        <button id="new-chat-btn" title="New chat">+</button>
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
      <div id="settings-content">
        <div id="profiles-list"></div>
        <button id="add-profile-btn" class="primary-btn">+ Add Provider</button>
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
