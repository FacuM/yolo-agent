import Anthropic from '@anthropic-ai/sdk';
import {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ModelInfo,
  RequestOptions,
  ToolCall,
} from './types';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic Claude';

  private client: Anthropic | null = null;

  setApiKey(apiKey: string): void {
    this.client = new Anthropic({ apiKey });
  }

  async sendMessage(
    messages: ChatMessage[],
    options: RequestOptions,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('Anthropic API key not set');
    }

    const systemMessage = messages.find((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const anthropicMessages = nonSystemMessages.map((m) =>
      this.toAnthropicMessage(m)
    );

    const tools = options.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));

    const stream = this.client.messages.stream({
      model: options.model || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature,
      system: systemMessage?.content,
      messages: anthropicMessages,
      tools,
    });

    let fullContent = '';
    const toolCalls: ToolCall[] = [];

    stream.on('text', (text) => {
      fullContent += text;
      onChunk(text);
    });

    const finalMessage = await stream.finalMessage();

    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: fullContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: finalMessage.usage.input_tokens,
        outputTokens: finalMessage.usage.output_tokens,
      },
      finishReason: this.mapStopReason(finalMessage.stop_reason),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', contextWindow: 200000, supportsTools: true, supportsStreaming: true },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', contextWindow: 200000, supportsTools: true, supportsStreaming: true },
      { id: 'claude-haiku-3-5-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000, supportsTools: true, supportsStreaming: true },
    ];
  }

  async validateApiKey(key: string): Promise<boolean> {
    try {
      const testClient = new Anthropic({ apiKey: key });
      await testClient.messages.create({
        model: 'claude-haiku-3-5-20241022',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      });
      return true;
    } catch {
      return false;
    }
  }

  private toAnthropicMessage(
    msg: ChatMessage
  ): Anthropic.MessageParam {
    const content: Anthropic.ContentBlockParam[] = [];

    if (msg.content) {
      content.push({ type: 'text', text: msg.content });
    }

    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
    }

    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        content.push({
          type: 'tool_result',
          tool_use_id: tr.toolCallId,
          content: tr.content,
          is_error: tr.isError,
        });
      }
    }

    return {
      role: msg.role as 'user' | 'assistant',
      content,
    };
  }

  private mapStopReason(
    reason: string | null
  ): LLMResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'max_tokens';
      default:
        return 'stop';
    }
  }
}
