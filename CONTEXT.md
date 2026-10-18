# CONTEXT

The domain glossary for this repository. Terms only: no implementation details, not a spec, no drafts. Once a term is settled it is written here, and later Specs, issue titles and test names use these words.

## Sessions and turns

- **session** — one complete conversation with the agent, from the first user message to now. Persistable, and reopenable by id.
- **turn** — one user message plus everything the agent produces for it until the agent stops. In a long turn, thinking, tool calls and the body keep streaming for minutes.
- **live turn** — a turn still producing output. Its output keeps arriving, so the transcript's total height grows while the user is reading.
- **transcript** — the scrollable column of one session. The subject of this glossary.
- **collapsing block** — the part of a turn that is "tall while live, short when done": a thinking block, or one phase of a tool step. Its toggle is a large height change above the viewport or inside it.

## Viewport position

- **viewport** — the visible window onto the transcript. What the user sees is its position; `scrollTop` is only its stored form.
- **pinned** — the viewport sits at the content end and stays there as output arrives. Pinned describes **user intent**, not a coordinate.
- **escaped** — the user has deliberately left the content end to read history. Only user intent can enter this state.
- **user intent** — the actions only a person can produce: wheel, touch, keyboard scrolling, scrollbar drag. A `scrollTop` move caused by a layout change is **not** user intent.
- **content end** — the point after the last rendered content row: where the user is while pinned.
- **anchor** — the element whose on-screen position defines "what the user is reading right now". While pinned the anchor is the content end; while escaped it is the element at the viewport top.
- **anchor invariant** — after a batch of height-changing mutations ends, the anchor's on-screen position is unchanged. Everywhere the transcript height changes, this is how correctness is judged.
- **layout clamp** — a `scrollTop` change caused by the engine after a height shrink. It is not a gesture and does not mean the user left.
- **occlusion** — the window is hidden or completely covered and the engine stops painting. Follow cannot be observed while occluded; what is required is that the first frame after visibility returns is correct again.

## Viewport invariants

For Specs, tickets and tests to reference:

- **C1 pinned-exact** — while pinned, the distance to the content end is zero on every drawn frame.
- **C2 visible-content stable** — a drawn frame does not move what the user is looking at, unless that move is the user's own gesture.
- **C3 reading-stable** — while escaped, neither new output arriving nor a height change above the viewport moves the anchor.
- **C4 intent-only** — only user intent can change the pinned/escaped state.
- **C5 restore-correct** — the first drawn frame after occlusion ends satisfies C1; if escaped, it satisfies C3.

## Geometry

- **layout ledger** — the single source of truth for every row's height and its offset in the transcript. Once a row has been rendered at least once, its height comes from measurement.
- **estimate** — the provisional height of a row that has never been rendered. It only gives not-yet-reached places in a long conversation a reasonable size, and is **never allowed** to describe a row the user can see.
- **rich render** — a row rendered with its real content. Every row inside the visible band must be a rich render.
- **shell render** — a row drawn at its remembered height with no content. Allowed only outside the visible band.
- **viewport band** — the rows the user can see, plus the margin kept rich so that "a scroll or a fold does not expose a shell row".
- **long conversation** — a conversation large enough that the transcript's shape must be carried by the ledger instead of the DOM: the design scale is 10k rows / 600k px; the largest observed so far is 59,578 px for a single conversation.

## Engine

- **engine scroll anchoring** — the engine's own compensation for "a height change above the viewport". Chromium compensates; WebKit (macOS, Linux) did not for a long time, until it was enabled in stable in February 2026 (Safari 27). This project turns it off on the transcript on purpose, so the engine and the app's positioning writes do not cancel each other out.
- **explicit viewport control** — every `scrollTop` write on the transcript is this project's responsibility, relying only on behavior all three engines guarantee (MutationObserver microtask timing, ResizeObserver delivery timing, scroll event semantics, spacer layout). This is the approach this project chose.

## Easy to confuse

- **live turn** is not the same as **output still arriving**: the former is the whole turn running, the latter is the text still landing within it.
- **pinned** is not the same as **at the bottom**: the former is intent that survives height changes, the latter is a coordinate a clamp can change.
- **escaped** is not the same as **not pinned**: not pinned is any state without follow; escaped specifically means the user chose history.
