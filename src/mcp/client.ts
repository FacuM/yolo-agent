/**
 * MCP Client
 * Connects to MCP servers and discovers tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { McpServerConfig, McpToolDefinition, McpToolResult } from './types';

interface McpConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: McpToolDefinition[];
}

export class McpClient {
  private connections: Map<string, McpConnection> = new Map();

  /**
   * Connect to an MCP server
   */
  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.id)) {
      await this.disconnect(config.id);
    }

    try {
      let transport: StdioClientTransport | SSEClientTransport;
      let client: Client;

      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new Error('STDIO transport requires a command');
        }

        transport = new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: config.env || {},
        });

        client = new Client({
          name: `yolo-agent-${config.id}`,
          version: '0.0.1',
        }, {
          capabilities: {},
        });

        await client.connect(transport);
      } else if (config.transport === 'sse') {
        if (!config.url) {
          throw new Error('SSE transport requires a URL');
        }

        transport = new SSEClientTransport(new URL(config.url));

        client = new Client({
          name: `yolo-agent-${config.id}`,
          version: '0.0.1',
        }, {
          capabilities: {},
        });

        await client.connect(transport);
      } else {
        throw new Error(`Unsupported transport type: ${(config as any).transport}`);
      }

      // Discover tools
      const toolsResponse = await client.listTools();
      const tools: McpToolDefinition[] = (toolsResponse.tools || []).map(tool => ({
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
        serverId: config.id,
      }));

      this.connections.set(config.id, {
        client,
        transport,
        tools,
      });
    } catch (error) {
      throw new Error(`Failed to connect to MCP server "${config.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get all tools from all connected servers
   */
  getTools(): McpToolDefinition[] {
    const allTools: McpToolDefinition[] = [];
    for (const connection of this.connections.values()) {
      allTools.push(...connection.tools);
    }
    return allTools;
  }

  /**
   * Get tools from a specific server
   */
  getToolsForServer(serverId: string): McpToolDefinition[] {
    const connection = this.connections.get(serverId);
    return connection ? connection.tools : [];
  }

  /**
   * Call a tool on a specific server
   */
  async callTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      throw new Error(`Server ${serverId} is not connected`);
    }

    try {
      const response = await connection.client.callTool({
        name: toolName,
        arguments: args,
      }) as { content?: unknown[]; isError?: boolean };

      return {
        content: (response.content as unknown[]) || [],
        isError: (response.isError as boolean) || false,
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error calling tool: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Check if a server is connected
   */
  isConnected(serverId: string): boolean {
    return this.connections.has(serverId);
  }

  /**
   * Get list of connected server IDs
   */
  getConnectedServerIds(): string[] {
    return Array.from(this.connections.keys());
  }

  /**
   * Disconnect from a specific server
   */
  async disconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    try {
      await connection.client.close();
      await connection.transport.close();
    } catch (error) {
      console.error(`Error disconnecting from MCP server ${serverId}:`, error);
    }

    this.connections.delete(serverId);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const disconnectPromises = Array.from(this.connections.keys()).map(id => this.disconnect(id));
    await Promise.all(disconnectPromises);
  }

  /**
   * Get the number of active connections
   */
  getConnectionCount(): number {
    return this.connections.size;
  }
}
