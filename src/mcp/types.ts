/**
 * MCP Types for YOLO Agent
 * Defines types for MCP server configuration and tool handling
 */

export type McpTransportType = 'stdio' | 'sse';
export type McpConfigSource = 'global' | 'workspace';
export type McpServerRuntimeStatus = 'disconnected' | 'loading' | 'activating' | 'activated' | 'ready' | 'error';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface ResolvedMcpServerConfig extends McpServerConfig {
  source: McpConfigSource;
  configPath: string;
  overridesGlobal?: boolean;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
}

export interface McpToolResult {
  content: unknown[];
  isError?: boolean;
}
