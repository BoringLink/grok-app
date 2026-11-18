/**
 * Context-window list helpers shared by the settings list and the composer.
 *
 * The window chosen per model now lives in Settings; the Composer only reads
 * the resulting model value for context-usage display.
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
