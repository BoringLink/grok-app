# Session continuity & context compact

## Session ID convention (for agents / debug paste)

When the user pastes a **session id** (UUID) into chat or issues for debugging:

| Default | Meaning |
|---------|---------|
| **Grok App session id** | UI journal under `{app_data}/sessions/<id>/` (`messages.json`, title, model prefs). This is what **复制会话 ID** / sidebar copy produce. |
| Agent session id | CLI id under `{GROK_HOME}/sessions/<encoded-cwd>/<agentSessionId>/` (`chat_history.jsonl`, `events.jsonl`). Linked as `agentSessionId` in `sessions_index.json`. |

**Lookup order for pasted UUIDs (unless the user explicitly says “agent session” / CLI id):**

1. `{app_data}/sessions/<uuid>/` + `sessions_index.json` entry  
2. If missing, optionally resolve as `agentSessionId` via `sessions_index` or scan `agent-home/sessions/**/<uuid>/`

App data root (macOS typical): `~/Library/Application Support/com.grokapp.grok-app/`.

External apps on this machine that need to **list chats and continue one by id** use the local session API — see [session-api.md](./session-api.md). That surface takes a **Grok App session id**, not an agent session id.

**Archive vs delete (shared `GROK_HOME`):**

| Action | App sidebar | CLI `{GROK_HOME}/sessions/.../<agentSessionId>/` | Bulk import |
|--------|-------------|--------------------------------------------------|-------------|
| Archive | Hidden (`archived: true`); `agentSessionId` stays linked | Unchanged (terminal `grok sessions list` still shows it). Confirm copy says App-only. | Skipped (`already_linked`) |
| Delete | Journal + index row removed | Removed after ACP stop; tombstone if the tree is locked | Skipped (tombstone + missing dir) |

New chats in a project inherit that project's multi-root workspace so extra-root write is not bound only to the session that opened the modal (#1233).

## Problem

Grok App keeps a **UI journal** (`~/.…/sessions/<appSessionId>/messages.json`) separate from the **Agent session** under `GROK_HOME` (`agent-home/sessions/<encoded-cwd>/<agentSessionId>/`).

If the Host always called `session/new` on reconnect, the model only saw the latest user turn while the UI still showed full history — context looked “broken”.

## Strategy (Host)

### 1. Prefer native resume — `session/load`

On `session_connect` for an existing App session:

1. Spawn `grok agent stdio` with the same `GROK_HOME` / cwd.
2. `initialize` + `authenticate`.
3. If meta has `agentSessionId`, try **`session/load`** with that id + cwd.
4. `session/load` success means the Agent accepted the id and replayed available history; it does **not** prove that history covers the App journal.
5. On failure → **`session/new`**. On either result, persist a continuity checkpoint and verify coverage before the next Host prompt.

**Replay gate (Host):** `session/load` replays history as ACP notifications
(`agent_message_chunk`, `tool_call`, plan entries, …). While **no**
`session/prompt` is in flight (`prompt_in_flight == false`), the Host **drops**
stream / tool / journal side effects:

- no re-typing into the UI stream  
- no `session://tool` storms  
- **no journal rewrites** (`messages.json` stays the UI source of truth)

**A live workflow result is not load replay.** When a background workflow finishes, Grok Build starts its own turn on the same ACP connection (`promptId` prefix `workflow-completed-`). There is no Host `session/prompt` for that turn. If this chat's own `session/load` is not still pending, the Host adopts it: a prompt is in flight, a quiet `auto_wake` line is journaled, the chunks apply, and `turn_completed` finishes the turn. Prompt ids seen during that session's load stay dropped. A load of another chat does not drop them. Switching away keeps the visit bit, and a parked chat is brought back only for the workflow start (or an end that is already open). Stream and tool chunks from a workflow turn that is not the armed one are dropped.

**Human gates are not load-replay.** Grok Build may re-issue
`_x.ai/exit_plan_mode` after resume (`RestorePlanApproval` /
`awaiting_plan_approval`) with **no** prompt in flight. Host accepts Plan
events when `rpc_id` is set, or a plan gate is already pending, or a prompt is
in flight; only idle plan *notifications* without an open gate are dropped.
`ask_user_question` reverse-RPCs are never dropped as replay. Background
(demoted) turns handle Plan / AskUser the same way as live (emit + store
pending ids). Process exit / recycle clears pending gates and emits
`session://permissions_invalidated` (incl. `planRpcId`) so the UI drops ghost
Approve buttons.

**Plan chrome persistence (P1):** App session dir stores `plan_chrome.json`
(body, entries, closed flags, gate_stale). Host upserts on every live plan
event; UI also saves on dismiss/approve. On session open the UI loads chrome +
`session_agent_plan_snapshot` (agent `plan_mode.json` + `plan.md`). Restored
state never carries a live `rpcId` — Approve waits for Build re-park. Sticky
bar uses `planBar.resume` while `gateStale` / `awaitingAgentApproval`.

