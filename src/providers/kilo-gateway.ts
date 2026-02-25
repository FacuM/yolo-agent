import OpenAI from 'openai';
import {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ModelInfo,
  RequestOptions,
  ToolCall,
} from './types';

const KILO_GATEWAY_BASE_URL = 'https://api.kilo.ai/api/gateway';

/**
 * Provider for the Kilo AI Gateway – an OpenAI-compatible universal API that
 * routes to 200+ models across Anthropic, OpenAI, Google, xAI, and others.
 *
 * Models use the `provider/model-name` format (e.g. `anthropic/claude-sonnet-4.5`).
 * The special `kilo/auto` virtual model can be used for automatic task-based
 * model routing when the `x-kilocode-mode` header is supplied.
 *
 * @see https://kilo.ai/docs/gateway
 */
export class KiloGatewayProvider implements LLMProvider {
  readonly id = 'kilo-gateway';
  readonly name = 'Kilo Gateway';

  private client: OpenAI | null = null;

  setApiKey(apiKey: string): void {
    this.client = new OpenAI({
      apiKey,
      baseURL: KILO_GATEWAY_BASE_URL,
    });
  }

  async sendMessage(
    messages: ChatMessage[],
    options: RequestOptions,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('Kilo Gateway API key not set');
    }

    const openaiMessages = messages.map((m) => this.toOpenAIMessage(m));

    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const requestOptions: Record<string, unknown> = {};
    if (options.signal) {
      requestOptions.signal = options.signal;
    }

    // Kilo Auto Model can route by mode when x-kilocode-mode is provided.
    if (options.model === 'kilo/auto') {
      const mode = this.toKiloMode(options.modeId);
      if (mode) {
        requestOptions.headers = { 'x-kilocode-mode': mode };
      }
    }

    const stream = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      messages: openaiMessages,
      tools: tools?.length ? tools : undefined,
      stream: true,
    }, requestOptions);

    let fullContent = '';
    let reasoningContent = '';
    const toolCallsMap = new Map<
      number,
      { id: string; name: string; arguments: string }
    >();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) {
        continue;
      }

      // Some models (e.g. o-series via gateway) return reasoning_content
      const reasoning = (delta as { reasoning_content?: string })
        .reasoning_content;
      if (reasoning) {
        reasoningContent += reasoning;
      }

      if (delta.content) {
        fullContent += delta.content;
        onChunk(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index);
          if (!existing) {
            toolCallsMap.set(tc.index, {
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '',
            });
          } else {
            if (tc.id) {
              existing.id = tc.id;
            }
            if (tc.function?.name) {
              existing.name += tc.function.name;
            }
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallsMap) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments),
        });
      } catch {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: { raw: tc.arguments },
        });
      }
    }

    return {
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
      thinking: reasoningContent || undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.client) {
      return [];
    }
    try {
      const response = await this.client.models.list();
      const models: ModelInfo[] = [];
      for await (const model of response) {
        models.push({
          id: model.id,
          name: model.id,
          supportsTools: true,
          supportsStreaming: true,
        });
      }
      if (!models.some((m) => m.id === 'kilo/auto')) {
        models.unshift({
          id: 'kilo/auto',
          name: 'kilo/auto (Auto Model Routing)',
          supportsTools: true,
          supportsStreaming: true,
        });
      }
      return models;
    } catch {
      return [];
    }
  }

  async validateApiKey(key: string): Promise<boolean> {
    try {
      const testClient = new OpenAI({
        apiKey: key,
        baseURL: KILO_GATEWAY_BASE_URL,
      });
      // The /models endpoint is publicly accessible but validates auth.
      await testClient.models.list();
      return true;
    } catch {
      return false;
    }
  }

  private toOpenAIMessage(
    msg: ChatMessage
  ): OpenAI.ChatCompletionMessageParam {
    if (msg.role === 'system') {
      return { role: 'system', content: msg.content };
    }

    if (msg.toolResults && msg.toolResults.length > 0) {
      return {
        role: 'tool',
        tool_call_id: msg.toolResults[0].toolCallId,
        content: msg.toolResults[0].content,
      };
    }

    if (msg.role === 'assistant' && msg.toolCalls) {
      return {
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }

    return {
      role: msg.role,
      content: msg.content,
    };
  }

  private toKiloMode(modeId?: string): string | undefined {
    if (!modeId) {
      return undefined;
    }

    switch (modeId) {
      case 'agent':
      case 'sandbox':
      case 'smart-todo':
      case 'sandboxed-smart-todo':
        return 'code';
      case 'ask':
      case 'architect':
      case 'debug':
      case 'review':
      case 'orchestrator':
        return modeId;
      default:
        return undefined;
    }
  }
}
