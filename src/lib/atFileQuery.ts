/**
 * `@` file mention ranking for the composer at-panel.
 *
 * 触发检测（`@query` 的定位与求值）已迁到文档位置空间，见
 * {@link import("@/lib/composerQuery").queryRangeBeforeCaret}；这里只保留面板的
 * 候选排序。
 */

/** Hit shape used for ranking (subset of codebase search hit). */
export type AtFileHit = {
  path: string;
  name: string;
  relativePath: string;
  mtimeMs?: number;
};

/**
 * Fuzzy score for ranking file hits against a query.
 * Higher is better. 0 = no match (when query non-empty).
 */
export function scoreAtFileHit(hit: AtFileHit, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) {
    // Empty query: prefer recent mtime.
    return hit.mtimeMs != null ? Math.min(hit.mtimeMs / 1e12, 1) : 0;
  }
  const name = (hit.name || "").toLowerCase();
  const rel = (hit.relativePath || hit.path || "").toLowerCase().replace(/\\/g, "/");
  if (name === q) return 1000;
  if (name.startsWith(q)) return 800 - Math.min(name.length, 100);
  if (name.includes(q)) return 600 - name.indexOf(q);
  if (rel.includes(q)) return 400 - Math.min(rel.indexOf(q), 100);
  // Subsequence (fuzzy) match on basename
  let qi = 0;
  for (let i = 0; i < name.length && qi < q.length; i++) {
    if (name[i] === q[qi]) qi++;
  }
  if (qi === q.length) return 200 - name.length;
  return 0;
}

/** Sort hits for the @ panel (best first). Drops zero-score when query set. */
export function rankAtFileHits<T extends AtFileHit>(
  hits: T[],
  query: string,
): T[] {
  const q = query.trim();
  const scored = hits
    .map((h) => ({ h, s: scoreAtFileHit(h, q) }))
    .filter((x) => (q ? x.s > 0 : true));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const am = a.h.mtimeMs ?? 0;
    const bm = b.h.mtimeMs ?? 0;
    if (bm !== am) return bm - am;
    return (a.h.relativePath || a.h.name).localeCompare(
      b.h.relativePath || b.h.name,
    );
  });
  return scored.map((x) => x.h);
}
