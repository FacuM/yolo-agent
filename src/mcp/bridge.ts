/**
 * MCP Tool Bridge
 * Wraps MCP tools as Tool interface for use in the extension
 */

import { Tool, ToolResult } from '../tools/types';
import { ToolDefinition } from '../providers/types';
import { McpClient } from './client';
import { McpToolDefinition } from './types';

export class McpToolBridge {
  constructor(private mcpClient: McpClient) {}

  /**
   * Create Tool wrappers for all MCP tools from all connected servers
   */
  createToolWrappers(): Map<string, Tool> {
    const tools = new Map<string, Tool>();
    const mcpTools = this.mcpClient.getTools();

    for (const mcpTool of mcpTools) {
      const tool = this.createToolWrapper(mcpTool);
      tools.set(tool.definition.name, tool);
    }

    return tools;
  }

  /**
   * Create a Tool wrapper for a single MCP tool
   */
  private createToolWrapper(mcpTool: McpToolDefinition): Tool {
    const definition: ToolDefinition = {
      name: mcpTool.name,
      description: mcpTool.description,
      parameters: mcpTool.inputSchema,
    };

    return {
      definition,
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        const result = await this.mcpClient.callTool(
          mcpTool.serverId,
          mcpTool.name,
          params
        );

        // Convert MCP result content to string
        let content = '';
        for (const item of result.content) {
          if (typeof item === 'string') {
            content += item;
          } else if (item && typeof item === 'object') {
            const typedItem = item as { type?: string; text?: string; data?: unknown };
            if (typedItem.type === 'text' && typedItem.text) {
              content += typedItem.text;
            } else if (typedItem.type === 'resource' && (typedItem as any).uri) {
              content += `Resource: ${(typedItem as any).uri}\n`;
            } else if (typedItem.type === 'image' && (typedItem as any).data) {
              content += `[Image data: ${(typedItem as any).data?.substring(0, 50) || ''}...]\n`;
            } else {
              content += JSON.stringify(item, null, 2) + '\n';
            }
          }
        }

        return {
          content: content.trim() || '(empty response)',
          isError: result.isError,
        };
      },
    };
  }

  /**
   * Get tool definitions formatted for the AI provider
   */
  getToolDefinitions(): ToolDefinition[] {
    const mcpTools = this.mcpClient.getTools();
    return mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));
  }
}
