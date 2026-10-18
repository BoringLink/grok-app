/**
 * Transcript row-height bookkeeping for the resident list.
 *
 * Two jobs:
 * - content-aware estimates that seed the layout ledger before a row has ever
 *   been rendered, so a long conversion's shell heights are close to the real
 *   ones from the first frame;
 * - the commit gate that filters a measured height (sub-pixel / scrollbar
 *   flicker, small shrink thrash) before it reaches the ledger.
 *
 * Pure module: no DOM, no React.
 */

import { phaseErrorExcerptHeightPx } from "@/lib/phaseErrorExcerpt";

/** Fallback height before a row is measured (px). */
export const CHAT_DEFAULT_ROW_ESTIMATE_PX = 120;

/** Cap a single estimated row so one mega-answer cannot dominate shell math. */
export const CHAT_MAX_ROW_ESTIMATE_PX = 8000;

/** Chat image card max height (must match ImageUi CHAT_IMAGE_CARD_MAX_H). */
export const CHAT_IMAGE_CARD_ESTIMATE_H = 160;
/** Typical images per wrapping row in the assistant body (~240px cards). */
export const CHAT_IMAGE_CARDS_PER_ROW = 3;

/**
 * Content-aware row estimate so tall assistant answers (diagrams, tables) are
 * not first measured as ~120px — that underestimates shell height and makes a
 * mid-document look "near bottom".
 *
 * Estimates are coarse and intentional: they only seed the ledger's estimate
 * tier, and a real render immediately upgrades the row to measured.
 */
export function estimateChatRowHeight(input: {
  contentLength?: number;
  thoughtLength?: number;
  role?: string;
  rawContent?: string;
  /** Number of tool steps woven into the assistant timeline (adds phase chrome). */
  toolCount?: number;
  /**
   * Failed tools in a folded Worked-for phase (history). Adds excerpt-row
   * height so shell math is not short by N×36px.
   */
  failedToolCount?: number;
  /**
   * Non-image attachment chips (file/folder under the bubble), or user-strip
   * 36px thumbs when role is user.
   */
  attachmentCount?: number;
  /** Assistant image cards (inline path tokens + leftover bottom gallery). */
  imageCardCount?: number;
  /** True when body likely embeds a local video card. */
  hasVideoCard?: boolean;
  /** Inlined / collapsed tool rows estimate 0 (no phantom shell height). */
  collapsed?: boolean;
  /**
   * Thinking fold is open (live stream, or user set keep-open). Default is
   * collapsed — do not count thoughtLength or the estimate overshoots by
   * hundreds of px.
   */
  thoughtExpanded?: boolean;
}): number {
  if (input.collapsed) return 0;
  const rawText = input.rawContent ?? "";
  const content = Math.max(0, input.contentLength ?? rawText.length);
  const thoughtRaw = Math.max(0, input.thoughtLength ?? 0);
  const thought = input.thoughtExpanded === true ? thoughtRaw : 0;
  const role = (input.role ?? "assistant").toLowerCase();
  const imageCards = Math.max(0, input.imageCardCount ?? 0);
  // Empty tool journal rows must not inflate shell height (blank tail).
  if (
    role === "tool" &&
    content === 0 &&
    thoughtRaw === 0 &&
    !(input.attachmentCount && input.attachmentCount > 0) &&
    imageCards === 0 &&
    !input.hasVideoCard
  ) {
    return 0;
  }
  // Collapsed CoT is a ~38px "Thought" chip.
  const thoughtChrome = !input.thoughtExpanded && thoughtRaw > 0 ? 38 : 0;
  // Tool phase activity header ("Worked for ...") is ~42px; folded
  // failures add one-line excerpt rows under that header.
  const toolPhaseChrome =
    ((input.toolCount ?? 0) > 0 ? 42 : 0) +
    phaseErrorExcerptHeightPx(input.failedToolCount ?? 0);

  // Modern chat width (~700-900px): ~50-65 chars per line typical.
  const charsPerLine = role === "user" ? 50 : 65;
  const explicitNewlines = rawText ? (rawText.match(/\n/g) || []).length : 0;
  // Code fence chrome (header bar + padding) ~56px per fence
  const codeBlockCount = rawText ? (rawText.match(/```/g) || []).length / 2 : 0;
  const codeChrome = Math.floor(codeBlockCount) * 56;

  const charLines = Math.ceil((content + thought * 0.5) / charsPerLine);
  const effectiveLines = Math.max(charLines, explicitNewlines + 1);
  const lineHeight = role === "assistant" ? 23 : 20;
  const chrome = role === "user" ? 44 : role === "tool" ? 24 : 64;
  const atts = Math.max(0, input.attachmentCount ?? 0);
  // 36px chips + gap; user strip packs to ~70% width (~6–8 chips/row typical).
  const slots = atts > 3 ? 4 : atts;
  const attRows = slots > 0 ? Math.ceil(slots / 6) : 0;
  const attBoost = attRows * 44;
  const imgRows =
    imageCards > 0 ? Math.ceil(imageCards / CHAT_IMAGE_CARDS_PER_ROW) : 0;
  const imgBoost = imgRows * CHAT_IMAGE_CARD_ESTIMATE_H;
  const videoBoost = input.hasVideoCard ? 260 : 0;
  const raw =
    chrome +
    effectiveLines * lineHeight +
    thoughtChrome +
    toolPhaseChrome +
    codeChrome +
    attBoost +
    imgBoost +
    videoBoost;
  // Tool rows are compact; do not floor them at the assistant default (120px).
  const floor = role === "tool" ? 0 : 80;
  return Math.min(CHAT_MAX_ROW_ESTIMATE_PX, Math.max(floor, raw));
}

/**
 * Whether a measured row height may replace what the ledger already holds.
 *
 * Ignores sub-pixel / scrollbar-gutter flicker and small shrink thrash that
 * would otherwise oscillate the shell height and re-band the list every frame.
 */
export function shouldCommitRowHeight(
  prev: number | undefined,
  next: number,
): boolean {
  if (next < 0) return false;
  // Zero-height rows are real (inlined tool_step rows). Rejecting them leaves
  // phantom shell space and a tail that only mounts empty rows.
  if (next === 0) {
    return prev == null || prev !== 0;
  }
  if (prev == null) return true;
  const delta = next - prev;
  // 4px floor: ignores subpixel + scrollbar-gutter flicker after images settle.
  if (Math.abs(delta) < 4) return false;
  // Allow growth freely; only accept shrinks that are meaningful and stable.
  if (delta < 0 && Math.abs(delta) < Math.max(24, prev * 0.08)) {
    return false;
  }
  return true;
}
