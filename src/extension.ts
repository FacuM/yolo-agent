import * as vscode from 'vscode';
import { ProfileManager } from './providers/profile-manager';
import { ProviderRegistry } from './providers/registry';
import { ChatViewProvider } from './webview/panel';
import { Tool } from './tools/types';
import { ReadFileTool, WriteFileTool, ListFilesTool } from './tools/file-ops';
import { RunTerminalTool } from './tools/terminal';
import { GetDiagnosticsTool } from './tools/diagnostics';
import { ModeManager } from './modes/manager';
import { ContextManager } from './context/manager';
import { McpConfigManager } from './mcp/config';
import { McpClient } from './mcp/client';
import { McpToolBridge } from './mcp/bridge';

let profileManager: ProfileManager;
let registry: ProviderRegistry;
let mcpConfigManager: McpConfigManager;
let mcpClient: McpClient;
let mcpToolBridge: McpToolBridge;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  // Initialize profile manager and provider registry
  profileManager = new ProfileManager(context.globalState, context.secrets);
  registry = new ProviderRegistry(profileManager);
  await registry.initialize();

  // Initialize mode manager
  const modeManager = new ModeManager(context);
  await modeManager.initialize();

  // Initialize context manager
  const contextManager = new ContextManager();
  await contextManager.initialize();

  // Initialize MCP components
  mcpConfigManager = new McpConfigManager(context.globalState, vscode.workspace.workspaceFolders || []);
  await mcpConfigManager.initialize();
  mcpClient = new McpClient();
  mcpToolBridge = new McpToolBridge(mcpClient);

  // Connect to enabled MCP servers
  const enabledMcpConfigs = mcpConfigManager.getEnabledConfigs();
  for (const config of enabledMcpConfigs) {
    try {
      await mcpClient.connect(config);
    } catch (error) {
      console.error(`Failed to connect to MCP server "${config.name}":`, error);
    }
  }

  // Update tools when MCP configs change
  mcpConfigManager.onDidChange(async () => {
    // Disconnect from all servers
    await mcpClient.disconnectAll();

    // Reconnect to enabled servers
    const enabledConfigs = mcpConfigManager.getEnabledConfigs();
    for (const config of enabledConfigs) {
      try {
        await mcpClient.connect(config);
      } catch (error) {
        console.error(`Failed to connect to MCP server "${config.name}":`, error);
      }
    }

    // Notify webview to refresh MCP tools
    vscode.commands.executeCommand('yoloAgent.chatView.focus');
  });

  // Initialize tools
  const tools = new Map<string, Tool>();
  const toolInstances: Tool[] = [
    new ReadFileTool(),
    new WriteFileTool(),
    new ListFilesTool(),
    new RunTerminalTool(),
    new GetDiagnosticsTool(),
  ];
  for (const tool of toolInstances) {
    tools.set(tool.definition.name, tool);
  }

  // Add MCP tools
  const mcpTools = mcpToolBridge.createToolWrappers();
  for (const [name, tool] of mcpTools) {
    tools.set(name, tool);
  }

  // Register webview sidebar provider
  const chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    registry,
    profileManager,
    modeManager,
    tools,
    contextManager,
    mcpConfigManager,
    mcpClient
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('yoloAgent.newChat', () => {
      vscode.commands.executeCommand('yoloAgent.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('yoloAgent.setApiKey', async () => {
      const providers = registry.getAllProviders();
      if (providers.length === 0) {
        vscode.window.showWarningMessage(
          'No providers configured. Open YOLO Agent settings to add one.'
        );
        return;
      }

      const selected = await vscode.window.showQuickPick(
        providers.map((p) => ({ label: p.name, id: p.id })),
        { placeHolder: 'Select a provider to set the API key for' }
      );

      if (!selected) { return; }

      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${selected.label}`,
        password: true,
        ignoreFocusOut: true,
      });

      if (!apiKey) { return; }

      await profileManager.setApiKey(selected.id, apiKey);
      vscode.window.showInformationMessage(
        `API key set for ${selected.label}`
      );
    })
  );

  context.subscriptions.push(
    { dispose: () => profileManager.dispose() },
    { dispose: () => registry.dispose() },
    { dispose: () => modeManager.dispose() },
    { dispose: () => contextManager.dispose() },
    { dispose: async () => { await mcpClient.disconnectAll(); mcpConfigManager.dispose(); } }
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
