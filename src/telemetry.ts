/**
 * Latency accounting against the 800 ms budget. Build sheet item 49 proper is
 * a dashboard; this is the measurement it will read, and it is here in Phase 1
 * because a loop you cannot measure is a loop you cannot tune.
 */

export type Stage = "wake" | "stt" | "llmFirstToken" | "tts" | "transit";

const BUDGET_MS = 800;

export class Turn {
  private marks = new Map<Stage, number>();
  private t0: number;

  constructor(startedAt: number = Date.now()) {
    this.t0 = startedAt;
  }

  mark(stage: Stage): void {
    if (!this.marks.has(stage)) this.marks.set(stage, Date.now() - this.t0);
  }

  /** Cumulative ms at each stage, plus the total and whether we made budget. */
  report(): { stages: Array<[Stage, number]>; total: number; withinBudget: boolean } {
    const stages = [...this.marks.entries()].sort((a, b) => a[1] - b[1]);
    const total = stages.length ? stages[stages.length - 1]![1] : 0;
    return { stages, total, withinBudget: total <= BUDGET_MS };
  }

  format(): string {
    const { stages, total, withinBudget } = this.report();
    if (!stages.length) return "no timings";
    let prev = 0;
    const parts = stages.map(([s, at]) => {
      const delta = at - prev;
      prev = at;
      return `${s} ${delta}ms`;
    });
    const verdict = withinBudget ? "" : `  OVER BUDGET (+${total - BUDGET_MS}ms)`;
    return `${parts.join(" -> ")}  = ${total}ms${verdict}`;
  }
}