**Post-turn disk recovery after rewind:** reconcile matches CLI user prompts to
surviving journal prompts in order, after stripping sole-line attachment paths.
A matching prompt count alone does not authorize a row: a replacement prompt
can occupy the removed turn's ordinal. Assistant coverage, extension, and insert
positions are scoped to the matched turn; unmatched branches contribute neither
answers nor tool rows. A steer also splits its turn: assistant coverage and
extension then start after the steer marker, so a pre-steer fragment is never
extended by the post-steer body. Mid-turn **interjections** (journal rows with
`marker: interjection`) are logged by the CLI as ordinary user turns but are not
prompts: a matching interjection row keeps the surrounding prompt active (and
the insert anchor at the interjection), so the post-steer answer is still
recovered and the interjection never consumes a prompt slot. The interjection
match is the exact normalized steer body (sole-line attachment paths stripped);
a real prompt that merely starts with the steer text (`yes` → `yes, and
revert`) stays a prompt. Each marker is claimed by at most one history user row,
so two identical steers in one turn keep their own rows and stream order. When
the Host opened the post-steer assistant row but only its `thought` reached the
journal, the recovered body fills that row in place (id and thought preserved)
instead of adding a second bubble; rows before the interjection never absorb it.
Builds that omit the steer's user row from the history leave no matched marker,
so the turn's own journal interjection bounds coverage the same way. The merge
body therefore lands in the earliest post-steer placeholder even when a
pre-steer placeholder is still unfilled; without one it is inserted inside the
turn, never attached to another prompt. A body equal to the pre-steer row means
the steer logged no text of its own: that row keeps the body and the placeholder
stays empty instead of repeating the answer. The
journal read-modify-write holds the same file lock as
rewind replacement and stream appends, so a delayed recovery snapshot cannot
reintroduce rows removed by a concurrent rewind.
Before native rewind, Host captures digests of the abandoned prompts and
assistant/tool rows. It persists that fence under the journal lock before
truncation. Disk recovery never imports those rows again; repeated identical
prompts conservatively use live output only because legacy logs have no stable
branch identity. Unreadable/incomplete history or a corrupt fence disables disk
recovery for that session, while live replies remain intact. Exclusions survive
restart and are bounded; they never edit CLI history.

**Continuity checkpoint and send gate:** Every successful connect marks the linked Agent history unverified until the next send gate checks it. Only a confirmed `session/new` result may mark an Agent as fresh for in-place bootstrap; a resumed Agent with a missing, corrupt, or mismatched checkpoint stays unverified and must recover through a new Agent session. The per-App-session `continuity_checkpoint.json` stores a schema version, Agent id, provider route, cwd, session-data mode, custom-route home selection, status/reason, bounded covered App message ids and prompt count, journal-to-Agent prompt digest mappings, a pending prompt id with journal/final-Agent prompt digests, bootstrap bundle and prompt ids, included message ids/digests, and omitted count/range. It stores no transcript text. The read-only inspector checks user prompts, assistant rows, and tool results in order against `messages.json` and the linked Agent `chat_history.jsonl`; `session/load` success alone never passes. Prompt coverage matches normalized text plus attachment-path evidence; when the Host transforms prompt text (for example, vision preprocessing), a journal-bound digest of the final Agent prompt is required. Attachment-only prompts require an exact path match; missing or unresolvable path evidence fails closed. For local sessions it reads the existing `GROK_HOME` selected by the active route (shared `~/.grok` for shared official sessions; App `agent-home` for independent or custom-route sessions) without creating or repairing App data directories. SSH sessions never treat remote `session/load` success as proof: an unverified remote session is replaced with a fresh remote Agent and any safely prepared App-journal bundle before dispatch. A successful turn keeps the remote context verified only in memory; the persisted checkpoint stays pending so a Host reconnect recovers from the App journal again. If that journal cannot be prepared safely, the prompt remains undispatched. An unreadable or corrupt App journal, or a journal that cannot be safely bootstrapped, fails closed without quarantine or prompt dispatch. An unverified or mismatched Agent bootstrap bundle is treated as ambiguous history and recovered by preparing a fresh bundle for a new Agent session; if that bundle cannot be prepared safely, the current prompt remains undispatched.

After a fresh `session/new`, the first Host send uses that empty Agent session for bootstrap instead of opening a second one. If history is incomplete, Host creates a fresh Agent session only after it has safely prepared the App journal bundle. A successful prompt RPC does not verify the checkpoint; the bounded post-turn history check must find the pending prompt and expected assistant/tool rows. Interrupted turns continue through the existing `turn_lease` / explicit Continue flow; bootstrap text instructs the Agent not to repeat prior operations unless the new user message explicitly requests continuation.

**User-visible state:** `SessionSnapshot.continuity` carries the status (`verified`, `bootstrap_pending`, `unverified`), a safe reason code, bounded covered counts, and the bootstrap included/omitted counts. It never carries prompt text. The chat stage derives a banner from that snapshot and the transcript length: a pending or unverified banner explains that the next message verifies and, if needed, restores the conversation from this chat; a verified bootstrap shows how many entries were included and how many were omitted by length limits. The banner is suppressed while a turn is already connecting or streaming, and stays hidden for empty chats. The message the user sends is only kept in the transcript after the Host accepts the turn; a failed recovery removes the optimistic row, keeps the composer draft, and surfaces the normal in-app error with a reconnect action.

Live turns (`prompt_in_flight == true`) still apply stream + tools normally.
See crash investigation notes: ungated tool_call replay on open could thrash
Host/UI/disk and correlate with dual-process SIGABRT.

