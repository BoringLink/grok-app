# Chat viewport trace — live session follow

Diagnostic logging for "chat content drifts / flickers upward and loses the stream
tail" (worst when a thinking/tool block auto-collapses). Frontend → host → disk,
so it is readable from a packaged `.app` without devtools.

The trace is the delivery's diagnostic seam (ADR-0006, the chat-viewport Spec):
one real session has to yield, from the log alone, the quantities the C1–C4
invariants are defined on.

## Enable (on the Dev App instance being debugged)

Pick the flag before/at launch; all are runtime read, no rebuild needed per switch:

- Trace on: `localStorage["grok.chatTrace"]="1"` (or launch with `?chatTrace=1`).
  Without this the probe never mounts and nothing is written.
- Tracking-session id (what you filter by): `localStorage["grok.chatTraceSession"]="<id>"`
  (or `?chatTraceSession=<id>`). When set, every line the Host appends is prefixed
  `[session=<id>]` and a `tracking-live` follower publishes per-frame-ish geometry.

Set both from the Dev App's webview devtools console, then reload.

## Sampling convention (paint boundary, and the fallback)

The sampler runs in a `requestAnimationFrame` callback
(`useChatViewportTraceProbe`). The rAF callback runs after the browser has
applied this frame's layout and immediately before it paints, so a sample
describes what the user is about to see — the "paint boundary" the Spec's
acceptance criteria judge C1–C4 on. Sampling from mutation or scroll callbacks
instead reported a false 980px jump, because those fire mid-layout before the
change has settled.

The rAF loop is throttled or paused in a backgrounded window, so a 1 s timer
fallback samples the same quantities — but those are **not** drawn frames. Every
recorded sample is stamped with `by`: `"raf"` is a paint-boundary sample,
`"fallback"` is a timer sample. Read C1–C4 on `by: "raf"` frames; treat
`"fallback"` frames as liveness evidence, not draw evidence.

A `sample` is only recorded when something changed (index, pin, or a geometry
move past the 4px noise floor), so an idle viewport does not fill the ring. While
escaped, an anchor shift past 0.5px also counts as a change: the C3 bound is
below that noise floor, so the anchor drift would otherwise never reach the ring.

### C3 read-out (escaped reader)

While escaped the element at the viewport top is the anchor (`CONTEXT.md`), and
the controller holds it through its anchor ref (element + recorded screen top).
The per-frame `a` field is that element's own screen-top shift from the recorded
position — the exact quantity the escaped restore corrects — so the C3 bound
(≤ 0.5px across a height-changing batch) reads directly off `a` on the escaped
`by: "raf"` frames of a real stream: a fold, a re-growth, continuous output, or
a media element finishing decode. It follows the captured *element*, so a change
that moves that element moves `a` even when its row box does not, and an
out-of-band re-growth (rows entering above) does not make it `null`. The one
exception is the nested-scroller rule (`session-continuity.md`): the anchor is
never planted inside a nested scroller, so such a box reads `a = 0` by design.
`a` is `null` while pinned (the anchor is then the content end, judged by `d`)
and when the held element is gone. The media-decode case carries no DOM mutation
with the new size, so it appears as a `sample` whose `dh`/`dm` show a content
height change with `dm: 0`.

### Sample key legend

The per-frame metric fields use compact keys so a dump window fits as many
frames as the Host line budget allows (see `dumpChatViewportTrace`). One
`sample` event:

