export function assertRowCount(
  result: { rowCount?: number | null },
  expected = 1,
  context = "database mutation"
): number {
  const actual = result.rowCount ?? 0;
  if (actual < expected) {
    throw new Error(`Expected at least ${expected} affected row(s) during ${context}, got ${actual}`);
  }
  return actual;
}