**Shared-process multi-session (P0):** warm reuse keeps co-tenant shells on one
CLI process. **Never** warm-reuse a process that still has a mid-turn live or
background session — the other chat cold-spawns. Idle parked / idle background
reuse is unchanged. Host must **never** write load-replay / unstamped process
traffic into a **parked** co-tenant journal:

1. Bind live `process_id` (+ known `agentSessionId`) **before** `session/load`.  
2. Route by stamped agent session id; parked match → **drop** (no rescue).  
3. Unstamped turn events: unique mid-turn background → else live → else drop.  
   Never `rescue_parked` with fake `prompt_in_flight=true` (that caused
   cross-chat journal pollution + sticky “in progress”).

**Composer send target (P0, sticky cross-chat):** `openSession` also binds
shell `session.sessionId` immediately (not only after journal load). Send uses
`resolveComposerSendSessionId(viewing, shell)` and **prefers viewing** when they
disagree — otherwise text typed in chat B while A was still the shell id was
journaled into A (common when A was stuck “thinking”). Host `live_session_is_busy`
must not treat pure sticky Streaming (no `prompt_in_flight` / tools / deferred
gates) as forever-busy, or demote/focus for other chats stays blocked.

**Turn end journal heal (P0):** the event pump ends the turn with the queued
`session/prompt` result; if the waiter still observes an open turn (terminal
event dropped or misrouted), it force-finishes sticky Streaming (#522). The same
waiter then runs `try_reconcile_linked_session` over a short bounded retry
window to pull missing assistant/tool rows from agent `chat_history`. Filesystem
reads run off the async executor; every idempotent pass is aggregated before one
`session://journal_reconciled` event. This covers both dropped stream chunks and
a CLI history flush that becomes visible just after the prompt RPC returns
(user saw endless thinking while CLI already had the full answer). A per-session
journal lock prevents read-modify-write loss against an immediate next send; if
that newer turn is already running, the previous turn's remaining retries stop.

**UI transcript ownership (P0, #529):** `openSession` points `viewingSessionId`
at the target **before** disk journal load. Until messages swap, stream /
rehydrate / clear-streaming must **not** reduce against the previous chat's
array under the new id. Rules:

1. `sessionTranscriptStore` tracks `messagesOwnerSessionId` separately from
   viewing id; reducers use that session's own cache (or `[]`), never a foreign
   painted transcript.  
2. On switch, immediately `setMessages(cache[target] ?? [])` so owner matches
   viewing before any host event lands.  
3. Journal rehydrate upgrades only `messagesBySession[sid]`, never React prev
   from another project.

**CLI import sanitization (#687):** Import still copies `chat_history.jsonl`
into App `messages.json` (not a live official-session mirror). Reminder-only
`<system-reminder>` rows and `synthetic_reason: project_instructions` envelopes
are dropped so they do not become gray user bubbles. A wrapped `<user_query>`
is kept. Official TUI remains `updates.jsonl`; App UI remains the local journal.

**Fast switch (Windows freeze / open storm):** rapid sidebar clicks must not
stack full open pipelines.

1. **Generation token** — every `openSession` / `newChat` bumps `openSessionGen`;
   after each `await`, abort UI writes when gen or viewing id no longer match.  
2. **Journal load without reconcile** — switch calls `session_messages` with
   `reconcile: false` (App `messages.json` only). Agent `chat_history` merge is
   **deferred** (~500ms) only if the user is still on that chat.
   End-of-turn UI rehydrate (`session://stream` done / `session://state` ready /
   `session://journal_reconciled`) also passes `reconcile: false` — Host
   `post_turn_reconcile` already merged agent history. Re-parsing jsonl on that
   IPC path deadlocked the Windows WndProc (#754).  
3. **Warm connect debounce** (~350ms) — only the settled viewing session may
   call `sessionConnect`; pending timers clear on the next navigation.  
4. Host: `session_messages` / `paths_classify` run disk work on `spawn_blocking`
   so concurrent opens do not block the async runtime.

**Ghost streaming heal (optimistic send never reached Host):**

Send paints user bubble + empty streaming assistant immediately, then awaits
`ensureConnected` / `sessionSend`. If Host never enters a turn for that chat
(`liveMap[sid]` never becomes streaming), Host stream-stall does **not** run
(it only watches true Host Streaming). Client policy in
`src/lib/ghostStreamingHeal.ts` + `useGhostStreamingHeal`:

1. Empty trailing streaming assistant, no tools/body.  
2. Grace **30s** after `turnStartedAt`.  
3. `liveMap` for the viewed session is idle/missing (do **not** trust optimistic
   `liveHost.state`).  
4. Heal: strip optimistic user+assistant, unlock busy, bump `sendEpoch` so a
   hung `sessionSend` cannot re-dirty UI, restore text to composer, toast
   `agent.ghostStreamingHealed`.  

Real mid-turn silence still uses Host `STREAM_STALL` (soft banner; user End turn).

### 2. Fallback — journal bootstrap (reasonable turns)

When Agent history cannot be verified (missing, empty, partial, mismatched, oversized, or corrupt) and the App journal is readable, the Host recovers from a bounded bootstrap:

- The fresh or just-created empty Agent session receives the bootstrap on the first Host send only; later sends use its verified history.
- The bundle contains up to **16** user/assistant messages, at most **2k chars** per message, and about **14k chars** total. Tool steps and turn markers stay out of the text body; the prompt marks omitted transcript entries.
- The checkpoint records a SHA-256 bundle id, included App message ids/digests, and omitted count/range. It never stores the transcript text.
- App journal storage writes only the user-facing turn; bootstrap text never becomes a UI bubble.
- If the App journal or an attached journal cannot be read safely, keep the prompt undispatched and return an actionable recovery error; do not quarantine or rewrite the damaged journal.

This covers load failure, wiped Agent history, route changes, and flushes that did not persist. The checkpoint remains pending until post-turn history proves the pending prompt and expected assistant/tool rows.

### 3. Soft-respawn

Permission / mode soft-respawn **keeps** `agentSessionId` so the next connect prefers `session/load`. Every connect starts unverified; the next Host send checks persisted coverage. Bootstrap runs after load failure or whenever history is missing, partial, or mismatched, even if `session/load` succeeded. A fresh empty Agent session is reused for its first bootstrap send.

Changing **one chat's provider** (official ↔ custom, or another custom section) clears that chat's `agentSessionId` before the soft-respawn, so `session/load` cannot restore the previous route. Other chats are not recycled. SSH cold start is always the official route.

Changing a chat's **selected model or reasoning effort** also requires a fresh process because the CLI receives the effort at spawn time and `session/load` preserves the old process settings. Busy turns keep their in-memory `agentSessionId` until the turn-end flush so streamed events remain routable; idle live, background, or parked agents clear the id only when their process is being dropped. The next connect uses the new model/effort and bootstraps from the App journal when required. A deleted provider follows the official route. An explicitly cleared catalog keeps a chat's saved session model identity; without one it falls back to the official route.

### 3a. Move chat to another project

Sidebar **Move to project** (context menu, multi-select, drag onto a folder, or the composer project chip on an existing chat) rebinds `projectId`. The App journal stays under `{app_data}/sessions/<id>/` — nothing is copied into the folder.

Because cwd changes:

1. UI always confirms. Relative attachments, skill outputs, and FilePathCards resolve against the **new** root and can 404 or open a homonym.
2. Host refuses mid-turn (live or background busy).
3. Host drops live + background + parked ACP for that chat, then clears `agentSessionId` / worktree meta. Next connect is `session/new` + journal bootstrap — never `session/load` the old encoded-cwd session into the new folder.
4. Untrusted or missing target folders are refused.
5. Fork / resume-restore still use silent `session_set_project` so they can keep a pending `--fork-session` source id.
6. Remote IM bindings that already point at this App session retarget cwd and drop their agent id.
7. Drag a sidebar chat onto a project header (or Default workspace) uses the same confirm + Host path as the menu.

### 3c. Agent-side fork (partial)

Transcript **Fork from here** sits on completed idle **assistant** bubbles (not user prompts). The new App session copies the journal through the **containing user turn** (`through_user_prompt_index`: that user prompt + the turn’s assistant / thought / tools) and drops later follow-ups. The source chat is unchanged.

When the source has a linked agent id, the child connect ACP-`session/fork`s, then immediately **rewinds the child** (`x.ai/rewind/execute`, `restoreFiles=false`) so agent memory matches the truncated journal. The parent agent is not rewound or stopped. If fork or rewind is unavailable, Host opens `session/new` and bootstraps from the copied journal — it never keeps an untrimmed forked agent id. Host emits `session://fork_trimmed` `{ sessionId, outcome: "rewound" | "bootstrap" }` for partial forks only.

The partial-fork dialog hides the CLI `--fork-session` checkbox and auto-arms agent fork when a source id exists. Sidebar **Fork chat** (uncut) is unchanged, including that checkbox.

### 3b. Session data mode switch (E04)

When Settings flips `session_data_mode` independent↔shared, Host calls `recycle_all_agents` on live + background + parked processes (same kill/soft-disconnect paths as idle recycle). Live `agentSessionId` is cleared so reconnect does not `session/load` against the previous `GROK_HOME`. Journals stay. Emits `session://agents_recycled` for a short toast.

### 4. Process limits & idle recycle (I01–I03)

| Setting | Default | Behavior |
|---------|---------|----------|
| `maxConcurrentAgents` | **8** (cap **32**) | Cap on live + background-busy + parked processes. Switching Ready chats **parks** the prior process. Busy turns demote to **background** and keep streaming. Before spawn, **idle parked** are reclaimed until a slot frees; `PROCESS_LIMIT` only when slots are full of **busy** work. **Never** kill a busy background turn for focus. |
| `agentIdleMinutes` | **30** | Background watchdog soft-kills idle Ready agents (live + parked). **Session meta + journal stay**; next send reconnects (`session/load` or bootstrap). Emits `session://idle_recycled`. |

**Pool accounting rules (why "limit reached" must be rare and true):**

- The stored value wins over the default. Installs from the 3/8 era persisted
  `maxConcurrentAgents: 3`, so raising the default alone changed nothing for
  them — `migrate_max_concurrent` lifts a stored *legacy default* once and marks
  `poolSizeMigrated`, leaving any deliberate value alone.
- `background` is only reclaimable **via** `parked`. Finished background turns
  are swept to `parked` before every capacity decision and by the idle
  watchdog; otherwise a turn that ended off the normal path pinned a slot that
  nothing could free.
- `session://idle_recycled` with `reason: "capacity"` is the **success** path
  (a slot was freed, the spawn proceeded). Only `session://process_limit` means
  the pool is genuinely full of busy work — after parked reclaim, so the
  "all slots are busy turns" wording is accurate.

**No session monopoly:** each App session owns its ACP process. Focus switch never rebinds another chat’s process (`session/new` on a stolen child). A **mid-turn background** process is not a warm-reuse candidate — opening another chat cold-spawns instead of `session/load` on the busy stdio (that wrote foreign load-replay into the streaming journal). UI listens to `session://stream` / `session://runtime` by `sessionId` so background turns keep updating after you leave the chat.

**Busy demote rules (must not park):** FSM `Streaming` / `AwaitingPermission` / `Connecting`, or non-empty `open_tool_ids`, or deferred `prompt_complete`, or pending plan/ask_user. Long tools (e.g. `find`) stay background-busy until terminal tool status. Capacity reclaim **only** kills idle `parked` Ready shells. `soft_respawn` is a no-op mid-turn. UI **skips warm `sessionConnect` on open** when another session is busy — first send still demotes+spawns.

**Connecting is not a healthy live process.** `session_connect` has a 90s wall clock; leftover `Connecting` must not no-op reconnect (`connect_should_preserve_live_process` is false). `ProcessExited` during handshake fails the FSM. `session_stop` on Connecting cancels the handshake (kill ACP). Post-open `session/set_mode` runs **after** `handshake_ok` so a slow nudge cannot pin the pill. The status pill is **viewed-session** only; Reconnect stays clickable.

**New chat / disconnect:** `newChat` must **not** call `sessionDisconnect` (that killed the live ACP and aborted turns when users hit 新建会话 right after send). Host `disconnect` demotes busy → background and parks Ready instead of killing. In-flight `executeSend` still runs `sessionSend` after `ensureConnected` even if the user already switched the draft UI.

**Send queue (per session):** Follow-up enqueue only when *this* chat’s FSM is busy (`streaming`). The process-global UI `connecting` flag (any `ensureConnected`) must **not** gate enqueue — that re-parked SuperGrok new-chat sends into “本会话队列” while another connect was in flight. Host mid-turn on another chat must **not** enqueue a composer send either — that send demotes the foreign turn and spawns concurrent work. Each session keeps its own queue. Auto-flush runs for every session that is `ready` / `idle` with a composer item at the head, including chats that are not on screen. Flush claims that session’s own key (never the live host id). A background flush calls `session_send` for that id and does **not** `ensureConnected` (connect would adopt the workbench view). External (`session://send_queue`) items stay Host-drained. Hold flush only when *that* session is the busy live one. One session’s send failure holds only that key. Deleted sessions and a `disconnected` row drop their queue.

### 4b. Session-scoped Host commands (no live-slot guessing)

`self.inner` (the live focus slot) is **not** an implicit command target. Every
turn-affecting command carries the chat it belongs to:

| Command | Target rule |
|---------|-------------|
| `session_send` | `sessionId` required in multi-session flows. Host makes that chat **promptable** under `connect_lock` (`ensure_promptable_session`): already-`background` keeps the process in place; `parked` while another chat is mid-turn unparks into **background** so the streaming focus is not stolen; otherwise promotes via demote+focus. No warm process → `CONNECT_FAILED` (UI cold-connects and retries the turn **once**). |
| `session_stop` | `sessionId` = the chat on screen; resolves via live **or** background. UI: composer Stop = **current** session only; Tasks/dashboard Stop all = **all busy**. |
| `session_rewind_drop_last_user` | `sessionId` must match the live slot, else error — truncating the wrong journal is unrecoverable. |
| `session_resolve_permission` / `_plan` / `_ask_user` | `sessionId` from the event payload. The pending rpc id belongs to the requesting chat's own ACP child. |

**Multi-window live slots:** secondary webviews share the process Host. Connecting
or sending on session B while A is streaming demotes A to `background` (stream
continues) or parks Ready A warm — never a silent kill. Secondary may passive
warm-connect; main still defers warm-connect while browsing a foreign mid-turn.
Pure policy: `src/lib/multiWindow.ts` (`planConnectToSession`,
`resolveStopTargets`, `concurrentConnectPreservesOther`).

**Why:** a warm `sessionConnect` (session open prefetch), a sidebar switch, or an
automation firing between the caller's `ensureConnected` and its `sessionSend`
moved the live slot. The send then landed on a *foreign* chat — cross-session
replies, and “has `agentSessionId`, empty journal” zombie sessions for the chat
that was supposed to receive it. Host now fails loudly instead of misrouting.
UI also defers warm-connect while a send/connect is in flight.

### 4c. Turn lifetime = `prompt_in_flight`, not the FSM

The agent fires `_x.ai/session/prompt_complete` **early** — while tools are open,
or with many seconds of answer text still to come. Treating that as the end of
the turn is how answers got truncated mid-sentence while the chat kept spinning.

### Host process death (false-complete heal)

When the **App host** dies mid-turn (Windows cold start, no shutdown log), the stdio agent dies with it. `session/load` cannot resume at the permission / tool boundary (`docs/SPIKE-ACP.md` in-flight continuity gap).

Host persists `{app_data}/sessions/<id>/turn_lease.json` while `prompt_in_flight` is true. On **process start** (dirty active leases) and after a successful **session connect** (not during journal reconcile, which can run mid-turn):

1. If the lease is `active`, **or** the agent trail shows unresolved `permission_requested` / last assistant `tool_calls` without `tool_result` and no `turn_completed`
2. **and** the journal has no end-of-turn marker after the last user
3. Host appends `turn_cancelled|host_exit` and sets the lease to `interrupted`

The transcript must not look idle-complete. **Continue** on that chip (and on `agent_exit`) starts a **new** `session/prompt`: journal is the short i18n continue phrase; the agent text includes the unfinished command when known. The old `session/request_permission` RPC is **not** replayed.

A previous host that did not mark `logs/host_runtime.json` `shutdown: true` is recorded in `logs/unclean-restart.log`. Windows native exceptions write `logs/last_crash.txt`. These files ship in the session diagnostic zip when present.

`LiveSession.prompt_in_flight` is the authoritative "this chat is working" flag.
It is set when `session/prompt` is dispatched and cleared **only** by:

| Signal | Note |
|--------|------|
| `PromptComplete { authoritative: true }` | The `session/prompt` RPC result — applied by the event pump in FIFO order, so every chunk received ahead of it is already in the journal before the turn clears. |
| prompt RPC error / timeout | Cleared against the **session id**, not the live slot (the chat may have been demoted mid-turn). |
| `stop` / `ProcessExited` / recorded turn error | Turn is over either way. |
| mock backend terminal chunk | Mock has no prompt RPC. |

**Prompt terminal ordering (P0):** on the normal pump path the reader never
resolves the `session/prompt` waiter directly. The result is queued as
`AcpEvent::PromptRpcSettled`, and the owning event pump — the same single
consumer that applies stream/tool events — claims the waiter, applies the
authoritative `PromptComplete`, and only then sends the result. `mpsc::send`
does not wait for the receiver, so resolving in the reader let the turn task
finish and clear `stream_buf` while the pump was still behind chunks that
arrived earlier; those chunks then arrived with `prompt_in_flight=false` and
were dropped as session-load replay — the App journal kept an empty assistant
row while the agent-side history already held the body. `prompt_for` adds no
events after the RPC: the queued terminal's finish path takes the pending
stream payload with `done: true`, so the UI stream settles without a separate
done tick or a duplicate `PromptComplete`.

The claim is atomic (one pending-map removal). The early `prompt_complete`
fallback and the real RPC result can both queue a settlement for the same prompt
before either is drained; only the claim owner applies the terminal and releases
the waiter. A duplicate, a timeout/abort that already removed the waiter, or a
waiter whose turn task is gone (closed receiver) applies **no** terminal — a
stale settlement must never end whatever turn is running when it is finally
drained. The delayed fallback uses the same queued path for its synthetic
result. Pumps that end their loop on the terminal event (aux side calls) claim
and release the waiter in that same iteration.

Failure outcomes by path:

| Case | Behavior |
|------|----------|
| `session/prompt` RPC error | The result is queued as `PromptRpcSettled`; the pump claims it and delivers `Err` without synthesizing an authoritative `PromptComplete`. The Host fails the turn on the RPC error path. |
| timeout / stop / abort | The waiter entry is already removed, so a later settlement claims nothing and applies no terminal. The idle watchdog only fails the turn when it removes the entry itself; if the pump already claimed it, the RPC result is still coming and the wait continues. That post-claim wait is bounded by a terminal-application grace (45s, checked every poll slice): a pump that claims the waiter but never applies the terminal fails the turn with a diagnostic error instead of polling forever. |
| no pump listening (host-less reader, receiver closed) | `event_tx.send` fails; the reader claims and delivers the result inline. There is no queue to order against and no Host turn state to end. |

`_x.ai/session/prompt_complete` arrives as `authoritative: false` and only
*defers*. `schedule_prompt_complete_fallback` is the escape hatch for an agent
that announces completion and then never returns the RPC result.

**That escape hatch must never front-run a talking agent.** It originally slept a
flat 3s and then resolved the pending `session/prompt` with a synthetic result —
which produced `authoritative: true` while chunks were still arriving, closing the
turn and sending the rest of the answer down the replay-drop path. Symptom:
journal holds a clean prefix of the answer, UI frozen mid-sentence, agent-side
`turn_ended outcome=completed`, no error anywhere. The window is therefore
**idle-based**: every inbound `session/update` re-arms it (`prompt_fallback_due`),
so the waiter is freed only after real silence.

**`session/prompt` wait (same idea):** not a fixed wall clock on total turn age.
Host uses `PROMPT_IDLE_TIMEOUT_SECS` (1800s / **30 min silence** without
`session/update`). Every inbound update re-arms the window, so a multi-image /
multi-tool turn that keeps emitting progress can run past 4 hours. There is
**no** absolute turn-age ceiling (that used to abort healthy batch image jobs).
A wedged / silent RPC still dies after 30 minutes of no updates. User Stop
still ends the turn.

### 4e. Host stream backpressure + long-tool heartbeat

| Mechanism | Behavior |
|-----------|----------|
| Stream emit coalesce | Per-turn buffer for `session://stream`. Flush on ~40ms idle, ≥600 chars, thought phase open/new, or `done`. Live + background paths. |
| Tool heartbeat | While `open_tool_ids` non-empty and turn busy: every **25s** re-arm `last_stream_progress` and emit `session://tool_heartbeat` `{ sessionId, toolCallIds, openCount, intervalSecs }`. Stops after **3h** age on oldest open tool (safety). |
| Stall interaction | Soft/hard stream stall only sees pure silence; heartbeats count as progress so long shell/find/subagent tools are not false-ended. |

Frontend also coalesces stream tokens (~48ms) before React `setState`.

### 4f. Main chat virtualization (scroll-safe)

When the transcript has **≥48** messages, the main chat uses a **variable-height**
virtual window (`chatVirtualList` + `useChatMessageVirtualizer`):

- Spacers preserve total `scrollHeight` so `useStickToBottom` pin / escape / re-pin
  and “Back to bottom” keep working.
- **Pinned** (following stream): always mount the tail; adaptive overscan builds
  upward (viewport-scaled, clamped).
- **Session open**: existing idle chats hold the transcript behind the
  loading overlay until mounted image/video cards have a measurable box
  (pending imgs, pending video posters). Then one instant scroll-to-bottom
  and reveal. Live streaming is never gated. Video occupancy is the reserved
  poster box (click-to-play does not load the file). Timeout 8s.
- **Escaped** (user scrolled up): window by `scrollTop`; height remeasure of rows
  above the viewport adjusts `scrollTop` so content does not jump.
- Force-mounted nearby only while escaped (find match, streaming assistant, last
  user/assistant within a small index gap). Distant tail force **must not** expand
  the continuous window across the whole list — that defeated virtualization on
  long history browse. While pinned, force may still expand for blank-pin defense.
- Scroll recomputes are rAF-coalesced; cumulative offsets are cached until a height
  commit so flings stay O(log n) for range find, not O(n) every event.

Consequences, all of them load-bearing:

- **Replay guard** (`session/load` re-emitting old chunks) gates on
  `prompt_in_flight`, not on `fsm.state()`. A chunk that arrives while a prompt
  is in flight but the FSM already Readied **re-opens** the turn (`begin_stream`).
- `live_session_is_busy` includes `prompt_in_flight`, so a chat that is still
  talking can never be **parked** or idle-recycled — parked agents get no event
  routing, so parking a live turn silently discards the rest of the answer.
- `try_finish_deferred_prompt_complete` refuses to end the turn while the prompt
  RPC is unresolved.
- `send_message` rejects a second prompt on a chat that already has one in
  flight, instead of dispatching into a busy agent.

**Event ingress never fails silently.** `handle_acp_event` resolves the owning
session by `process_id` across live → background. If a turn-bearing event
(stream / tool / gate / exit) matches nothing, Host tries to rescue a
still-streaming **parked** agent back into `background`, and otherwise logs
`warn` with the process id. A dropped chunk is a truncated answer, so it must
never be a bare `return`.

### 4d. View focus: every draft needs an identity

`viewingSessionIdRef` is `null` for a draft — and **all drafts look alike**. Any
async path that captured "I started on a draft" and re-checked with `=== null`
would match a *different* draft the user opened since, and yank the workbench
back. Symptom: send a task, immediately open a new chat in another project, and
the moment the agent starts executing you are dragged back to the first chat.

`src/lib/viewFocus.ts` pairs the viewed id with a monotonic **epoch** bumped by
every user navigation (`openSession`, `newChat`, automation takeover). Rule:

> Capture `currentViewFocus()` **before** the first `await`; before writing any
> view state (`viewingSessionIdRef`, `setSession`, sidebar expand, optimistic
> bubbles), re-check with `shouldAdoptView` / `isViewingSendTarget`.

`isViewingSendTarget` compares real ids directly (reopening the same chat still
counts as watching it) and falls back to the epoch only for drafts.

**Thread order on reopen.** `mergeSessionMessagesById` places rows that exist
only in the journal **before the next row both sides share**, never at the tail.
Appending them meant that a cache holding just the streaming assistant (possible
after a mid-turn switch) rendered the user's own prompt *after* the whole
answer. Primary order is copied verbatim, including the repeated ids that
`tool_step` rows legitimately share. `snapshotOutgoingMessages` additionally
refuses to overwrite a populated session cache with an empty workbench view.

**Background gates:** a demoted chat can raise `session://permission` /
`session://ask_user`. The UI keeps them per `sessionId` and restores the bar when
you reopen that chat (toast + desktop notification meanwhile); it never steals a
draft's composer. Answers route to the requesting chat's process. A waiting
background chat emits its own `session://runtime`, so the sidebar shows which
chat is blocked.

**Desktop notification click (#654):** Host `desktop_notify_show` is no longer
fire-and-forget on the live path. A native click restores the main window
(`tray::show_main_window`) and emits `notify://clicked` with `sessionId`. The
WebView handler opens that chat (same as Web `Notification.onclick` from #228).
Unknown / missing id still focuses the app. Packaged macOS uses UN default
action; Windows uses WinRT `on_activated`. Bare `tauri dev` osascript toasts
cannot deep-link (they belong to Script Editor). Do **not** fold Windows
taskbar overlay / message-bubble work into this click path.

## Who does `/compact`?

| Layer | Behavior |
|-------|----------|
| **Agent (Grok Build)** | **Primary.** Auto-compacts when context ≈ **85%** full (`[session] auto_compact_threshold_percent`). User can also run **`/compact [note]`** in-session. |
| **App Host / UI** | Does **not** auto-compress the agent window. Slash **`/compact`** is a user action: confirm dialog → send `/compact …` as a normal prompt to the agent. Host journal is **not** rewritten by compact (UI history stays full). |

### UI surface for compact (required)

Host listens for agent compact signals (`session/update` kinds such as `tokens_used` / `*compact*` / compact tools) and:

1. Appends a **journal marker** (`role: tool`, `marker: context_compact`)
2. Emits `session://context_compact` for live UI
3. Chat shows a **compact banner** (auto vs manual + optional token before→after + summary)
4. Short **toast** on live event

App history still shows full prior bubbles; the banner signals that **agent context** was compressed.

## Agent activity visibility (timeline + honesty)

Presentation rules (non-intrusive, audited 2026-07; timeline 2026-07-26):

1. **True timeline (while streaming)**: each tool is a `segments` entry (`kind: "tool"`) on the current-turn **assistant**, inserted when `applyToolEvent` fires. UI renders **thought → tool → content** in stream order inside the assistant bubble — not a bottom dump.
2. **Phase collapse (display layer)**: consecutive thought + tools form a **work phase**. When the phase ends (next **content**, or a **new thought after tools**, or turn idle), it collapses to one expandable chip (`TimelinePhaseBlock`). Expand to see reasoning + tool list. **Does not wait for final answer** — merge at phase boundary. Answer `content` never folds into a phase. Live trailing phase stays expanded while streaming.  
   **Layout (CodePilot-aligned)**: phase header = count badge + summary + caret-right; expanded body = **single left rail** (`border-l-2`); tool rows are flat 28px mono lines with **status dot on the right** (no nested left-dot + chevron stacks).
3. **Turn end + journal / reload**: Host often stores `U → assistant(final) → tool_step…` while tool `createdAt` is *earlier* than the assistant finalize time. `weaveToolsIntoAssistantSegments` (transcript paint + openSession + journal rehydrate) collects **all tools in the user-turn window**. Journals that never stored live interleave still rebuild as **thought → tools → content**. If the live turn already interleaved thought ↔ tool ↔ content, **keep that stream order** when the turn ends (`reorderSegmentsToHistoryLayout` only clears leftover tool `streaming` flags — it must not flatten the cycle). Message merge **must not re-sort by createdAt** (that produced `U → tools → A` and piled steps at the wrong end).
4. **No bottom turn-activity block** in the transcript. Failures are **quiet red dots / short hints** on timeline / phase rows only.
5. **Context grouping**: ≥3 consecutive read/search tools inside a phase expand as “Gathering context” (`TimelineContextGroup`).
6. **Standalone tool rows**: only when a tool arrives before any assistant bubble (and is not yet inlined), or a single tool without thought (not phase-worthy).
7. **Thinking labels**: content gist or duration — **never** 「思考 1 / 思考 2」 numbering.
8. **End of turn**: stop / stall / agent exit / permission deny / error → one **EndOfTurnChip** family. User Stop arms a **2s latch**.
9. Quiet “thinking” only when busy with no running tool and no streaming assistant.

| Piece | Behavior |
|-------|----------|
| Live tools | `session://tool` → `applyToolEvent` upserts `tool_step` **and** assistant `segments` |
| Timeline UI | `TimelineToolRow` / `TimelineContextGroup` inside assistant |
| Failed tools | Red mark on timeline row only |
| Tasks panel | Still `buildTurnActivity` / `collectSessionTasks` from `tool_step` rows |
| Cancel / stop | `turn_end` / `turn_cancelled` → `EndOfTurnChip` |
| Multi-session busy | `sessionLiveStore` |
| Session UUID hint | Host injects narrow search hint when resuming by UUID |

Old sessions without woven segments may still show tools after the answer body after weave — acceptable. New live turns keep stream order for the whole turn (think → tools → mid-turn body → think → tools → answer). Do not hoist every thought to the top or dump every tool into one fold.

## Acceptance

1. Reopen a multi-turn App session after killing the agent process → next send either loads the same `agentSessionId` or injects bootstrap so the model knows prior turns.  
2. Soft-respawn (permission change) → resume preferred.  
3. Brand-new chat → no bootstrap, plain `session/new`.  
4. `/compact` still only runs when the user (or agent auto-threshold) triggers it on the agent side.
5. A streaming in chat A + send in chat B → B's turn goes to B (A's journal untouched), A finishes in background.
6. Chat A blocks on a tool permission while you read chat B → reopen A and the approval bar is still there and works.
7. Agent fires `prompt_complete` early and keeps writing → the full answer lands in the journal, and the turn ends when the prompt RPC resolves.
8. Reopening a chat that is streaming in background shows the live spinner / streaming bubble, not an idle-looking finished thread.
9. Send, then immediately open a new chat in another project → you stay on the new draft when the agent starts executing.
10. Switch away mid-turn and back → the thread reads user → thinking → tools → answer, with no prompt stranded at the bottom.


### CLI 批量导入统计（#1413）

列表返回 `bulkImportable`，与宿主全部导入共享同一过滤规则：排除已关联、删除墓碑、空 stub 和噪声目录。按钮统计下一批（最多 50 条）候选，仍可能因文件损坏或并发删除而失败。候选实际尝试后全部失败时返回首个原始错误，不能显示成功导入 0 条。独立模式继续只扫描当前 GROK_HOME；不得因相似标题、同项目或相同正文自动合并不同 agent id 的会话，也不扩大磁盘删除允许范围。
