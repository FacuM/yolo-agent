import OpenAI from 'openai';
import {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ModelInfo,
  RequestOptions,
  ToolCall,
} from './types';

export class OpenAIProvider implements LLMProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';

  private client: OpenAI | null = null;

  setApiKey(apiKey: string): void {
    this.client = new OpenAI({ apiKey });
  }

  async sendMessage(
    messages: ChatMessage[],
    options: RequestOptions,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('OpenAI API key not set');
    }

    const openaiMessages = messages.flatMap((m) => this.toOpenAIMessages(m));

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

    const stream = await this.client.chat.completions.create({
      model: options.model || 'gpt-4o',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      messages: openaiMessages,
      tools: tools?.length ? tools : undefined,
      stream: true,
    }, requestOptions);

    let fullContent = '';
    let reasoningContent = '';
    const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) {continue;}

      // Capture reasoning_content from o-series models
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content;
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
            if (tc.id) {existing.id = tc.id;}
            if (tc.function?.name) {existing.name += tc.function.name;}
            if (tc.function?.arguments) {existing.arguments += tc.function.arguments;}
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

    const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';

    return {
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: undefined, // stream doesn't provide usage by default
      finishReason,
      thinking: reasoningContent || undefined,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, supportsTools: true, supportsStreaming: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, supportsTools: true, supportsStreaming: true },
      { id: 'o1', name: 'o1', contextWindow: 200000, supportsTools: true, supportsStreaming: true },
    ];
  }

  async validateApiKey(key: string): Promise<boolean> {
    try {
      const testClient = new OpenAI({ apiKey: key });
      await testClient.models.list();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Convert one ChatMessage into one or more OpenAI messages.
   * Tool-result messages may expand to multiple `tool` role messages.
   */
  private toOpenAIMessages(
    msg: ChatMessage
  ): OpenAI.ChatCompletionMessageParam[] {
    if (msg.role === 'system') {
      return [{ role: 'system', content: msg.content }];
    }

    if (msg.toolResults && msg.toolResults.length > 0) {
      // Each tool result becomes a separate "tool" message in OpenAI format
      return msg.toolResults.map((tr) => ({
        role: 'tool' as const,
        tool_call_id: tr.toolCallId,
        content: tr.content,
      }));
    }

    if (msg.role === 'assistant' && msg.toolCalls) {
      return [{
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
      }];
    }

    return [{
      role: msg.role,
      content: msg.content,
    }];
  }
}
