import type { RunState } from "../agent/deps.ts";
export { LayeredContextManager } from "./manager.ts";

export function shouldReciteAtStep(iteration: number, everyTurns = 8): boolean {
  return iteration > 0 && iteration % everyTurns === 0;
}

export function formatBudgetRecitation(state: RunState): string {
  return `Iteration ${state.iteration}/${state.budgets.maxIterations} (phase: ${state.phase})`;
}
