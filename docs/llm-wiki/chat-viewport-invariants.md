# Chat viewport invariants — what to do when you change transcript height

The transcript is the `.lobe-chat__scroll` column of the chat session. Its
position is controlled explicitly by this app, not by the engine (ADR-0006).
This page is the **single authority** for the rules that hold there: the C1–C5
invariants, the position model, the resident-list contract, the layout ledger,
folding, occlusion, and jump/find. If you add anything that can change the
transcript's height — a new row type, a fold, a media element, a nested
scroller, an animation — read this page first and satisfy the checklist at the
end.

Terminology is defined in `CONTEXT.md` (pinned, escaped, anchor, layout clamp,
viewport band, layout ledger, estimate, shell render). Architecture record:
`docs/adr/0006-explicit-chat-viewport-control.md`. Design spec:
`docs/plans/2026-10-18-chat-viewport-scroll-spec.md`. Diagnostics:
[chat-viewport-trace.md](./chat-viewport-trace.md); measured budgets:
[chat-viewport-budget.md](./chat-viewport-budget.md).

## The invariants (C1–C5)

Judged at the **paint boundary** (after rAF layout, before paint), each with a
0.5px bound:

- **C1 pinned-exact** — while pinned, the distance to the content end is 0 on
  every drawn frame.
- **C2 visible-content stable** — a drawn frame does not move what the user is
  looking at, unless the move is their own gesture.
- **C3 reading-stable** — while escaped, neither new output arriving nor a
  height change above the reading position moves the anchor.
- **C4 intent-only** — only user intent can change the pinned/escaped state.
- **C5 restore-correct** — the first drawn frame after occlusion ends satisfies
  C1, or C3 when escaped.

## Position model — one writer, one restore per batch

- **Single writer.** `src/hooks/useChatViewportController.ts` is the only module
  that writes the transcript's `scrollTop` (through `applyScrollTop` /
  `assign`, recorded by `applyScrollTopTraced`). The pure planner
  `src/lib/chatViewportController.ts` decides *where* the viewport must sit and
  never touches the DOM. No other module may assign a transcript position —
  `src/lib/chatViewportWriteSources.guard.test.ts` fails the build if one does.
- **Pinned → content end.** While pinned the target is always
  `contentEndScrollTop(geometry)`.
- **Escaped → the anchor at the viewport top.** The anchor is the element at the
  top of the viewport, resolved by `resolveTopAnchorElement`: the descent stops
  at the **first scroll container** it reaches (the activity steps table, the
  thinking / fragment bodies). The anchor is *never* an element inside a nested
  scroller — a change inside such a scroller (a decode especially) moves an
  element without resizing the scroller's box, so neither the content
  `ResizeObserver` nor the `MutationObserver` would report it, and the invariant
  would be unenforceable. The interior of a nested scroller is that scroller's
  own reading surface.
- **Restore once per height-changing batch, before paint.** When a batch changes
  the height, the controller restores the invariant **once**, at the end of the
  batch, **before paint** — it does not chase the position per frame. Mutation
  callbacks are microtasks, so the first `scheduleRestore` call lands before
  paint; the latch coalesces every further mutation in the same frame into that
  one restore (at most one geometry read and one write per frame, per the
  budget). `restoreLayout` / `reportRowHeight` / the content `ResizeObserver`
  all funnel into `scheduleRestore` → `restoreNow`.
- **Restore, don't chase.** A caller reports a measured height or a decided
  position and asks the controller to restore. It never writes `scrollTop`.
- **Distance to the content end is one helper, with an explicit clamp.**
  `distanceFromBottom` (`src/lib/stickToBottom.ts`) computes
  `scrollHeight - clientHeight - scrollTop`; the follow policy reads it clamped
  (an overscroll is simply "at the bottom"), and the dev trace reads it
  unclamped (`clamp: false`) so a trace does not hide a negative, overscrolling
  position. `contentEndScrollTop` is the same point expressed as a `scrollTop`,
  and is also the clamp for any anchor target — one content end, no second name
  for it.

### Tolerance

`VIEWPORT_ANCHOR_TOLERANCE_PX` (`src/lib/chatViewportController.ts`) is **0.5px**
— the C1/C3 bound. One number backs three decisions that must agree: the escaped
restore corrects once the anchor moves past it, the write path skips a target
this close to the current position (*never* write for noise, always write for a
violation), and the trace counts a displacement past it as a sample-worthy
frame.

**The write threshold must never exceed the tolerance.** If it did, a real
violation would be classified as noise and left uncorrected; keeping the two
equal means a displacement large enough to count is always large enough to
correct, and a sub-tolerance jitter is never amplified into a write.

## Resident-list contract