| key | meaning |
|-----|---------|
| `i` / `pi` | first visible row index now / previous frame |
| `st` / `sh` / `ch` | `scrollTop` / `scrollHeight` / `clientHeight` |
| `d` | **distance to the content end** (px); 0 at the hard bottom (C1) |
| `v` | **visible-band shift** (px): mean on-screen displacement of rows present in both frames, matched by `data-virt-index` (C2). `null` = no row persisted |
| `a` | **escaped-anchor shift** (px): screen-top shift of the controller's captured anchor element from the position it recorded, measured against the same ref the escaped restore uses (C3). Only sampled while escaped; `null` while pinned or when the held element is gone |
| `dt` / `dh` | per-frame `scrollTop` / content-height delta |
| `dm` | DOM mutations since the previous frame (reflow vs external scroll) |
| `p` / `e` | `pinned` / `escaped` — the C3/C4 follow state |
| `w` / `ws` | `scrollTop` writes this frame and the last write's source |
| `g` | a user gesture is recent (within 400 ms) |
| `by` | `"raf"` (paint boundary) or `"fallback"` (timer) |
| `fc` | pin-flip cause — present only when this sample saw `pinned` change |

The trigger events (`backward`, `upward-jump`, `upward-jump-native`) keep
readable keys, since they are rare.

Samples reach the log through a dump: either the trigger dumps below, or the
10 s heartbeat dump, which carries the recent samples even when no trigger
fired. So one real session leaves the per-frame sequence on disk without any
manual flush.

The latest distance / shift / `pinned` / `escaped` / write source and the write
count also ride the heartbeat event (inside that dump) and the `tracking-live`
payload as a live tail.

## Pin / escape flip causes

Every pin/escape flip records a normalized `cause` (`tracePinState`):

- `wheel` / `touch` / `keyboard` / `scrollbar` — a user gesture ended or
  re-engaged follow;
- `layout-clamp` — no gesture explains the move; a height change moved
  `scrollTop`. This is the cause that must never be read as the user leaving;
- `hard-bottom` — the flip landed on the content end and re-engaged follow;
- `button` — the explicit "back to bottom" control;
- `jump` — a rail / find / deep-link jump landed (the reason carries a `jump:`
  prefix). It is the reader choosing a position, so it is never a layout clamp.

`classifyPinFlipCause` derives the cause from the flip's reason prefix, the
caller's gesture hint, and the distance from the content end. The `scroll-escape`
and `scroll-state-transition` sites pass the gesture tracked by the stick hook;
a gesture-free repeated upward move at a stable height is classified
`scrollbar` (a drag), everything else gesture-free is `layout-clamp`.

The button flip is recorded by `scrollToBottom(behavior, reason)` in the stick
hook: it sets the pin state directly, so without that call the `button` cause
would never appear in the log.

## Where the log lands

The Host writes under `app_data_root()/logs/` (`src-tauri/src/logging.rs`,
`src-tauri/src/paths.rs`). `app_data_root()` is `$GROK_APP_HOME` when set,
otherwise `directories::ProjectDirs::from("com", "grokapp", "grok-app")`
(`directories` v6):

- macOS: `~/Library/Application Support/com.grokapp.grok-app/logs/app.log.<YYYY-MM-DD>`
- Windows: `%APPDATA%\grokapp\grok-app\data\logs\app.log.<YYYY-MM-DD>`
- Linux: `$XDG_DATA_HOME/grok-app/logs/app.log.<YYYY-MM-DD>`, or
  `~/.local/share/grok-app/logs/…` when `XDG_DATA_HOME` is unset
- Any platform, when `GROK_APP_HOME` is set: `$GROK_APP_HOME/logs/app.log.<YYYY-MM-DD>`

Written by host command `chat_viewport_trace` via `sync_diag` — synchronous
`OpenOptions` append, so it survives a wedged non-blocking sink.

## Follow from another session

```bash
tail -F "$HOME/Library/Application Support/com.grokapp.grok-app/logs/app.log.$(date +%F)" \
  | grep --line-buffered '\[session=TRACKER_ID\]'
```

(Adjust the path per platform from "Where the log lands".)

Key event `reason`s:

