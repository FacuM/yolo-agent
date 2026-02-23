import { ToolDefinition } from '../providers/types';

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  definition: ToolDefinition;
  execute(params: Record<string, unknown>): Promise<ToolResult>;
}
