import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ModelInfo,
  RequestOptions,
  ToolCall,
} from './types';

/**
 * Claude Code beta headers, matching the Kilo Code approach.
 *
 * - claude-code-20250219: Enables Claude Code mode for the model
 * - interleaved-thinking-2025-05-14: Allows thinking blocks interleaved
 *   with tool calls (instead of only at the start of a response)
 * - fine-grained-tool-streaming-2025-05-14: Streams tool_use input as it's generated
 * - context-1m-2025-08-07: Enables extended 1M token context window
 */
const CLAUDE_CODE_BETAS: string[] = [
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'context-1m-2025-08-07',
];

/**
 * Attempts to read the Anthropic API key from the Claude Code CLI
 * credential files.  The CLI stores a JSON file at
 * `~/.claude/credentials.json` (or inside the `.claude` directory in the
 * user's home folder).
 *
 * Returns the key string or `undefined` if it couldn't be found.
 */
function readClaudeCodeCredential(): string | undefined {
  try {
    const credentialsPath = path.join(os.homedir(), '.claude', 'credentials.json');
    if (!fs.existsSync(credentialsPath)) {
      return undefined;
    }
    const raw = fs.readFileSync(credentialsPath, 'utf-8');
    const data = JSON.parse(raw);
    // The credentials file may store the key directly or within an
    // `apiKey` / `anthropicApiKey` field depending on version.
    return data.apiKey ?? data.anthropicApiKey ?? data.api_key ?? undefined;
  } catch {
    return undefined;
  }
}

export class ClaudeCodeProvider implements LLMProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';

  private client: Anthropic | null = null;
  private apiKey: string | undefined;

  /**
   * Optionally set a custom path to the `claude` executable.
   * (Not used for API calls, but exposed for features that may
   * want to shell out to the CLI in the future.)
   */
  cliPath = 'claude';

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.rebuildClient();
  }

  /**
   * Resolves the API key in order of precedence:
   * 1. Explicitly set via `setApiKey()`
   * 2. `ANTHROPIC_API_KEY` environment variable
   * 3. Claude Code CLI credentials file (~/.claude/credentials.json)
   */
  private resolveApiKey(): string | undefined {
    if (this.apiKey) {
      return this.apiKey;
    }
    if (process.env.ANTHROPIC_API_KEY) {
      return process.env.ANTHROPIC_API_KEY;
    }
    return readClaudeCodeCredential();
  }

  private rebuildClient(): void {
    const key = this.resolveApiKey();
    if (!key) {
      this.client = null;
      return;
    }
    this.client = new Anthropic({
      apiKey: key,
      defaultHeaders: {
        'anthropic-beta': CLAUDE_CODE_BETAS.join(','),
      },
    });
  }

  private ensureClient(): Anthropic {
    if (!this.client) {
      // Try rebuilding in case env or file appeared
      this.rebuildClient();
    }
    if (!this.client) {
      throw new Error(
        'Claude Code: No API key found. ' +
          'Set one via the profile settings, the ANTHROPIC_API_KEY environment variable, ' +
          'or authenticate with the Claude Code CLI (`claude auth login`).'
      );
    }
    return this.client;
  }

  // ---------- LLMProvider implementation ----------

  async sendMessage(
    messages: ChatMessage[],
    options: RequestOptions,
    onChunk: (chunk: string) => void
  ): Promise<LLMResponse> {
    const client = this.ensureClient();

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

    // Enable extended thinking when the model supports it.
    // Budget defaults are generous for agentic workloads.
    const thinkingParam = this.supportsThinking(options.model)
      ? {
          thinking: {
            type: 'enabled' as const,
            budget_tokens: options.maxTokens
              ? Math.min(options.maxTokens, 16384)
              : 16384,
          },
        }
      : {};

    const stream = client.messages.stream({
      model: options.model || 'claude-sonnet-4-20250514',
      max_tokens: options.maxTokens ?? 8192,
      temperature: options.temperature,
      system: systemMessage?.content,
      messages: anthropicMessages,
      tools,
      ...thinkingParam,
    });

    let fullContent = '';
    let thinkingContent = '';
    const toolCalls: ToolCall[] = [];

    stream.on('text', (text) => {
      fullContent += text;
      onChunk(text);
    });

    const finalMessage = await stream.finalMessage();

    for (const block of finalMessage.content) {
      if (block.type === 'thinking') {
        thinkingContent += block.thinking;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: fullContent,
      thinking: thinkingContent || undefined,
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
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
      },
      {
        id: 'claude-opus-4-20250514',
        name: 'Claude Opus 4',
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
      },
      {
        id: 'claude-haiku-3-5-20241022',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200_000,
        supportsTools: true,
        supportsStreaming: true,
      },
    ];
  }

  async validateApiKey(key: string): Promise<boolean> {
    try {
      const testClient = new Anthropic({
        apiKey: key,
        defaultHeaders: {
          'anthropic-beta': CLAUDE_CODE_BETAS.join(','),
        },
      });
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

  // ---------- Helpers ----------

  /**
   * Whether the given model supports extended / interleaved thinking.
   */
  private supportsThinking(model?: string): boolean {
    if (!model) { return true; }
    // Sonnet 4 and Opus 4 support thinking. Haiku 3.5 does not.
    return !model.includes('haiku');
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