- `tracking-begin` (probeVersion 4): mount marker with `session`, `chatSession`
  (the app's conversation id), rows/geometry, clientHeight, pinned.
- `tracking-live`: compact geometry each `LIVE_FOLLOW_MS` (250 ms) while moving —
  `scrollTop`, `scrollHeight`, `clientHeight`, `distFromBottom`, `index`, `dTop`,
  `dHeight`, `peakTopMove`, `pinned`, `escaped`. This is the frame-level
  drift/flicker feed.
- `landed-bottom` / `button-scroll-to-bottom`: scroll-to-bottom events. `landed-bottom`
  fires on every natural re-engage of follow (wheel/touch/scroll landing on the tail,
  bottom rebound, height-change re-pin) with `cause` = the stick reason. The button
  click logs a separate `button-scroll-to-bottom` with `distFromBottom` before the
  jump. Watch these two to tell "the user pinned" from "the code snapped".
- `heartbeat`: every 10 s. Publishes a dump (anchored on the heartbeat event)
  of the recent per-frame samples, so a session with no backward move still
  leaves its per-frame distance / shift / follow state / write source in the
  log. Also proves liveness when the capture found nothing. Carries
  `frames` / `maxWritesPerFrame` / `framesOverBudget` — the per-frame
  position-write budget summary (`frameWriteSummary`) the manual pass reads to
  confirm "≤ 1 write per frame"; `framesOverBudget` must be 0.
- `viewport-moved-to-older-message` / `viewport-jumped-up` / `viewport-native-jumped-up`:
  the suspicious backward moves you are hunting, published as cause-chain dumps.
- `occlusion`: paint availability changed. `state: "enter"` when the window
  stopped being drawable, `state: "exit"` when it is available again, with
  `cause` (`"hidden"` = Page Visibility, `"covered"` = the macOS host reported
  the window completely behind another app, `"collapsed"` = the scroller has no
  usable height) and the pin state. The exit frame is the one C5 is judged on,
  and it is also published directly as `occlusion-restored` under a tracking
  session, so the restore is visible in the log without waiting for a heartbeat.
  `"covered"` is the only one that never maps to a `visibilitychange`; it comes
  from the host event `chat-viewport://occlusion`.
- `viewport-size`: the scroller's own client box changed (window / stage-chrome
  resize), with `pinned` / `escaped`. While escaped the anchor is held
  synchronously in this callback, before paint.
- `refresh-rate`: the nominal refresh rate changed between heartbeats (e.g.
  120 Hz ↔ 60 Hz, or a cross-display move), with `fromHz` / `toHz`,
  `frameIntervalMs` and `fps`. The heartbeat's `frameIntervalMs` / `fps` are the
  current estimate; both come from the delivery's measured frame cadence
  (`frameCadence.ts`), not a fixed 60 Hz assumption.
- `manual`: flush after an episode ends, e.g. `window.__CHAT_VIEWPORT_DUMP__()`.

## Dump window

A dump is anchored on its **trigger** — the event that caused it (the backward
move, the upward jump) — not on the newest event. `dumpChatViewportTrace` keeps
the trigger plus the events immediately before it, up to `DUMP_CONTEXT_EVENTS`
(the whole 400-event ring) and trimmed to fit the `DUMP_MAX_CHARS` (8000)
budget, just under the Host's `MAX_TRACE_LINE_CHARS = 8192`. The trigger is
always included, even when it alone exceeds the budget. `truncated: true` in the
payload means earlier context was dropped to stay inside the budget.

This replaces keeping the newest events wholesale: the host truncates an
over-long line keeping its head, which dropped the trigger at the tail. The dump
stays under that cap, so the trigger survives even a flood of later events; the
compact sample keys above are what let the window reach back over the frames
that led into the trigger.

The published payload is `{ reason, dumps, session, trigger, truncated, events }`;
`events` ends at the trigger.

## Cost

No-op outside DEV builds when `grok.chatTrace` is unset (one cached boolean check,
no rAF loop, no listeners, no timer, no log write). The rAF sampler / RO /
heartbeats only exist while enabled. `tracking-live` only runs when a
tracking-session id is set. The probe is dev-only diagnostics: a production
session pays nothing for it.
