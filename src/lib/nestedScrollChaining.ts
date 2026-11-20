/**
 * Scroll chaining from nested transcript scrollers (thought body, tool steps,
 * tool output) to the chat viewport.
 *
 * Nested boxes use `overscroll-behavior: contain`, so the browser stops the
 * scroll chain at their edge: the wheel keeps turning while nothing moves.
 * These helpers decide how much of a wheel delta each box can still consume
 * and how far the outer viewport can move. Metrics are plain numbers so the
 * caller can feed real DOM geometry or tests.
 */

/** Treat sub-pixel scroll positions as the edge (trackpad deltas are fractional). */
export const NESTED_SCROLL_EDGE_EPSILON_PX = 0.5;

/** Below this, a scrollTop write is not worth a layout/paint; matches the
 * transcript writer's no-op threshold. */
export const NESTED_SCROLL_WRITE_EPSILON_PX = 1;

/** A wheel gesture can lose its DOM target to `data-scrolling`'s
 * `pointer-events: none`. Remember the nested box this long (the hover tree
 * is restored at 220ms). */
export const NESTED_SCROLL_GESTURE_IDLE_MS = 250;

const WHEEL_LINE_HEIGHT_PX = 16;

export type ScrollBoxMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

/** Convert a wheel delta into vertical pixels (line/page modes included). */
export function wheelDeltaToPixels(
  deltaY: number,
  deltaMode: number,
  pageHeight: number,
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  if (deltaMode === 1) return deltaY * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return deltaY * Math.max(1, pageHeight);
  return deltaY;
}

/** True when the box still has room in the gesture's direction. */
export function canNestedBoxConsume(
  box: ScrollBoxMetrics,
  deltaY: number,
): boolean {
  if (deltaY === 0) return false;
  const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
  if (maxTop <= NESTED_SCROLL_EDGE_EPSILON_PX) return false;
  if (deltaY < 0) return box.scrollTop > NESTED_SCROLL_EDGE_EPSILON_PX;
  return box.scrollTop < maxTop - NESTED_SCROLL_EDGE_EPSILON_PX;
}

/**
 * Clamped next `scrollTop` after carrying `deltaY` into a box. `null` means
 * the box cannot move in that direction.
 */
export function nextScrollTop(
  box: ScrollBoxMetrics,
  deltaY: number,
): number | null {
  const maxTop = Math.max(0, box.scrollHeight - box.clientHeight);
  const next = Math.min(maxTop, Math.max(0, box.scrollTop + deltaY));
  if (Math.abs(next - box.scrollTop) < NESTED_SCROLL_WRITE_EPSILON_PX) {
    return null;
  }
  return next;
}