The transcript is a **resident list** (`src/hooks/useChatResidentList.ts`,
`src/lib/chatResidentBand.ts`): no moving window, no spacers between rows.

- **Every row is in the DOM** for the whole session.
- **Only the visible band renders content.** The band is the rows the viewport
  spans plus a margin (`CHAT_RESIDENT_OVERSCAN_MIN_PX` /
  `CHAT_RESIDENT_OVERSCAN_MAX_PX`); it has **no fixed row cap**. The band is
  computed from the ledger (`bandFor`, an O(log n) offset search), never a rect
  walk.
- **Out-of-band rows are height-only shells** — their box height comes from the
  ledger, their content is not rendered. A placeholder is allowed there and
  only there.
- **The band is recomputed synchronously inside the write path.** The resident
  list subscribes with `controller.subscribePosition(refreshBand)`, so a
  programmatic jump (find / Home / rail) re-bands in the same write before the
  landing paints — a shell must never be painted inside the visible band. The
  band is also recomputed before paint from a `useLayoutEffect`.
- **Rows carry `data-virt-index`.** The trace and the visible-band shift metric
  (C2) match rows across frames by that attribute.
- **No shell inside the visible band.** `shellsCrossingViewport`
  (`src/lib/chatResidentBand.ts`) is the rule; the dev-only paint-boundary check
  enforces it.
- **Two "viewport not usable" floors, for two different readers.** The follow
  guard treats a scroller shorter than `STICK_MIN_VIEWPORT_HEIGHT_PX` (32px) as
  unusable — there is no room to follow, so no position write is made
  (`isStickViewportUnreliable`, the same rule `assessViewportOcclusion` uses).
  The band has its own floor for a scroller that reports 0 (hidden, or not yet
  measured): `CHAT_RESIDENT_FALLBACK_VIEWPORT_PX` (800px) stands in so the band
  cannot collapse onto a single row, and the margin floor
  `CHAT_RESIDENT_OVERSCAN_MIN_PX` keeps the same runway. The floors are
  independent — the follow guard answers "may this frame drive the position?",
  the band floor answers "how much must render?".

### Selecting text during a scroll

While a gesture-driven scroll is in flight the controller sets
`data-scrolling="1"` on the transcript viewport
(`noteTranscriptScrolling`), and `.lobe-chat__scroll[data-scrolling="1"] > *`
drops `pointer-events` on the row content for the duration. This is a
scroll-perf optimization: content moving under a stationary cursor otherwise
re-resolves `:hover` on every frame. The known interaction is with selection —
a text selection begun or extended during an active scroll cannot hit the row
content until the flag clears (`SCROLLING_FLAG_IDLE_MS`, 220ms after the last
scroll; a gesture-free scroll while pinned does not set it, so stream growth
never flashes it). The Spec's user story about selecting text while scrolling is
served by this: the flag is only set while a gesture is actually moving the
view, and it clears as soon as the gesture stops. Do not remove the flag without
replacing the hover-recalc rollback.

## The layout ledger

`src/lib/chatViewportLedger.ts` is the single source of truth for every row's
height and offset. Three height tiers, in priority order:

- **measured** — a real render was observed for this row. Exact.
- **remembered** — a height carried over from a persisted transcript.
- **estimate** — a guess for a row that has **never** been rendered. An estimate
  may only ever describe a never-rendered row; a lower tier never overwrites a
  higher one, so a late estimate cannot move a row the user has already seen.

The scrollbar promise follows the tiers: the resident list sets every shell's
height from the ledger, so the total (and the scrollbar drawn from it) is exact
for every measured row and estimated only for rows never rendered yet.

**The generation guard.** Every measurement is stamped with the row's generation
(`generationOf`). A measurement taken before the row's last `reestimateRow` is
rejected by `setRowHeight`, so a measurement queued in the same frame cannot
restore the old shape.

**Demotion is the way to say "this row changed while it was not rendered."**
`reestimateRow` forces a row back to the **estimate** tier even after it was
measured, and bumps the row's generation (authoritatively — see the guard). It
deliberately bypasses the tier rule, because the estimate is the newer, correct
shape. Use it for a shell whose collapsible content changed while it was outside
the band: the next real render measures the row again and upgrades it back to
`measured`.

## Folding

**Never preserve space.** A collapse changes the row's real height at once; the
position is the anchor invariant's job, not a spacer's. The scrollbar length
tracks the real content length before and after a fold.

**A fold outside the band reaches the ledger through the fold projection.**
`resolveRowActivityFold` (`src/lib/chatRowCollapse.ts`) projects a row's fold
state from the message model using the same `activityUnitDefaultOpen` policy the
rich components read, so a shell's ledger height cannot disagree with what the
row would render. When a tracked shell's fold flips, the resident list's layout
effect re-seeds its ledger row (`controller.reestimateRow`) and re-renders
**exactly that shell** before paint:

