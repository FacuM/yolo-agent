export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** Internal orchestration message — kept in LLM context but hidden from UI replay. */
  internal?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface RequestOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  thinking?: string;  // Extended thinking or reasoning content
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason: 'stop' | 'tool_calls' | 'max_tokens' | 'error';
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  supportsTools?: boolean;
  supportsStreaming?: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;

  sendMessage(
    messages: ChatMessage[],
    options: RequestOptions,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse>;

  listModels(): Promise<ModelInfo[]>;
  validateApiKey(key: string): Promise<boolean>;
}

export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  enabled: boolean;
}
