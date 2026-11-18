/**
 * Context-window list helpers for the official model catalog.
 *
 * Windows come from the CLI catalog only; the App offers no per-model picker.
 */

/**
 * Positive token counts, catalog order, duplicates dropped.
 * Non-finite, zero, and negative values are ignored.
 */
export function positiveContextWindows(
  raw: number[] | null | undefined,
): number[] | undefined {
  if (!raw?.length) return undefined;
  const out: number[] = [];
  const seen = new Set<number>();
  for (const n of raw) {
    if (!Number.isFinite(n) || n <= 0) continue;
    const v = Math.floor(n);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length ? out : undefined;
}
