/**
 * MCP Config Manager
 * Manages MCP server configurations from globalState and workspace files
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsWatch from 'fs';
import * as path from 'path';
import { McpServerConfig } from './types';

const CONFIG_FILE_NAME = 'mcp.json';
const CONFIG_DIR = '.yolo-agent';
const GLOBAL_STATE_KEY = 'mcp.servers';

export class McpConfigManager {
  private configs: Map<string, McpServerConfig> = new Map();
  private fileWatcher: fsWatch.FSWatcher | null = null;
  private onChangeCallbacks: Set<() => void> = new Set();

  constructor(
    private globalState: vscode.ExtensionContext['globalState'],
    private workspaceFolders: readonly vscode.WorkspaceFolder[]
  ) {}

  async initialize(): Promise<void> {
    // Load from globalState
    await this.loadFromGlobalState();

    // Load from workspace config file
    if (this.workspaceFolders.length > 0) {
      await this.loadFromWorkspaceFile();
      this.watchWorkspaceFile();
    }

    // Watch for workspace folder changes
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      this.workspaceFolders = vscode.workspace.workspaceFolders || [];
      this.loadFromWorkspaceFile();
      this.watchWorkspaceFile();
    });
  }

  private async loadFromGlobalState(): Promise<void> {
    const stored = this.globalState.get<McpServerConfig[]>(GLOBAL_STATE_KEY, []);
    for (const config of stored) {
      if (config.id && config.name) {
        this.configs.set(config.id, { ...config, source: 'global' } as McpServerConfig & { source: string });
      }
    }
  }

  private async loadFromWorkspaceFile(): Promise<void> {
    if (this.workspaceFolders.length === 0) {
      return;
    }

    for (const folder of this.workspaceFolders) {
      const configPath = path.join(folder.uri.fsPath, CONFIG_DIR, CONFIG_FILE_NAME);
      try {
        const content = await fs.readFile(configPath, 'utf-8');
        const data = JSON.parse(content);
        const servers: McpServerConfig[] = data.servers || [];

        for (const server of servers) {
          if (server.id && server.name) {
            this.configs.set(server.id, { ...server, source: 'workspace' } as McpServerConfig & { source: string });
          }
        }
      } catch (error) {
        // File doesn't exist or is invalid - that's okay
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('Failed to load MCP config from workspace:', error);
        }
      }
    }
  }

  private watchWorkspaceFile(): void {
    // Dispose existing watcher
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    if (this.workspaceFolders.length === 0) {
      return;
    }

    // Watch the config directory
    const configDir = path.join(this.workspaceFolders[0].uri.fsPath, CONFIG_DIR);
    try {
      this.fileWatcher = fsWatch.watch(configDir, { persistent: false }, async (eventType, filename) => {
        if (filename === CONFIG_FILE_NAME) {
          await this.loadFromWorkspaceFile();
          this.notifyChange();
        }
      });
    } catch (err) {
      // Directory doesn't exist yet, that's okay
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('Failed to watch MCP config directory:', err);
      }
    }
  }

  getConfigs(): McpServerConfig[] {
    return Array.from(this.configs.values());
  }

  getEnabledConfigs(): McpServerConfig[] {
    return this.getConfigs().filter(c => c.enabled);
  }

  getConfig(id: string): McpServerConfig | undefined {
    return this.configs.get(id);
  }

  async saveConfig(config: McpServerConfig): Promise<void> {
    this.configs.set(config.id, config);

    // Save to globalState
    const globalConfigs = this.getConfigs().filter(
      c => !(c as McpServerConfig & { source?: string }).source || (c as McpServerConfig & { source?: string }).source === 'global'
    );
    await this.globalState.update(GLOBAL_STATE_KEY, globalConfigs);

    this.notifyChange();
  }

  async deleteConfig(id: string): Promise<void> {
    const config = this.configs.get(id);
    if (!config) {
      return;
    }

    // Only delete if it's from global state
    const source = (config as McpServerConfig & { source?: string }).source;
    if (source === 'workspace') {
      throw new Error('Cannot delete workspace-configured server from settings');
    }

    this.configs.delete(id);

    const globalConfigs = this.getConfigs().filter(
      c => !(c as McpServerConfig & { source?: string }).source || (c as McpServerConfig & { source?: string }).source === 'global'
    );
    await this.globalState.update(GLOBAL_STATE_KEY, globalConfigs);

    this.notifyChange();
  }

  onDidChange(callback: () => void): vscode.Disposable {
    this.onChangeCallbacks.add(callback);
    return {
      dispose: () => {
        this.onChangeCallbacks.delete(callback);
      }
    };
  }

  private notifyChange(): void {
    for (const callback of this.onChangeCallbacks) {
      try {
        callback();
      } catch (error) {
        console.error('Error in MCP config change callback:', error);
      }
    }
  }

  dispose(): void {
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
    this.onChangeCallbacks.clear();
    this.configs.clear();
  }
}
