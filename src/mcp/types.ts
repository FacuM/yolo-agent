/**
 * MCP Types for YOLO Agent
 * Defines types for MCP server configuration and tool handling
 */

export type McpTransportType = 'stdio' | 'sse';

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
