import * as vscode from 'vscode';
import { ProfileManager } from './providers/profile-manager';
import { ProviderRegistry } from './providers/registry';
import { ChatViewProvider } from './webview/panel';
import { Tool } from './tools/types';
import { ReadFileTool, WriteFileTool, ListFilesTool } from './tools/file-ops';
import { RunTerminalTool, RunBackgroundTerminalTool, GetBackgroundTerminalTool } from './tools/terminal';
import { GetDiagnosticsTool } from './tools/diagnostics';
import { AskQuestionTool } from './tools/question';
import { ExitPlanningModeTool } from './tools/planning';
import {
  CreateSandboxTool,
  SwitchModeTool,
  GetSandboxStatusTool,
  ExitSandboxTool,
  RunSandboxedCommandTool,
} from './tools/sandbox';
import { ModeManager } from './modes/manager';
import { ContextManager } from './context/manager';
import { McpConfigManager } from './mcp/config';
import { McpClient } from './mcp/client';
import { McpToolBridge } from './mcp/bridge';
import { SandboxManager } from './sandbox/manager';

let profileManager: ProfileManager;
let registry: ProviderRegistry;
let mcpConfigManager: McpConfigManager;
let mcpClient: McpClient;
let mcpToolBridge: McpToolBridge;
let sandboxManager: SandboxManager | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  // Initialize profile manager and provider registry
  profileManager = new ProfileManager(context.globalState, context.secrets);
  registry = new ProviderRegistry(profileManager, context.globalState);
  await registry.initialize();

  // Initialize mode manager
  const modeManager = new ModeManager(context);
  await modeManager.initialize();

  // Initialize context manager
  const contextManager = new ContextManager();
  await contextManager.initialize();

  // Initialize sandbox manager only if workspace exists
  if (workspaceFolder) {
    sandboxManager = new SandboxManager(workspaceFolder);
  }

  // Initialize MCP components
  mcpConfigManager = new McpConfigManager(context.globalState, vscode.workspace.workspaceFolders || []);
  await mcpConfigManager.initialize();
  mcpClient = new McpClient();
  mcpToolBridge = new McpToolBridge(mcpClient);

  // Connect to enabled MCP servers in the background (don't block activation)
  const enabledMcpConfigs = mcpConfigManager.getEnabledConfigs();
  if (enabledMcpConfigs.length > 0) {
    Promise.allSettled(
      enabledMcpConfigs.map(config =>
        mcpClient.connect(config).catch(error => {
          console.error(`Failed to connect to MCP server "${config.name}":`, error);
        })
      )
    ).then(() => {
      // Re-register MCP tools once connections are ready
      const mcpToolsAfterConnect = mcpToolBridge.createToolWrappers();
      for (const [name, tool] of mcpToolsAfterConnect) {
        tools.set(name, tool);
      }
    });
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

    // Notify webview to refresh MCP tools (view may not be open yet)
    chatViewProvider.refreshMcpTools?.();
  });

  // Initialize tools with sandbox awareness (optional sandboxManager)
  const tools = new Map<string, Tool>();
  const toolInstances: Tool[] = [
    new ReadFileTool(sandboxManager),
    new WriteFileTool(sandboxManager),
    new ListFilesTool(sandboxManager),
    new RunTerminalTool(sandboxManager),
    new RunBackgroundTerminalTool(sandboxManager),
    new GetBackgroundTerminalTool(),
    new GetDiagnosticsTool(),
    new AskQuestionTool(),
    new ExitPlanningModeTool(),
  ];

  // Add sandbox tools only if sandbox manager is available
  if (sandboxManager) {
    toolInstances.push(
      new CreateSandboxTool(sandboxManager),
      new SwitchModeTool(modeManager, sandboxManager),
      new GetSandboxStatusTool(sandboxManager),
      new ExitSandboxTool(sandboxManager),
      new RunSandboxedCommandTool(sandboxManager)
    );
  } else {
    // Add switchMode tool without sandbox support
    toolInstances.push(new SwitchModeTool(modeManager));
  }

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
    context.globalState,
    context.extensionUri,
    registry,
    profileManager,
    modeManager,
    tools,
    contextManager,
    mcpConfigManager,
    mcpClient,
    sandboxManager
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
      // Show the sidebar view if it's already resolved
      if (chatViewProvider.view) {
        chatViewProvider.view.show?.(true);
      }
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

  // Sandbox status bar indicator (only if sandbox manager exists)
  if (sandboxManager) {
    const statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    statusBarItem.command = 'yoloAgent.showSandboxStatus';
    context.subscriptions.push(statusBarItem);

    const updateSandboxStatus = () => {
      const info = sandboxManager!.getSandboxInfo();
      if (info.isActive) {
        statusBarItem.text = `$(container) ${info.config?.branchName || 'Sandbox'}`;
        statusBarItem.tooltip = info.config?.worktreePath || 'Sandbox active';
        statusBarItem.show();
      } else {
        statusBarItem.hide();
      }
    };

    // Update status when sandbox changes
    sandboxManager.onDidChangeSandbox(updateSandboxStatus);
    updateSandboxStatus();

    context.subscriptions.push(
      vscode.commands.registerCommand('yoloAgent.showSandboxStatus', async () => {
        const info = sandboxManager!.getSandboxInfo();
        if (info.isActive) {
          const actions = await vscode.window.showQuickPick(
            [
              { label: 'Exit Sandbox', value: 'exit' },
              { label: 'Show Details', value: 'details' },
            ],
            { placeHolder: `Sandbox: ${info.config?.branchName}` }
          );

          if (actions?.value === 'exit') {
            await sandboxManager!.exitSandbox();
          } else if (actions?.value === 'details') {
            vscode.window.showInformationMessage(
              `Sandbox: ${info.config?.branchName}\nPath: ${info.config?.worktreePath}`,
              { modal: true }
            );
          }
        } else {
          vscode.window.showInformationMessage('No active sandbox');
        }
      })
    );
  }

  context.subscriptions.push(
    { dispose: () => profileManager.dispose() },
    { dispose: () => registry.dispose() },
    { dispose: () => modeManager.dispose() },
    { dispose: () => contextManager.dispose() },
    { dispose: () => sandboxManager?.dispose() },
    { dispose: async () => { await mcpClient.disconnectAll(); mcpConfigManager.dispose(); } }
  );
}

export function deactivate(): void {
  // Cleanup handled by disposables
}
