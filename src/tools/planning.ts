import { Tool, ToolResult } from './types';

/**
 * A tool that lets the LLM propose exiting planning mode.
 *
 * Flow:
 *  1. LLM calls exitPlanningMode with a reason/summary
 *  2. The panel posts a confirmation prompt to the webview
 *  3. execute() blocks on a Promise waiting for the user's decision
 *  4. When the user responds, the panel calls resolveDecision()
 *  5. The Promise resolves, execute() returns with the result
 *
 * If the user confirms, panel.ts will also toggle planning mode off.
 */
export class ExitPlanningModeTool implements Tool {
  private pendingDecision: {
    resolve: (accepted: boolean) => void;
  } | null = null;

  definition = {
    name: 'exitPlanningMode',
    description:
      'Propose to the user to turn off planning mode so you can start implementing. ' +
      'Use this when the plan is ready and you want to begin making changes. ' +
      'The user will be asked to confirm. Execution pauses until the user decides.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief summary of why you want to exit planning mode (e.g. "The plan is complete and ready for implementation")',
        },
      },
      required: ['reason'],
    },
  };

  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const reason = params.reason as string;

    if (!reason) {
      return { content: 'No reason provided.', isError: true };
    }

    // Block until the user decides
    const accepted = await new Promise<boolean>((resolve) => {
      this.pendingDecision = { resolve };
    });

    if (accepted) {
      return { content: 'Planning mode has been turned off. You can now use all tools to implement the plan.' };
    } else {
      return { content: 'The user chose to stay in planning mode. Continue planning without making changes.' };
    }
  }

  /**
   * Whether this tool is currently waiting for a user decision.
   */
  hasPendingDecision(): boolean {
    return this.pendingDecision !== null;
  }

  /**
   * Provide the user's decision to unblock the pending execute() call.
   */
  resolveDecision(accepted: boolean): void {
    if (this.pendingDecision) {
      const { resolve } = this.pendingDecision;
      this.pendingDecision = null;
      resolve(accepted);
    }
  }

  /**
   * Cancel a pending decision (e.g. when the user hits Stop).
   */
  cancelPending(): void {
    if (this.pendingDecision) {
      const { resolve } = this.pendingDecision;
      this.pendingDecision = null;
      resolve(false);
    }
  }
}
