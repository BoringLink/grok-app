/**
 * Occlusion model for the chat transcript viewport.
 *
 * The viewport controller positions the transcript from measured geometry,
 * which is only meaningful while the engine is painting the window: a hidden
 * (Page Visibility) window, a window completely covered by another app, or a
 * collapsed scroller stops the render loop, so a follow write is unobservable
 * and the geometry can be stale (the glossary defines occlusion as hidden **or
 * completely covered**). This module turns the observable signals into the two
 * answers the hook needs — may this frame drive the position, and is this
 * change a restore boundary — so the hook only wires listeners. Pure: no DOM,
 * no timers, no writes.
 *
 * `covered` is the macOS host's `NSWindowDidChangeOcclusionState` report: the
 * web layer cannot see "completely covered by another window" (Page Visibility
 * stays `visible`, focus may not change), which the Spec's Problem Statement
 * records as a real source of a wrong position. A blurred-but-*visible* window
 * is deliberately not covered: on a second display the user can still be
 * watching the stream, and blur alone cannot tell "covered" from "unfocused".
 * Blur only arms the restore the next focus performs.
 */

import { isStickViewportUnreliable } from "@/lib/stickToBottom";

/** Tauri event the host emits when the window's occlusion state changes. */
export const CHAT_VIEWPORT_OCCLUSION_EVENT = "chat-viewport://occlusion";

/** Why the viewport could not be trusted to paint this frame. */
export type ViewportOcclusionCause = "hidden" | "covered" | "collapsed";

export type ViewportOcclusion = {
  /** The engine may not be painting, or the scroller has no usable height. */
  occluded: boolean;
  /** The reason, for the trace; `null` while the viewport is available. */
  cause: ViewportOcclusionCause | null;
};

export type ViewportOcclusionSignals = {
  /** `document.hidden` — the Page Visibility signal (minimize / hide / tab). */
  hidden: boolean;
  /** The host reported the window completely covered by another app. */
  covered: boolean;
  /** The scroller's client height; below the floor the geometry is unusable. */
  clientHeight: number;
};

/**
 * Read a host occlusion payload. The payload crosses a process boundary, so it
 * is untrusted: only a strict `{ occluded: boolean }` is accepted. Returns
 * `null` for anything else, and the caller keeps its previous state.
 */
export function parseHostOcclusionPayload(payload: unknown): boolean | null {
  if (typeof payload !== "object" || payload === null) return null;
  const occluded = (payload as { occluded?: unknown }).occluded;
  return typeof occluded === "boolean" ? occluded : null;
}

/**
 * Assess whether this frame's geometry may drive the transcript position.
 * Delegates the reliability rule to {@link isStickViewportUnreliable} so the
 * follow guard and the restore boundary cannot drift apart.
 */
export function assessViewportOcclusion(
  signals: ViewportOcclusionSignals,
): ViewportOcclusion {
  if (!isStickViewportUnreliable(signals)) {
    return { occluded: false, cause: null };
  }
  return { occluded: true, cause: occlusionCause(signals) };
}

/** The first applicable cause, so the trace names the strongest signal. */
function occlusionCause(
  signals: ViewportOcclusionSignals,
): ViewportOcclusionCause {
  if (signals.hidden === true) return "hidden";
  if (signals.covered === true) return "covered";
  return "collapsed";
}

/**
 * Whether an availability change means the invariant must be re-asserted
 * before the next paint.
 *
 * The viewport must be available now (positioning a collapsed or hidden
 * scroller would write a wrong position), and the change must be a boundary:
 * the occlusion just ended, or the window just regained focus — the latter
 * because an occlusion that happened while blurred left no signal of its own,
 * so focus is the only boundary we get for it.
 */
export function shouldRestoreAfterOcclusion(input: {
  /** The viewport was occluded before this signal. */
  wasOccluded: boolean;
  /** The viewport is occluded now. */
  occluded: boolean;
  /** This signal is a window focus regain. */
  regainedFocus: boolean;
}): boolean {
  if (input.occluded) return false;
  if (input.wasOccluded) return true;
  return input.regainedFocus;
}
