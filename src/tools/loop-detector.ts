/**
 * Tracks tool-call patterns across iterations to detect unproductive loops.
 *
 * Detects three patterns:
 * 1. Identical consecutive call batches (exact same tools + args repeated)
 * 2. Non-productive rounds (all calls are read-only or errored)
 * 3. Repeated tool errors (a tool keeps failing but the LLM keeps calling it)
 */
export interface ToolCallRound {
  /** Tool names called in this round */
  toolNames: string[];
  /** Signature string for deduplication (name:args pairs) */
  signature: string;
  /** Whether each tool call errored */
  errors: boolean[];
}

export interface LoopDetectionResult {
  shouldNudge: boolean;
  shouldForceBreak: boolean;
  repeatedErrorTools: string[];
}

const READ_ONLY_TOOLS = new Set([
  'listFiles', 'readFile', 'getDiagnostics', 'getSandboxStatus',
]);

export class LoopDetector {
  private recentSignatures: string[] = [];
  private nonProductiveStreak = 0;
  private toolErrorCounts: Record<string, number> = {};
  private nudgesSent: number;

  constructor(initialNudges = 0) {
    this.nudgesSent = initialNudges;
  }

  /**
   * Record a round of tool calls and check for loop patterns.
   *
   * @param round - The tool calls made in this round and their error states.
   * @param isPlanningMode - In planning mode, read-only calls are expected and
   *   should not count as non-productive.
   */
  recordRound(round: ToolCallRound, isPlanningMode: boolean): LoopDetectionResult {
    this.recentSignatures.push(round.signature);

    // Track per-tool error counts
    for (let i = 0; i < round.toolNames.length; i++) {
      if (round.errors[i]) {
        const name = round.toolNames[i];
        this.toolErrorCounts[name] = (this.toolErrorCounts[name] ?? 0) + 1;
      }
    }

    // A round is "non-productive" if EVERY tool call either errored or is read-only.
    // In planning mode, read-only is the expected behavior so skip this check.
    const allNonProductive = isPlanningMode
      ? false
      : round.toolNames.every((name, i) =>
          READ_ONLY_TOOLS.has(name) || round.errors[i]
        );

    this.nonProductiveStreak = allNonProductive
      ? this.nonProductiveStreak + 1
      : 0;

    const repeatedErrorTools = Object.entries(this.toolErrorCounts)
      .filter(([, count]) => count >= 1)
      .map(([name]) => name);

    const sigs = this.recentSignatures;
    const identicalConsecutive =
      sigs.length >= 2 &&
      sigs.slice(-2).every(s => s === sigs[sigs.length - 1]);

    const shouldNudge =
      identicalConsecutive ||
      this.nonProductiveStreak >= 2 ||
      repeatedErrorTools.length > 0;

    let shouldForceBreak = false;
    if (shouldNudge) {
      this.nudgesSent++;
      if (this.nudgesSent >= 2) {
        shouldForceBreak = true;
      }
    }

    return { shouldNudge, shouldForceBreak, repeatedErrorTools };
  }

  /** Reset all tracking state (call after sending a nudge). */
  reset(): void {
    this.recentSignatures.length = 0;
    this.nonProductiveStreak = 0;
    this.toolErrorCounts = {};
  }

  /** Full reset including nudge counter (call when starting a new round). */
  resetAll(): void {
    this.reset();
    this.nudgesSent = 0;
  }

  get nudgeCount(): number {
    return this.nudgesSent;
  }
}
