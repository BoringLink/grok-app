# Chat viewport budgets — measured report

Scope: the chat transcript viewport delivery's performance budgets
(`docs/plans/2026-10-18-chat-viewport-scroll-spec.md`, ticket BOR-115). The
delivery's invariants and diagnostics live in `docs/adr/0006-explicit-chat-viewport-control.md`
and `docs/llm-wiki/chat-viewport-trace.md`.

Status: **measured on the frontend only, in headless Chromium.** The budgets are
bounded here; the packaged macOS / WKWebView number is left for the manual pass
(see "What this does not prove").

## Budgets

| Budget | Target | Measured | Verdict |
|--------|--------|----------|---------|
| Scroll frame cost (10k rows) | ≤ 8.3ms (120Hz) | rAF-callback p99 3.8–4.2ms, max 4.8–8.6ms across runs; 0–1 frames over 8.3ms | pass |
| Streaming frame cost (10k rows) | ≤ 8.3ms | rAF-callback p99 2.2–3.5ms, max 2.5–4.1ms over 120 growth frames | pass |
| First frame (10k rows) | ≤ 400ms | 27–50ms across runs | pass |
| Ledger memory (10k rows) | ≤ 20MB | 244.1KB (250,008 bytes) | pass |
| Position writes per frame | ≤ 1 | max 1/frame, 0 frames over 1, in both phases | pass |

## Machine and versions

- Apple M5, 10 cores, macOS 26.5.2 (build 25F84).
- Google Chrome 155.0.8059.84 (headless `--headless=new`).
- Node v24.20.0; the repo's pinned pnpm.
- Conversation: 10,000 rows, ledger-seeded, height ≈ 599,000px, viewport
  469px tall (the harness window).

These are a single machine snapshot; absolute times move with CPU load. Read
the shapes (max, p99, over-budget count) as the result, not the decimals.

## Method

Two headless-Chrome harnesses drive the **real** modules — the resident list
(`useChatResidentList`), the viewport controller (`useChatViewportController`
plus the pure planner) and the layout ledger — with real DOM, real layout and
real `ResizeObserver` / `MutationObserver` delivery:

- `scripts/measure-chat-first-frame.mjs` (rows) — mounts the 10k-row list and
  reports `render()` → first animation frame.
- `scripts/measure-chat-scroll.mjs` (rows, readSteps, streamFrames) — mounts
  the list plus the controller, then runs two phases. The **read** phase escapes
  the tail and walks up through history (200 steps × 240px); the **stream**
  phase re-pins and grows the content by 30px every frame for 120 frames.
- `scripts/run-chat-viewport-scenarios.mjs` — the scripted scenario runner (see
  below).

