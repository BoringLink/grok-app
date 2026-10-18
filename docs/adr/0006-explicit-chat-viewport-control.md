# ADR 0006 — The app controls the chat viewport explicitly; engine anchoring is off

- Status: accepted
- Date: 2026-10-18

## Background

While a stream is producing output, the transcript showed "flickers upward, drifts, and loses the bottom follow". The first round of fixes traced the symptom to the follower's criteria, but what really decided the viable approach was the **three-engine capability gap**:

- Scroll anchoring (`overflow-anchor`) support: Chromium (Windows WebView2) since 56, Edge since 79, Firefox since 66; **Safari does not support it at all in 3.1–26.6, and only from 27** (caniuse, pulled 2026-10-18). WebKit only enabled it in stable in February 2026: bug 307734 "[Scroll anchoring] Enable in stable", reported 2026-02-12, RESOLVED FIXED, commit 307475@main (2026-02-13), with the long-standing bug 171099 "Implement scroll anchoring" marked as its duplicate.
- This project ships on all three platforms (`src-tauri/tauri.{macos,windows,linux}.conf.json`, a three-platform release-workflow matrix): macOS is WKWebView, Windows is WebView2 (Chromium), Linux is WebKitGTK. The macOS build's `LSMinimumSystemVersion` is 10.13, so **every macOS user's WKWebView has no engine anchoring today** — and will suddenly have it once macOS upgrades with Safari 27.
- Even on Chromium, where anchoring exists, it and this project's writes are mutually exclusive: the spec says **a scripted scroll-position change invalidates the anchor** (CSS Scroll Anchoring Level 1 editor's draft §2.1.1), and lists a computed-value change to the `padding`/`height`/`margin`/`transform`/`position` of any element on the anchor's path to its scroll container as a **suppression trigger** (§2.2.2). The transcript does exactly these two things continuously (follow writes, spacer and padding updates), so with anchoring on the engine "sometimes compensates, sometimes not" — the phenomenon recorded in `lobe-chat.part1.css` as "browser anchoring fights programmatic scrollTop during stream growth and feels like bounce", and one that cannot be tuned away.

## Decision

**The app controls the transcript's position explicitly; engine anchoring is explicitly turned off.**

- The transcript's scroll container and every nested scroller inside it (the phase steps table, the thinking body, the tool output) keep `overflow-anchor: none`. The spec's §3 notes that a **descendant scroll container of an `overflow-anchor: none` element re-enables anchoring automatically**, unless it also sets the property itself — so this rule has to be applied to every nested scroller, not only the outermost one.
- Rely only on behavior all three engines guarantee: MutationObserver callbacks are microtasks (before the render step), ResizeObserver delivery timing, `scroll` event semantics, spacer layout.
- `content-visibility`, `scrollend` and engine anchoring are not load-bearing capabilities; a future use of them can only be a progressive enhancement, and must not change the invariants above.

## Consequences

- **Deterministic behavior**: one code path and one acceptance across all three engines. When an OS upgrade brings engine anchoring, this project's behavior will not silently change.
- **The cost is that we must compensate ourselves**, and it must happen in the same batch as the layout change, before paint — so the compensation is driven by a microtask inside the mutation batch, not by waiting for a ResizeObserver and then a frame.
- `overflow-anchor: none` turns from "a browser feature switched off in passing" into a **load-bearing configuration**: it is the switch that keeps behavior consistent across all three engines and engine generations, so comments and docs must give this reason, and a later contributor must not delete it as dead style.
- The resident list is no longer allowed to write `scrollTop` (it is a second writer, which repeatedly invalidates the anchor on the engine side and makes the invariant impossible to maintain in one place); it produces layout only.
- If engine anchoring is ever adopted, it needs this ADR and the position model (single writer + anchor invariant) overturned together, and accepting that macOS users have no correct behavior until Safari 27.

## Alternatives

- **Hand it to engine anchoring**: macOS and Linux (WebKit) do not have it today, so it cannot be a foundation; and even when they do, scripted writes invalidating it and the suppression triggers make the compensation timing unpredictable.
- **Branch by platform** (hand Windows to Chromium, compensate in the app for WebKit): three behavior paths, three acceptances, and still the need to decide "when the engine must not step in" — complexity bought for inconsistency.
- **Bottom-origin scroller (`flex-direction: column-reverse`)**: measured, a pin takes only one write and is naturally immune to occlusion, but the reader is pushed continuously during streaming (24px per frame, measured), `scrollTop` has 0/negative semantics in that mode, and Safari writes the rubber-band into `scrollTop`. It does not satisfy C3.
