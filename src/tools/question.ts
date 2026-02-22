import { Tool, ToolResult } from './types';

/**
 * A tool that lets the LLM ask the user a clarifying question and
 * pause execution until the user replies.
 *
 * Flow:
 *  1. LLM calls askQuestion with a question string
 *  2. The panel posts the question to the webview and re-enables input
 *  3. execute() blocks on a Promise waiting for the user's answer
 *  4. When the user sends a message, the panel calls resolveAnswer()
 *  5. The Promise resolves, execute() returns, and the tool loop continues
 */
export class AskQuestionTool implements Tool {
  private pendingAnswer: {
    resolve: (answer: string) => void;
  } | null = null;

  definition = {
    name: 'askQuestion',
    description:
      'Ask the user a clarifying question and wait for their response. ' +
      'Use this when you need more information from the user to proceed with the current task. ' +
      'The execution will pause until the user provides an answer.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
        },
      },
      required: ['question'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const question = params.question as string;

    if (!question) {
      return { content: 'No question provided.', isError: true };
    }

    // Block until the user answers (or the question is cancelled)
    const answer = await new Promise<string>((resolve) => {
      this.pendingAnswer = { resolve };
    });

    return { content: `User's answer: ${answer}` };
  }

  /**
   * Whether this tool is currently waiting for a user answer.
   */
  hasPendingQuestion(): boolean {
    return this.pendingAnswer !== null;
  }

  /**
   * Provide the user's answer to unblock the pending execute() call.
   */
  resolveAnswer(answer: string): void {
    if (this.pendingAnswer) {
      const { resolve } = this.pendingAnswer;
      this.pendingAnswer = null;
      resolve(answer);
    }
  }

  /**
   * Cancel a pending question (e.g. when the user hits Stop).
   * Resolves with a cancellation message so the await doesn't hang forever.
   */
  cancelPending(): void {
    if (this.pendingAnswer) {
      const { resolve } = this.pendingAnswer;
      this.pendingAnswer = null;
      resolve('[Question cancelled by user]');
    }
  }
}
