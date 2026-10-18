# Chat viewport scroll correctness — Spec

> Status: in review (stage 2). Terms in `CONTEXT.md`, architecture decision in ADR-0006.
> In stage 4 this file will become the description of the Linear parent issue.

## Problem Statement

From the user's point of view: while the agent keeps working in a long conversation, the transcript **flickers upward and drifts**, and **loses the bottom follow** — output is still arriving, yet the viewport stops above it and the user has to scroll back to the bottom over and over. It is worst when a thinking block or a tool-step block collapses. The mirror image also happens: while the user is scrolling up to read history, any reflow of a block above **pushes the content being read away wholesale**. And when the window is covered by another app and comes back, the position is often wrong.

Measured evidence (from this machine's Host log and a real browser harness): a single conversation 59578px tall; while the window was occluded the viewport was up to 11175px off the bottom for 5 straight minutes; the user clicked "back to bottom" 17 times the same day; small repeated reflows cause consecutive 20px-jitter frames and drop the pin outright.

## Solution

From the user's point of view: the transcript's position is controlled precisely by the app, not guessed by the engine.

- **While pinned** it is always glued to the newest output, staying at the tail through a fold above, a re-growth, or an estimate becoming a measurement.
- **While reading up**, the line you are reading does not move because of any change above, nor is it pushed by arriving output.
- **Only your own gesture** (wheel, touch, keyboard, scrollbar drag) can take you off the bottom.
- **When the window is covered and returns**, the position is correct at once.
- **A long conversation no longer relies on estimated heights**: every row's height comes from measurement, the visible area is always real content, and the scrollbar length always matches the content length.

## User Stories

1. As a user, I want the viewport glued to the newest line while the model keeps producing, so I do not have to keep scrolling to the bottom by hand.
2. As a user, I want to stop seeing the transcript jump up and back during output.
3. As a user, I want what I am reading to stay completely still the moment a thinking block collapses.
4. As a user, I want every phase of a tool-step block (start / end / collapse) to not push my reading position.
5. As a user, I want newly arriving output not to push the passage I am reading off when I scroll up through history.
6. As a user, I want a block above me re-growing (for example a new thinking round expanding) not to push my position while I read history.
7. As a user, I want one upward wheel / trackpad swipe to leave the bottom follow immediately, without needing a second swipe.
8. As a user, I want to leave the bottom follow with the keyboard alone (PageUp / arrow keys / Home).
9. As a user, I want dragging the scrollbar to behave the same as the wheel.
10. As a user, I want returning to the hard bottom to re-pin automatically, while not being yanked back within one screen of it.
11. As a user, I want the "back to latest" button to be available after escaping and to return to the tail in one click.
12. As a user, I want output to continue while the window is covered by another app, and on return to still see the correct bottom (or the line I was reading).
13. As a user, I want opening a long conversation to land at the tail directly, without waiting for it to "scroll down".
14. As a user, I want the position to still be correct after switching sessions and back.
15. As a user, I want the escaped state and the position to be unambiguous after a quote jump / find (after jumping to a message I am "escaped", unless it is the end).
16. As a user, I want long conversations (tens of thousands of rows, hundreds of thousands of pixels) to still scroll smoothly, at the same frame rate as a short one.
17. As a user, I want the scrollbar length to match the real content length, not to lie because of a fold or a placeholder.
18. As a user, I want the content in the visible area to always be real (never a placeholder skeleton scrolled into view).
19. As a user, I want to select text and drag a selection normally during scrolling, without interruption.
20. As a user, I want expanding / collapsing a nested scroller (thinking body, tool output) not to move the outer viewport.
21. As a user, I want the position and frame rate to be correct after a window resize (including dragging back from an external display, and a 120Hz ↔ 60Hz switch).
22. As a user, I want media (images / attachment cards) not to push the transcript when their decode finishes.
23. As a user, I want a 120Hz screen to scroll at 120fps, without dropped-frame jitter.
24. As a maintainer, I want all three platforms (macOS/Windows/Linux) to behave the same, without platform-branched scroll logic.
25. As a maintainer, I want regressions pinned by automation: an invariant violation is caught by a scripted scenario inside the client, not by user reports.
26. As a maintainer, I want to read from the log directly "which layout change threw the position off".
27. As a maintainer, I want a clear rule to obey (the anchor invariant) whenever I add anything that changes transcript height, instead of relying on intuition.

## Implementation Decisions

- **Single writer**: add a viewport controller that becomes the transcript's only `scrollTop` writer. The transcript list is no longer a writer; it produces layout only (which rows carry content; row height decided by the ledger).
- **Position model**: the anchor invariant. While pinned the anchor is the content end; while escaped it is the element at the viewport top. Restore once at the end of every height-changing batch (a microtask within the batch, before paint); no "per-frame follow", no multi-frame compensation.
- **Intent model**: only wheel / touch / keydown (including PageUp, PageDown, arrow keys, Home, End, space) / scrollbar drag counts as user intent. A gesture-free upward move is always classified as a layout clamp: keep the pin and rewrite the end; two consecutive "upward moves at an unchanged height" upgrade to a drag intent. The escaped state can only be entered by intent, and is only exited by returning to the hard bottom or by clicking the button.
- **Layout model**: every row is resident in the DOM, its height set by the ledger, off-band rows getting `contain: strict`. The visible band (the range that renders real content) is **computed dynamically from the viewport height** (including a margin); there is no fixed row-count cap; everything inside the band is a rich render, everything outside drops its content. The row-count cap is not a correctness parameter — it only affects performance and is decided by measurement.
- **Layout ledger**: a prefix-sum array plus incremental rebuild of a dirty span. Height-source priority: measured > remembered > estimate; an estimate may only describe a row that has never been rendered.
- **Folding**: never preserve space. A fold only changes height; the position is guaranteed by the invariant; the scrollbar length always matches the content length.
- **Re-pin**: only at the hard bottom (distance to the content end is 0) or by an explicit button.
- **Occlusion**: no follow while occluded; the first drawn frame after visibility returns restores the invariant (pinned → the end, escaped → the original anchor).
- **Engine**: keep `overflow-anchor: none`, and apply it per nested scroller (the spec says descendant scroll containers re-enable it themselves). Do not rely on `content-visibility`, `scrollend`, or engine anchoring.
- **Diagnostics**: keep the trace probe dev-only. Change the dump to "the triggering event plus the most recent N events" and remove the current 8192-character truncation problem of "keep the oldest, drop the trigger"; keep the heartbeat fields (pinned/escaped, distance to the end, visible-band shift, write source).
- **Performance budget**: 120fps target (≤ 8.3ms per frame); at most one layout read + one `scrollTop` write per frame while scrolling; opening a 10k-row conversation in ≤ 400ms first frame; ledger memory growth ≤ 20MB.
- **Platforms**: all three share one code path; **only macOS is verified locally**, and the claim of Windows/Linux behavioral consistency is verified by the upstream author (see Further Notes).

## Testing Decisions

- **What counts as a good test**: test external behavior only — the invariants and observable output (per-frame distance, visible shift, escaped state, write count, frame cost) — not internal structure (not which hook called whom).
- **Seam one (new, pure logic)**: make the viewport controller and the layout ledger pure modules — input is "a mutation-batch description + a ledger snapshot + the intent state", output is "a position directive". Cover directly with vitest: pin maintenance, clamping without escaping, the two intent-upgrade paths, prefix-sum dirty-span rebuild, estimate only for unrendered rows.
- **Seam two (reuse the existing topmost seam)**: the in-client trace channel (probe + Host log + scripted scenarios). Scenarios run the real transcript in a dev build and assert on the heartbeat and event sequence in the log. Synthetic scenarios cover at least: continuous output, a fold above, a re-growth above, small repeated reflow, a gesture-free upward move, a real wheel upward move, occlusion and restore, window resize, nested-scroller expand, media decode.
- **Prior art**: the `FakeViewport` + `ControlledResizeObserver` pattern first written for the stick hook's test; the product harness used during research (real hook + real resident list + real CSS).

## Acceptance criteria

> The tracker's own copy of these criteria stays in the language of the team's Linear workspace; this listing is the English translation.

The invariants (defined in `CONTEXT.md`) are judged per frame at the **paint boundary**:

- **C1 pinned-exact** ≤ 0.5px; **C2 visible-content stable** ≤ 0.5px; **C3 reading-stable** ≤ 0.5px; **C4 intent-only** violation count 0; **C5 restore-correct** satisfied on the first returned frame.
- All the above scenarios pass, and there is ≤ 1 write per frame while scrolling.
- 10k rows / 600k px: first frame ≤ 400ms, scroll frame cost ≤ 8.3ms (120fps target), ledger memory growth ≤ 20MB.
- The sampling convention must be the **paint boundary** (after rAF), not a mutation callback — sampling from mutation callbacks during research once produced a false 980px jump.

## Out of Scope

- Local verification on Windows / Linux (left to the upstream author).
- The progressive-enhancement paths for `content-visibility` / `scrollend`.
- Non-transcript scroll areas such as the composer, sidebar and settings panel.
- Fold animations (an animation creates continuous height changes, which pairs badly with the invariant; not introduced this time).
- Product surfaces outside the transcript (the Remote IM panel, etc.).

## Further Notes

- **Platform promise**: all three share one code path; local verification covers macOS only (including 120Hz ProMotion). Ownership of cross-platform verification is part of a personal workflow and is recorded in the Linear `Grok App` project overview, not in this repository, so that a personal process is not carried upstream.
- **Baseline numbers** (for regression comparison): a single conversation 59578px; maximum deviation during occlusion 11175px; 17 "back to bottom" clicks the same day; the current implementation shows consecutive 20px-jitter frames under small reflow and drops the pin.
- **Related records**: ADR-0006 (explicit viewport control and turning engine anchoring off). The first round of fixes was committed as the branch baseline (compensation lands in the mutation batch + an intent gate); this delivery does the structural rework on top of it.