- fold closed → the estimate (the collapsed shape);
- fold opened → the height remembered from the row's last expanded render,
  falling back to the estimate. This carries an out-of-band re-growth, not only
  a collapse.

A rich row is left alone — its own measurement is exact.

**The reading-position ruling.** A fold **at or above** the reading position
leaves what the user is reading still; a fold **below** it keeps the viewport top
fixed.

- Pinned: the anchor is the content end, so any fold keeps the view pinned at the
  end.
- Escaped: the anchor is the element at the viewport top. A fold at or above
  that element moves the content and the restore scrolls to keep the anchor's
  on-screen position — the reading content does not move. A fold below it leaves
  the anchor's offset unchanged, so the viewport top stays fixed while the
  content under it moves up.

## Occlusion and display changes

- **No follow while hidden or covered.** `assessViewportOcclusion`
  (`src/lib/chatViewportOcclusion.ts`) delegates the reliability rule to
  `isStickViewportUnreliable` (called with `document.hidden`, the host's covered
  report, and the scroller's `clientHeight`). A hidden window, a window
  completely covered by another app (the macOS host signal
  `chat-viewport://occlusion`), or a collapsed scroller stops the render loop, so
  a follow write there is unobservable and its geometry stale.
- **The first painted frame after the state returns satisfies the invariant.**
  `shouldRestoreAfterOcclusion` says the change is a restore boundary when the
  viewport is available now and was occluded before, or the window just regained
  focus (an occlusion that happened while blurred left no signal of its own, so
  focus is the only boundary available for it). C5 is judged on that exit frame.
- **Cadence-independent.** The restore latch is cleared by the next frame **or**
  by a stalled-rAF fallback (`pausedRafFallbackMs`, `src/lib/frameCadence.ts`).
  A latch that only a frame could clear would stick while the frame loop is
  paused, and every later mutation would return early — the transcript would
  stop being restored. The fallback is several frame intervals out, so while
  frames flow the frame path still wins. Never assume a fixed 60Hz cadence.

## Jump and find

- **A jump lands escaped unless the target is the content end.** `planJump` /
  `jumpTo` re-engage follow only when the target is the conversation's last row
  or a position that clamps to the content end; every other target lands on its
  position and **escapes onto it**, capturing the landing as the new anchor so a
  later height change above restores it instead of displacing the landed
  message.
- **A find hit outside the band must be rendered rich in the frame that paints
  the landing.** The write path re-bands synchronously
  (`controller.subscribePosition`), so the landed row's content is present in the
  same frame — it must never paint as a shell.

## If you change transcript height, do this

1. **Route the change through the ledger.** Never set a transcript row's height
   in a way the ledger does not know. Estimates seed it (`seedResidentLedger`);
   real renders report measured heights back.
2. **Report, don't write.** After the batch, ask the controller to restore with
   `reportRowHeight` (measured height) or `restoreLayout` (a decided position).
   Never assign `scrollTop` yourself.
3. **Keep it before paint.** Do the work in a layout effect (or the controller's
   write path), so React has flushed it before the browser paints; a passive
   effect lands a frame late and paints a wrong frame.
4. **Project a shell's shape change.** If a row's fold can change while it is a
   shell, make `resolveRowActivityFold` mirror the rich component's policy, so
   the shell demotes through `reestimateRow` and the scrollbar follows at once.
5. **Map media to a reserved box.** A decode carries no DOM mutation with the
   new size; give the element its box up front so the height never changes on
   decode, or let the content `ResizeObserver` hold the escaped anchor.
6. **Keep `overflow-anchor: none` on every nested scroller.** ADR-0006 makes the
   opt-out load-bearing, and the CSS must be scoped to the transcript subtree.
7. **Never add a second writer.** Use the controller handle
   (`ChatViewportControllerHandle`).

Guards that fail if you get it wrong:

- A second transcript writer → `src/lib/chatViewportWriteSources.guard.test.ts`.
- A re-enabled engine anchor (a nested scroller or a sibling surface that stops
  opting out) → `src/components/lobe-chat/transcriptAnchoring.guard.test.ts`.
- A missed restore, a stale band or a missed fold → the scenario runner
  (`pnpm scenarios:chat-viewport`), `src/hooks/chatJumpFind.test.tsx`,
  `src/hooks/chatEscapedAnchorFold.test.tsx`, and the harnesses
  (`pnpm measure:chat-first-frame`, `pnpm measure:chat-scroll`, see
  [chat-viewport-budget.md](./chat-viewport-budget.md)).
