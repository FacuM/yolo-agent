/**
 * MCP Config Manager
 * Manages hierarchical MCP server configurations from global and workspace files.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as fsWatch from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServerConfig, McpConfigSource, ResolvedMcpServerConfig } from './types';

const CONFIG_FILE_NAME = 'mcp.json';
const CONFIG_DIR = '.yolo-agent';
const CONFIG_VERSION = 1;

export class McpConfigManager {
  private configs: Map<string, ResolvedMcpServerConfig> = new Map();
  private globalConfigs: Map<string, ResolvedMcpServerConfig> = new Map();
  private workspaceConfigs: Map<string, ResolvedMcpServerConfig> = new Map();
  private globalWatcher: fsWatch.FSWatcher | null = null;
  private workspaceWatchers: fsWatch.FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;
  private onChangeCallbacks: Set<() => void> = new Set();

  private readonly globalConfigPath = path.join(os.homedir(), CONFIG_DIR, CONFIG_FILE_NAME);

  constructor(
    private _globalState: vscode.ExtensionContext['globalState'],
    private workspaceFolders: readonly vscode.WorkspaceFolder[]
  ) {}

  async initialize(): Promise<void> {
    await this.reloadAllConfigs();
    this.watchConfigFiles();

    // Watch for workspace folder changes
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      this.workspaceFolders = vscode.workspace.workspaceFolders || [];
      this.watchConfigFiles();
      await this.reloadAllConfigs();
      this.notifyChange();
    });
  }

  getGlobalConfigPath(): string {
    return this.globalConfigPath;
  }

  getWorkspaceConfigPath(): string | null {
    const firstWorkspace = this.workspaceFolders[0];
    if (!firstWorkspace) {
      return null;
    }
    return path.join(firstWorkspace.uri.fsPath, CONFIG_DIR, CONFIG_FILE_NAME);
  }

  getSettingsTemplate(): string {
    const example = {
      version: CONFIG_VERSION,
      servers: [
        {
          id: 'filesystem',
          name: 'Filesystem',
          enabled: true,
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
          env: {
            NODE_ENV: 'production',
          },
        },
        {
          id: 'remote-sse',
          name: 'Remote SSE',
          enabled: false,
          transport: 'sse',
          url: 'https://example.com/sse',
        },
      ],
    };

    return `${JSON.stringify(example, null, 2)}\n`;
  }

  async openGlobalSettingsFile(): Promise<void> {
    const filePath = this.getGlobalConfigPath();
    await this.ensureConfigFile(filePath);
    this.watchConfigFiles();
    await this.openFileInEditor(filePath);
  }

  async openWorkspaceSettingsFile(): Promise<void> {
    const filePath = this.getWorkspaceConfigPath();
    if (!filePath) {
      throw new Error('No workspace folder is open. Open a workspace to edit workspace MCP settings.');
    }
    await this.ensureConfigFile(filePath);
    this.watchConfigFiles();
    await this.openFileInEditor(filePath);
  }

  private async openFileInEditor(filePath: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async ensureConfigFile(filePath: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, this.getSettingsTemplate(), 'utf-8');
    }
  }

  private async reloadAllConfigs(): Promise<void> {
    this.globalConfigs = await this.loadConfigsFromFile(this.globalConfigPath, 'global');

    const workspaceConfigs = new Map<string, ResolvedMcpServerConfig>();
    for (const folder of this.workspaceFolders) {
      const configPath = path.join(folder.uri.fsPath, CONFIG_DIR, CONFIG_FILE_NAME);
      const loaded = await this.loadConfigsFromFile(configPath, 'workspace');
      for (const [id, config] of loaded) {
        workspaceConfigs.set(id, config);
      }
    }
    this.workspaceConfigs = workspaceConfigs;
    this.rebuildEffectiveConfigs();
  }

  private async loadConfigsFromFile(
    configPath: string,
    source: McpConfigSource
  ): Promise<Map<string, ResolvedMcpServerConfig>> {
    const loaded = new Map<string, ResolvedMcpServerConfig>();

    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const data = JSON.parse(content);
      const servers = Array.isArray(data) ? data : data?.servers;

      if (!Array.isArray(servers)) {
        return loaded;
      }

      for (const server of servers) {
        if (!server || typeof server !== 'object') {
          continue;
        }

        const parsed = this.normalizeConfig(server as Partial<McpServerConfig>);
        if (!parsed) {
          continue;
        }

        loaded.set(parsed.id, {
          ...parsed,
          source,
          configPath,
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to load MCP config from ${configPath}:`, error);
      }
    }

    return loaded;
  }

  private normalizeConfig(config: Partial<McpServerConfig>): McpServerConfig | null {
    if (!config.id || !config.name) {
      return null;
    }

    const transport = config.transport === 'sse' ? 'sse' : 'stdio';
    const normalized: McpServerConfig = {
      id: String(config.id),
      name: String(config.name),
      enabled: typeof config.enabled === 'boolean' ? config.enabled : true,
      transport,
    };

    if (transport === 'stdio') {
      if (typeof config.command === 'string') {
        normalized.command = config.command;
      }
      if (Array.isArray(config.args)) {
        normalized.args = config.args.map(String);
      }
      if (config.env && typeof config.env === 'object') {
        const env: Record<string, string> = {};
        for (const [key, value] of Object.entries(config.env)) {
          env[String(key)] = String(value);
        }
        normalized.env = env;
      }
    }

    if (transport === 'sse' && typeof config.url === 'string') {
      normalized.url = config.url;
    }

    return normalized;
  }

  private rebuildEffectiveConfigs(): void {
    this.configs.clear();

    for (const [id, globalConfig] of this.globalConfigs) {
      this.configs.set(id, {
        ...globalConfig,
        overridesGlobal: false,
      });
    }

    for (const [id, workspaceConfig] of this.workspaceConfigs) {
      this.configs.set(id, {
        ...workspaceConfig,
        overridesGlobal: this.globalConfigs.has(id),
      });
    }
  }

  private watchConfigFiles(): void {
    if (this.globalWatcher) {
      this.globalWatcher.close();
      this.globalWatcher = null;
    }
    for (const watcher of this.workspaceWatchers) {
      watcher.close();
    }
    this.workspaceWatchers = [];

    this.globalWatcher = this.createDirectoryWatcher(path.dirname(this.globalConfigPath));

    for (const folder of this.workspaceFolders) {
      const workspaceConfigDir = path.join(folder.uri.fsPath, CONFIG_DIR);
      const watcher = this.createDirectoryWatcher(workspaceConfigDir);
      if (watcher) {
        this.workspaceWatchers.push(watcher);
      }
    }
  }

  private createDirectoryWatcher(directoryPath: string): fsWatch.FSWatcher | null {
    try {
      return fsWatch.watch(directoryPath, { persistent: false }, (eventType, filename) => {
        void eventType;
        if (filename === CONFIG_FILE_NAME) {
          this.scheduleReload();
        }
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`Failed to watch MCP config directory ${directoryPath}:`, err);
      }
      return null;
    }
  }

  private scheduleReload(): void {
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
    }
    this.reloadTimer = setTimeout(async () => {
      this.reloadTimer = null;
      await this.reloadAllConfigs();
      this.notifyChange();
    }, 100);
  }

  private serializeConfigs(configs: McpServerConfig[]): string {
    return `${JSON.stringify({ version: CONFIG_VERSION, servers: configs }, null, 2)}\n`;
  }

  private stripMetadata(config: ResolvedMcpServerConfig | McpServerConfig): McpServerConfig {
    return {
      id: config.id,
      name: config.name,
      enabled: config.enabled,
      transport: config.transport,
      command: config.command,
      args: config.args,
      env: config.env,
      url: config.url,
    };
  }

  private async saveGlobalFile(): Promise<void> {
    await this.ensureConfigFile(this.globalConfigPath);
    const rawConfigs = Array.from(this.globalConfigs.values()).map(c => this.stripMetadata(c));
    await fs.writeFile(this.globalConfigPath, this.serializeConfigs(rawConfigs), 'utf-8');
  }

  getConfigs(): ResolvedMcpServerConfig[] {
    return Array.from(this.configs.values());
  }

  getEnabledConfigs(): ResolvedMcpServerConfig[] {
    return this.getConfigs().filter(c => c.enabled);
  }

  getConfig(id: string): ResolvedMcpServerConfig | undefined {
    return this.configs.get(id);
  }

  async saveConfig(config: McpServerConfig): Promise<void> {
    if (this.workspaceConfigs.has(config.id)) {
      throw new Error('This server is defined in workspace settings. Edit workspace MCP settings JSON to modify it.');
    }

    const normalized = this.normalizeConfig(config);
    if (!normalized) {
      throw new Error('Invalid MCP server config: id and name are required.');
    }

    this.globalConfigs.set(normalized.id, {
      ...normalized,
      source: 'global',
      configPath: this.globalConfigPath,
      overridesGlobal: false,
    });

    await this.saveGlobalFile();
    await this.reloadAllConfigs();
    this.notifyChange();
  }

  async deleteConfig(id: string): Promise<void> {
    if (this.workspaceConfigs.has(id)) {
      throw new Error('This server is defined in workspace settings. Edit workspace MCP settings JSON to remove it.');
    }

    if (!this.globalConfigs.has(id)) {
      return;
    }

    this.globalConfigs.delete(id);
    await this.saveGlobalFile();
    await this.reloadAllConfigs();
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
    if (this.globalWatcher) {
      this.globalWatcher.close();
      this.globalWatcher = null;
    }
    for (const watcher of this.workspaceWatchers) {
      watcher.close();
    }
    this.workspaceWatchers = [];
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    this.onChangeCallbacks.clear();
    this.configs.clear();
    this.globalConfigs.clear();
    this.workspaceConfigs.clear();
  }
}
