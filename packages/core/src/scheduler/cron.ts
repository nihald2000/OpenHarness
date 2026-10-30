import { ScheduleManager } from "./index.ts";
export { ScheduleManager };

export function isValidCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5 || parts.length === 6;
}