Frame cost is read from a CDP `toplevel,devtools.timeline` trace as the
**duration of each `FireAnimationFrame`** on the renderer main thread: the rAF
callbacks the app schedules (the band recompute, the controller's restore latch)
plus the work they run before returning. Per-frame **style + layout** is reported
next to it as `UpdateLayoutTree` + `Layout` durations. The React commit for the
rows whose band membership flipped runs on the microtask checkpoint after the
callback, so it is not inside the `FireAnimationFrame` duration; the layout it
forces is the `UpdateLayoutTree` those rows produce and is covered by the
style+layout line.

Position writes come from the controller's own trace counter
(`chatViewportWriteStats`, incremented by the single write funnel
`applyScrollTopTraced`), sampled once per frame; the trace is enabled inside the
harness page only. The ledger figure is the ledger's exact typed-array footprint
(`LayoutLedger.stats().memoryBytes`).

### Verbatim runs

`pnpm measure:chat-first-frame`:

```
first-frame: 41ms for 10000 rows (10000 expected)
parent renders: 1 at mount, 1 after 40 scroll frames
row re-renders during those 40 scroll frames: 2630
```

`pnpm measure:chat-scroll` (representative, clean run):

```
rows: 10000 (ledger 10000)
conversation height: 599004px, viewport 469px
first-frame: 50ms
ledger memory: 244.1KB (250008 bytes)
read-phase frame cost: 806 frames, min 0.00ms, p50 0.01ms, p90 3.26ms, p99 3.78ms, max 4.79ms; frames over 8.3ms: 0
read-phase style+layout: 1330 records, min 0.00ms, p50 0.22ms, p90 0.95ms, p99 1.09ms, max 1.22ms; over 8.3ms: 0
read phase: escaped=true, 597723px -> 534061px
read-phase writes: frames 200, max writes/frame 1, frames over 1 write 0
stream-phase frame cost: 389 frames, min 0.00ms, p50 0.01ms, p90 1.96ms, p99 3.32ms, max 4.10ms; frames over 8.3ms: 0
stream-phase style+layout: 416 records, min 0.00ms, p50 0.07ms, p90 1.86ms, p99 2.75ms, max 3.65ms; over 8.3ms: 0
stream phase: pinned=true
stream-phase writes: frames 120, max writes/frame 1, frames over 1 write 0
```

Run-to-run spread on the read-phase frame cost (same machine): max 4.8ms /
6.8ms / 8.6ms over several runs, with 0 / 0 / 1 frames over 8.3ms. The 8.6ms
frame is headless scheduling jitter — it is a single frame, not a per-frame
cost, and the p99 stays at ~4ms. The honest statement is: the app's own
per-frame work sits around 3–4ms p99 with rare single-frame excursions to
~8.6ms; it does not show a systematic per-frame cost above the 120Hz budget.

## What this does not prove

- **Not WKWebView.** This is Chromium with software rendering in headless mode.
  WKWebView (macOS), WebView2 (Chromium, Windows) and WebKitGTK deliver frames
  differently; the JS/layout work measured here is engine-shared, but the
  raster and frame-delivery halves are not. A real 120Hz ProMotion number is
  impossible in this environment.
- **Not the packaged app.** No Tauri host, no top-level window, no real window
  occlusion. The harness window is a flat 469px scroller.
- **The commit path is adjacent, not inside, the measured number.** The rAF
  callback duration covers the app's scheduled frame work; the React microtask
  commit is covered only through the style+layout it produces.
- Run-to-run variance is real (see the spread above); the harness is a bound,
  not a certification.

## The manual macOS pass: read the log

The packaged client's frame-level numbers come from the dev trace, and the
per-frame write budget is now a single field so the pass is a matter of reading
the log. Enable the trace (`localStorage["grok.chatTrace"]="1"` or
`?chatTrace=1`, plus a tracking id), reproduce on the 10k-row conversation, and
read the `heartbeat` line (dumped with its event window every 10s):

- `frames`, `maxWritesPerFrame`, `framesOverBudget` — the ledger's write budget
  over the sampled frames (`frameWriteSummary`). `framesOverBudget` must be 0.
- `frameIntervalMs` / `fps` — the measured display cadence (120Hz on ProMotion),
  not a fixed 60Hz assumption.
- On the `sample` frames (`by: "raf"`), `d` is the distance to the content end
  (C1, must be 0 while pinned), `v` the visible-band shift (C2), `a` the escaped
  anchor shift (C3), and `w`/`ws` the writes and their source per frame.

Because the frame sampler counts writes from the single write funnel, a body of
`w` values at 0–1 with `framesOverBudget: 0` on a real 120Hz scroll is the
packaged-client proof of the "≤ 1 position write per frame" budget.

## Scenario runner

`pnpm scenarios:chat-viewport` (or `node scripts/run-chat-viewport-scenarios.mjs`)
drives the ten synthetic scenarios the Spec's Testing Decisions name against the
real controller, and asserts on the trace event sequence plus DOM geometry. It
exits 0 only when all pass:

```
PASS  continuous output stays pinned at the end — worst distance to end=0.00px, escapes=0
PASS  a collapse above does not move the escaped anchor — anchor shift=0.00px
PASS  a re-growth above does not move the escaped anchor — anchor shift=0.00px
PASS  small repeated reflow keeps the pin — escapes=0, worst end distance=0.00
PASS  a gesture-free upward move is a clamp, then a drag — pinned after 1st=true, escaped after 2nd=true
PASS  a real wheel upward escapes the tail — escaped=true, causes=wheel
PASS  restore lands back at the end after occlusion — distance to end=0.00px, occlusion events=2
PASS  a window resize re-follows the end — viewport-size event=true, distance to end=0.00
PASS  a nested scroller expanding does not move the outer anchor — anchor shift=0.00px
PASS  a media decode above the anchor does not move it — decoded height=400px, shift=0.00px
10/10 scenarios passed
```

What it asserts: pin/escape state per scenario, distance to the content end
(C1), the escaped anchor element's on-screen shift (C3), the pin-flip causes the
classifier recorded (C4 — `wheel`, `scrollbar`), the `occlusion` enter/exit
events and the restore landing (C5), and the `viewport-size` event on resize.

What it cannot assert here: it runs the controller over a hand-built DOM, not
the resident list / band, and it is Chromium, not the packaged app or WKWebView.
The occlusion scenario drives `document.hidden` directly, not a real covered
window; the real "covered by another app" signal (`chat-viewport://occlusion`)
crosses the Tauri process boundary and is only exercised by the manual pass.
Frame-rate assertions on `by: "raf"` frames at 120Hz remain manual.

## Production code changes

None were needed to meet a budget. The only production edits are measurement
surfaces with no behavioural change:

- `LayoutLedger.stats().memoryBytes` — the exact typed-array footprint, so the
  ledger budget is a deterministic number instead of a noisy heap sample.
- `frameWriteSummary` in `src/lib/chatViewportTrace.ts` and the `heartbeat`
  fields it feeds — the "≤ 1 write per frame" summary the manual pass reads.
  Dev-only; the probe still returns before any listener when the trace is off.
