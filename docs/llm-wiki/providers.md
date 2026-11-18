# Custom providers & agent profile

Product rules for **OpenAI-compatible relays** (CPA / sub2api / OneAPI / self-hosted) and how they reach Grok Build.

## Agent transport (shared with Grok Desktop)

Both Grok App and community **Grok Desktop** drive intelligence the same way:

| Layer | Implementation |
|-------|----------------|
| Runtime | **Grok Build CLI** binary (`grok`) |
| Entry | `grok agent stdio` |
| Protocol | **ACP** (Agent Client Protocol) JSON-RPC over stdio |
| Client | Desktop Host (`AcpClient`) — **not** a reimplemented agent brain |

Desktop never reimplements tools/sampling. It is an ACP client + UI shell.

## Agent profile (`GROK_HOME`)

| Session data mode | `GROK_HOME` for spawned agent |
|-------------------|-------------------------------|
| `shared` (default) | `~/.grok` (same home as terminal Grok Build CLI) |
| `independent` | `~/.grok-app/agent-home` (or `$GROK_APP_HOME/agent-home`) |

Custom providers are written to **`$GROK_HOME/config.toml`** as `[model.<id>]` sections so the agent can use `base_url` + `api_key` without OAuth fallback.

## Provider model (L2)

| Field | Role |
|-------|------|
| `id` | Config section slug (`[model.<id>]`). **Reserved:** `grok` and `official` (legacy `[models].default = "grok"` official key; a custom section with that id must not steal the official route). |
| `name` | Channel display label (provider card / menu group) |
| `baseUrl` | OpenAI-compatible root, usually ends with `/v1` |
| `baseUrlFullPath` | When **true**, host stores the URL as typed and **does not** auto-append `/v1` (App TOML `app_base_url_full_path`). Default **false** = legacy auto-`/v1` for CPA/sub2api. Use for gateways like Volcengine Ark Coding Plan (`…/api/coding`, `…/api/coding/v3`). Settings UI: switch **完整路径 / Full path** next to Base URL label. |
| `apiKey` | Required for custom relay; never returned plaintext to UI |
| `model` | **Active** request body model id (written to config `model = …`) |
| `models` | Multi-model catalog (`[{id, name, contextWindow?, contextWindowSource?, supportsReasoningEffort?, supportsReasoningEffortSource?, supportsReasoningOff?, efforts?, effortsSource?}]`; legacy `supportsVision?` / `supportsVideo?` stay verbatim); App field `app_models` JSON in TOML (ignored by Grok Build). Written only when the caller sends `models`: omitting it (`models: None`) keeps the stored field value verbatim and never adds the key to a legacy parent. Each entry has request id + **display name**. Per-model context window and reasoning ladder live here; Settings row **gear** edits them. Live `/models` fills context window and reasoning metadata when the API advertises them. The composer lists every catalog id under the provider (#1394). For a **generic** relay, each id is its own `[model.<providerId>__<slug>]` section (`model` = that upstream id) so `session/set_model` of the section name changes the request body (#1337). The original `[model.<providerId>]` stays the channel. A **Grok Build-compatible relay** still sends the catalog id and does not get extra sections. |
| `efforts` | Channel-level reasoning-effort fallback (`[{id, name, isDefault}]`); App field `app_efforts` JSON. Composer uses the session-selected model row's own `efforts`. A model row without a ladder uses the generic fallback `low`/`medium`/`high`/`xhigh` with `medium` default; it never borrows a different row's ladder. Only a legacy single-model catalog may use channel `efforts` when its one row matches the channel model. Every generic child also gets CLI-native `reasoning_efforts = [{ id = <raw>, value = <canonical wire>, label, default }]`, so the CLI accepts the raw option id and sends its mapped tier. Settings model edits update `app_efforts` for legacy compatibility; Composer model picks do not overwrite it. |
| `contextWindow` | Channel-level token cap → TOML `context_window` as a **bare integer** (never `"1000000"`). Grok Build rejects string type and falls back to 200k (#538). Effective value is the **model row's** window, then this channel field, then the 1M default. Settings edits the window only in the model-row gear; the channel field has no UI editor and stays only for presets / legacy data. The Composer no longer selects a window. Upsert writes both the model row and the channel field, except that a corrupt catalog omits `models` (only the channel field changes) and an explicitly empty catalog still sends `[]` and stays empty. Host applies the effective value on connect and on model switch via `session/set_model` `_meta.contextWindow`. Missing model value → API value, then `DEFAULT_CUSTOM_CONTEXT_WINDOW` (**1M**) for custom channels. |
| `apiBackend` | Message format: `responses` (default) \| `chat_completions` \| `messages` |
| `supportsVision` | **Legacy compatibility only.** Channel-level App field `app_supports_vision`; per-model `supportsVision` / `supportsVideo` in `app_models` still win when set. Settings no longer exposes image/video capability controls, and a live `/models` refresh never changes these flags. Host `custom_provider_is_text_only` keeps its existing read path (active row, then channel flag, then name / id heuristics); unknown relays stay text-only so DeepSeek-style APIs do not 400 on `image_url`. |
| `extraHeaders` | Extra HTTP headers written as Grok Build `[model.<id>].extra_headers` (inline TOML table, sent verbatim on inference). Settings → Account → Providers editor. Use for gateways that WAF-check `User-Agent` / `Originator` (e.g. AgentRouter) or Anthropic `x-api-key`. Empty = omit the field. Newlines in values are rejected. |
| `providerMode` | Explicit transport semantics: `generic` (default) or `grok_build_proxy`. Never infer this from a provider id or hostname. |
| `isDefault` | Legacy read of `[models].default`. The App no longer writes that key anywhere (activation or provider removal); a chat's provider comes from its own composer preference. |

**Integer TOML fields:** Host writes `context_window = 1000000` (CLI-compatible). On `providers_list`, legacy quoted string forms are repaired in place. Other model edits must not drop or re-quote this field.

**Official model windows** come from the CLI catalog. The App stores no per-model override and offers no window picker; `models_list_available` reports `contextWindow` / `contextWindows` as read from the catalog, and connect / model switch resolve the target model's window on the host.

### Model catalog read/write contract

`app_models` is the App-owned catalog; Grok Build ignores it. Settings, Composer, and session model resolution read it through one contract:

| On-disk state | Read result |
|---------------|-------------|
| Missing / blank | Legacy provider: one row from the channel `model` (display name = same id) |
| Valid JSON array, including `[]` | Exactly those rows; `[]` is an explicit clear and is never re-seeded from `model` |
| Row without `name` | Display name falls back to the request `id` |
| Blank or duplicate `id` | `id` is trimmed; blank rows are dropped and the first duplicate wins |
| Empty optional value (`contextWindow` `0` / `null` / missing, empty `efforts`) | Row stores no value; the existing channel fallback still applies |
| `null`, JSON object / string / number, malformed JSON, or a non-empty array whose rows all normalize away | Not a catalog: reads as a legacy row and reports `modelCatalogCorrupt: true`; Settings shows a warning, and a save that omits `models` to preserve the unreadable field logs a warning with only the provider id and a fixed defect category (`malformed JSON` / `invalid row shape` / `unsupported JSON type` / `no usable rows`) |
| JSON array where at least one row does not match the row shape | Still not a catalog (`modelCatalogCorrupt: true`, `invalid row shape`), but the read keeps every row whose `id` is a non-blank string: trimmed `id`, `name`, and only correctly typed `contextWindow` (positive integer) / `contextWindowSource` / legacy `supportsVision` / `supportsVideo` / a safely deserializable `efforts` ladder / `effortsSource` / `supportsReasoningEffort` / `supportsReasoningEffortSource` / `supportsReasoningOff`. Unknown fields and wrong-typed values are ignored, never repaired. A value with no readable `id` reads as the legacy row. Editing or clearing the catalog replaces the original payload |

Only a missing or blank field is a legacy provider. The App is the only writer of `app_models` and a catalog edit always encodes a JSON array, so `null`, an object, a string, a number, malformed JSON, or a non-empty array whose rows all normalize away is a damaged or foreign value, not an older format. An array with at least one invalid row is damaged too, but its readable rows still keep their identities in Settings and the composer instead of collapsing to the channel fallback; the warning stays, because the stored value is still not a catalog that can be rewritten. `models: None` means the caller did not edit the catalog, so **every** on-disk state is carried over as-is: the stored `app_models` field-value string is written back decoded but otherwise unchanged (surrounding whitespace, unknown per-row fields, row key order, and unreadable text included), and a parent without the key stays without it — a plain save never synthesizes a catalog for a legacy provider. The TOML section itself may still be rewritten with normalized formatting; the field value is not re-encoded. Only an explicit `models: Some(rows)` writes a normalized catalog: `models: []` is an explicit clear, and changing or replacing model rows repairs the field (for a partially invalid array, that replaces the original corrupt payload with the rows shown in the form).

Identity is `(provider id, model id)`. Renaming a row or changing channel defaults never changes the request id. Writes keep row order and omit empty optional fields, so save → reopen is stable. The legacy display fallback also names the generic child `[model.<providerId>__<slug>]` section, so Settings, the composer, and post-migration sections show the same label.

`modelCatalogCorrupt` is deliberately opaque: it never carries the raw value or the parse detail, only whether the stored catalog can be rewritten. The stored text is host-internal for verbatim persistence and never appears in logs, diagnostics, or `Debug` output; `ModelCatalogCorruption` debug redacts it and reports the fixed category instead. Settings shows a warning and sends `models` only when the user actually changes the catalog; an edit to the provider name, key, or another field leaves the stored `app_models` field-value string intact, though the TOML section may still be rewritten with normalized formatting. Such a save also keeps the stored channel `model` and its channel metadata (`context_window`, `app_supports_vision`, `app_efforts`): the rows the host lists for an unreadable catalog are only a recovery read, so neither Settings nor `providers_upsert` derives the channel from them. `providers_upsert` with `models: None` and an unreadable catalog keeps the `model` already on disk and only falls back to the request model when the provider has no section yet; a recovered row's context window, caps, and efforts still land on that row's own child section. An explicit `models: Some(...)` repair resolves the active model from the new catalog as usual. Per-model settings (context window, reasoning ladder and reasoning support) stay disabled while the catalog is unreadable: even recovered rows are only a partial read, so a gear edit would send a catalog that drops the unreadable rows and replace the original value. The gear unlocks once the model rows are explicitly edited or replaced in the model list, and a create that collides with a corrupt id keeps it disabled until the save makes the stored catalog readable again. A create whose id already exists falls back to that same update rule, so an untouched unreadable value survives a re-added preset and only a different preset catalog replaces it. A composer context-window change writes the channel `contextWindow`; for a corrupt catalog it omits `models`, so the fallback row never overwrites the unreadable value. An explicitly empty catalog still sends `models: []` and stays empty, while a readable non-empty catalog updates the affected model row as before. Editing or replacing rows repairs the value; removing every row is the explicit clear.

Any `models` row whose `id` is blank / whitespace is rejected before normalization — even when other rows are valid — because dropping it would silently shrink the catalog, and a single blank row would otherwise become `models: []`, which means "clear". Settings blocks the save with a field error instead of filtering the row out, and `providers_upsert` returns a fixed validation error without echoing the row. Send an empty list to clear.

An explicit channel clear removes the previous key instead of copying the legacy value back: `models: []`, `efforts: []`, `contextWindow: 0`, `supportsVision: false`, empty `appendPrompt`, `extraHeaders: []`, `baseUrlFullPath: false`. Omitting a field on edit keeps the stored value, so old TOML, `api_key`, and existing child `[model.*]` sections stay usable. `models: []` keeps the existing child sections (older sessions still reference their section ids) while the catalog itself stays empty; an unreadable `app_models` value likewise keeps them. The composer follows the same contract: an explicitly empty catalog lists no rows for that provider, and a chat with no stored model id falls back to the official default **and the official route** instead of the cleared channel `model` — the chip must not stay on the provider while the model is official. A saved session keeps its own model id and provider route because its child section stays — its chip and request model show that id, not the cleared channel `model`; only a missing catalog synthesizes the legacy channel row. On a corrupt catalog, a saved session model id missing from the recovered rows is still shown and requested as-is, because the host keeps its child section. Each recovered row from a partially invalid array gets the generic child section its model id needs, so a row listed in the composer really spawns and `session/set_model`s on that section; `app_models` is never rewritten and stays corrupt until the user explicitly saves the catalog. An existing child for the same model keeps its section id, `model`, `name`, `context_window`, and unknown fields; a row without one gets a new `[model.<providerId>__<slug>]` with the current channel runtime fields. Children the recovered rows do not name are kept, because older sessions may still reference them. Neither that case, `models: []`, nor an unreadable value with no recovered row creates or deletes a child from the channel `model` guess. In all of them sync refreshes only provider-shared fields on existing generic children — `base_url`, `app_upstream_base_url` (when present), `api_key`, `api_backend`, `extra_headers`, `supports_reasoning_effort`, `app_provider_mode`, and `app_parent_provider` — while section IDs, `model`, `name`, `context_window`, and unknown fields stay. Missing or blank parent values for `base_url`, `app_upstream_base_url`, `api_key`, `extra_headers`, or `supports_reasoning_effort` remove the child's stale copy; a missing `api_backend` falls back to `chat_completions`. An unreadable field-value string is kept verbatim, including surrounding whitespace, until the user saves the catalog explicitly; the section itself may still be rewritten with normalized TOML formatting.

### Per-model metadata (context window & reasoning)

Each catalog row owns its context window and reasoning ladder. Settings edits one row in a modal; the values persist in `app_models` and survive save → reopen.

| Field | Default / rules |
|-------|-----------------|
| `contextWindow` | Positive integer tokens. Missing API value → **1M** fallback. Empty input in the modal resets to the latest API value, else 1M. Invalid non-empty input blocks save with an in-app error; a parse failure is never treated as a clear. |
| `efforts` | Ordered ladder of `{ id, name, isDefault }`. IDs keep their token spelling/case after trimming and are sent unchanged; App never maps a custom id such as `minimum` or `max`. Only non-empty unique CLI token IDs up to 64 characters are retained. Default is the first marked id, else `medium`, else the first retained id. A missing ladder in an explicit model catalog → generic `low`/`medium`/`high`/`xhigh` fallback with `medium` default; legacy single-model behavior uses its matching channel ladder. An advertised `none` id enables Off unless the user disables it in settings. |
| `supportsReasoningEffort` | API/legacy capability signal. A non-fallback configured ladder or explicit `supportsReasoningOff: true` implies reasoning support even if this flag is `false`; without either, explicit `false` hides fallback levels and the Host omits `--reasoning-effort`. |
| `supportsReasoningOff` | Optional user setting, shown as **支持关闭推理 / Allow Off in Composer**. Missing defaults to true only when the model's own ladder advertises `none`; otherwise false. When enabled, App adds raw id `none` to that model's ladder if absent, allowing Composer to disable extended reasoning for faster responses. The Host accepts `none` only for that model and sends it unchanged. |

Provenance (`user` / `remote` / `fallback`) is stored beside `contextWindow`, `efforts`, and `supportsReasoningEffort` so a refresh can apply the agreed precedence:

1. **User** — an explicit value from the gear modal (or an older row's non-empty value, which reads as user-set). A `/models` refresh never overwrites it.
2. **Remote** — adopted from the live catalog. A later refresh replaces it with the newest API value.
3. **Fallback** — App default. A later refresh replaces it with an API value when one appears; without one the fallback stays.

Clearing a field resets it to the latest API value or the fallback instead of silently storing `0`/empty. An unrelated provider save does not rewrite the channel metadata or the stored per-row legacy image/video flags.

**Live `/models` extensions.** The OpenAI-compatible endpoint only standardizes `id` / `created` / `object` / `owned_by`. Context window and reasoning fields are vendor extensions; App only reads values it can validate:

| Extension | Accepted shape |
|-----------|----------------|
| Context | `context_window` / `contextWindow` / `context_length` / `contextLength` / `max_model_len` / `max_context_length`, at the row or under `architecture` / `top_provider`. Positive integers (or numeric strings) only. |
| Ladder | `reasoning_efforts` / `reasoningEfforts`: array of `{ id \| value \| effort, name \| label, default \| isDefault \| is_default }` or plain id strings. Blank / duplicate ids are dropped, at most 32 rows survive, ids are capped at 64 chars and names at 80. |
| Support | `supports_reasoning_effort` / `supportsReasoningEffort`: boolean. A non-empty API ladder implies support and takes precedence over a conflicting `false`; `false` without a ladder means no reasoning levels. The App-owned `supportsReasoningOff` setting is separate from this API signal. |

Anything missing, wrong-typed, or out of bounds is ignored rather than inferred from the model name. A duplicated `id` keeps the first advertised row so the picker never shows one model twice. Image/video capabilities are not part of this contract: the provider model UI has no capability switches, and attachment submission is unchanged.

### Presets (add provider)

Add flow opens a **preset gallery** (`providerPresets.ts`):

| Preset | Models | Default efforts |
|--------|--------|-----------------|
| **Custom** | empty (user fills) | Grok `low`/`medium`/`high` |
| **DeepSeek** | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, `deepseek-v4-pro` | `low` / `high` / `xhigh` / `max` (docs mapping table; default `high`) |
| **OpenRouter** | `z-ai/glm-5.3-flash` | GLM `low`/`high`/`max` (default `max`); vision on; `context_window` 1 048 576 |
| **OrcaRouter** | `orcarouter/auto`, `openai/gpt-4o-mini`, `google/gemini-2.5-flash` | Grok `low`/`medium`/`high`/`max` (default `medium`); vision on |
| **Requesty** | `grok-4.6`, `gemini-3.5-flash`, `deepseek-v4-flash` (managed policy ids; `vendor/model` ids also work) | Grok `low`/`medium`/`high`/`max` (default `medium`); vision on |
| **Amux** | `grok-4.7` + `grok-4.6` + `grok-4.5` | Official Grok `low`/`medium`/`high`/`xhigh` (default `xhigh`) |
| **Yun API** | `grok-4.7` + `grok-4.6` + `grok-4.5` | Official Grok `low`/`medium`/`high`/`xhigh` (default `xhigh`) |
| **OpenCode Go** | `deepseek-v4-flash`, `deepseek-v4-pro` | DeepSeek efforts (default `high`) |
| **火山方舟** (Volcengine Ark) | `deepseek-v4-flash` | Grok `low`/`medium`/`high`/`max` (default `medium`); **full path** on |
| **AI98PRO** | `grok-4.7` + `grok-4.6` + `grok-4.5` | Official Grok `low`/`medium`/`high`/`xhigh` (default `xhigh`); vision on |
| **智谱** | `glm-5.3-flash` (1M, vision+video, `low`/`high`/`max`) | One gallery chip. Click picks China API / China Coding Plan / international API / international Coding Plan. Form tags above Base URL switch the same four roots. All `chat_completions` + **full path**. Official Z tile (`docs/svg/zhipu.svg`) on list / footer / welcome; sidebar top-left when Replace brand logo is on (dark square + white Z, inverted in dark theme). |

| Preset | Base | Get API Key |
|--------|------|-------------|
| DeepSeek | `https://api.deepseek.com/v1` (`chat_completions`) | https://platform.deepseek.com/ |
| OpenRouter | `https://openrouter.ai/api/v1` (`chat_completions`) | https://openrouter.ai/settings/keys |
| OrcaRouter | `https://api.orcarouter.ai/v1` (`chat_completions`) | https://orcarouter.ai/ |
| Requesty | `https://router.requesty.ai/v1` (`chat_completions`; EU: `https://router.eu.requesty.ai/v1`) | https://app.requesty.ai/api-keys |
| Amux | `https://api.amux.ai/v1` (`responses`) | https://api.amux.ai/register?aff=Vccp |
| Yun API | `https://api.yunyi.ai/v1` (`responses`) | https://api.yunyi.ai/register/?aff_code=W0iw |
| OpenCode Go | `https://opencode.ai/zen/go/v1` (`chat_completions`) | https://opencode.ai/ |
| 火山方舟 | `https://ark.cn-beijing.volces.com/api/plan/v3` (`chat_completions`, **full path**) | https://console.volcengine.com/ark |
| AI98PRO | `https://ai98pro.xyz/v1` (`responses`) | https://ai98pro.xyz |
| 智谱 · 国内 API | `https://open.bigmodel.cn/api/paas/v4` (`chat_completions`, **full path**) | https://open.bigmodel.cn/usercenter/proj-api-key |
| 智谱 · 国内 Coding Plan | `https://open.bigmodel.cn/api/coding/paas/v4` | https://bigmodel.cn/coding-plan/personal/overview |
| 智谱 · 海外 API | `https://api.z.ai/api/paas/v4` | https://z.ai/manage-apikey/apikey-list |
| 智谱 · 海外 Coding Plan | `https://api.z.ai/api/coding/paas/v4` | https://z.ai/manage-apikey/apikey-list |

### Protocol pitfall (OpenCode Go / DeepSeek)

Grok Build’s stream parsers are strict. OpenCode Zen Go historically breaks both backends:

| Backend | Failure mode |
|---------|----------------|
| `responses` | Non-OpenAI frames (`{"type":"ping"}`) or `response.*.delta` **without** `sequence_number` → CLI worker fatal |
| `chat_completions` | Trailer frames like `{"choices":[],"x-opencode-type":"inference-cost",…}` **without** required `id` → `Failed to deserialize ChatCompletionChunk` → same crash |

**App fix (automatic):**

1. Prefer preset `api_backend = "chat_completions"` for OpenCode Go (do **not** use `responses`).
2. Host starts a **loopback SSE sanitize proxy** (`relay_stream_proxy`): rewrites that provider’s `base_url` to `http://127.0.0.1:{port}/r/{id}/v1`, stores the real host in `app_upstream_base_url` (CLI ignores unknown keys), and **drops** cost / ping / missing-`id` frames before Grok Build sees them.
3. Settings UI still shows the real upstream URL; repair runs on app start and `providers_list`. `app_upstream_base_url` exists only while `base_url` is that loopback rewrite: saving the channel back to a direct endpoint — or switching it to `grok_build_proxy` — drops the old upstream, so display and native routing stop pointing at the previous host. Re-saving the same local proxy keeps the real upstream; startup repair also drops an upstream left beside a direct endpoint.

Form shows a **Get API Key** text control under the key field when the channel matches a preset (by id or base host). Opens the URL via `open_external_url`.

CPA / sub2api / grok-go remain generic OpenAI-compatible relays.

### Grok Build-compatible relay mode

Use `providerMode = grok_build_proxy` only for a relay that intentionally
implements Grok Build's model catalog and native proxy contract. This mode is
separate from ordinary `[model.<id>]` relays:

| Concern | Host contract |
|---------|---------------|
| Opt-in | Settings → Account → Custom providers → Provider mode → **Grok Build-compatible relay**, stored as `app_provider_mode = "grok_build_proxy"`; no BeefAPI or hostname special case |
| Protocol | `responses` only |
| Capability gate | Live `/models` validation runs per item only for an explicitly submitted or replaced **non-empty** selection, and requires every listed model to exist with `supports_backend_search = true`. An existing proxy saved with `models: []` passes without a live fetch or validation, so the explicit clear is allowed; a **create** with an empty selection is rejected (`grok_build_proxy requires at least one model`) before any request. A save that omits `models` while the provider keeps an unreadable or explicitly cleared catalog skips re-validation under the same stock-protection rule: the catalog did not change, and the channel `model` is only a display guess, so a name / API key edit still saves and the stored catalog stays verbatim. An omitted `models` on a create or a readable / legacy catalog validates just the channel `model` |
| ACP model | Spawn and `session/set_model` use the real selected model id, such as `grok-4.7`, rather than the provider section alias. With an unreadable or explicitly cleared catalog, a non-empty model stored on the chat is sent unchanged by both (a chat created on a model the catalog no longer lists keeps that upstream id instead of switching to the alias on a later turn); an empty or channel-alias request takes the same fallback row on both (the channel `model` when it is a catalog row, otherwise the first readable row, or the channel `model` again when no row is readable). A readable catalog still validates the id on both and falls back to that same active row |
| Child environment | Only the target `grok agent stdio` process receives `GROK_MODELS_BASE_URL`, `GROK_MODELS_LIST_URL`, `GROK_CLI_CHAT_PROXY_BASE_URL`, and `XAI_API_KEY` |
| Generic compatibility | Generic providers keep the channel `[model.<id>]` plus one `[model.<id>__<slug>]` per catalog row. Spawn and `session/set_model` use the selected row's section. The stream sanitizer is unchanged |
| Composer id vs CLI id (#1000, #1294, #1337, #1394) | The picker stores `app_models[].id` (request-body id). For a **generic** relay, each catalog id is its own `[model.<providerId>__<slug>]` section (`model` = that upstream id). Host sends that section name for both `--model` and `session/set_model`, and the menu lists every catalog row. CLI 1.0.70 accepts the section name (`matched by map key`) and puts that section's `model` field in the request body, so picking A does not send B. An id that is neither a section nor some section's `model` field returns `unknown model id`. `_meta.model` does not change the request body. Do not rewrite the shared parent `[model.<providerId>].model` per chat. Old single-section configs still resolve to the provider id until migration writes the child sections. Migration rewrites only App agent-home (independent mode), is idempotent, and leaves hand-written sections and comment order alone. A **Grok Build-compatible relay** still sends the real catalog id on both, matching spawn, still lists each catalog row, and does not get per-model sections; when its stored catalog is unreadable or explicitly cleared, spawn and `session/set_model` repeat the chat's stored id instead of the channel alias. Cold connect also applies `session/set_model` after `session/new` (same as unpark) so turn 1 and turn 2 cannot diverge. Official catalog ids (`grok-4.7`, `grok-4.7-build-fast`, `grok-4.6`, `grok-4.5`) are never remapped through a relay that also lists them. |
| Apply | Editing a provider invalidates only chats routed to that provider; the next turn uses its new catalog and capability contract |
| Attachments | Unchanged: App still sends `@absolute/path` inside ACP text content; this mode does not claim or add native ACP image blocks |

The key stays write-only from the UI and is never included in spawn logs.
`WSLENV` forwards the native URL/key variables without path translation; macOS,
Linux, and native Windows inherit them directly on the child command. This mode
does not enable `official-aux`, does not mix official OAuth into the relay home,
and does not require a second xAI credential.

## Settings UI (Account → Custom providers)

Left / right split (`ProvidersPanel`):

| Side | Content |
|------|---------|
| Left | **Add provider** on top; list of cards. Official Grok card first **only if** signed in / CLI auth / official key; otherwise list starts empty. |
| Right | Create/edit form when adding or selecting a custom card; official detail when selecting the official card; empty placeholder otherwise. |

Clicking a card opens detail/edit. There is **no “Use” button and no global active route**: the composer model menu selects a provider for one chat. No long intro copy, agent-home path, or separate “active route” switcher.

### Custom route requires independent data mode (#557)

Custom providers are written only under App **agent-home** `config.toml`. Default `session_data_mode=shared` uses `GROK_HOME=~/.grok`, where those sections are invisible — so third-party channels would fail without official login.

Custom chats do **not** require `session_data_mode=independent`. Spawn resolves `GROK_HOME=agent-home` for a custom route and prepares that home as independent, even while the app-wide mode stays `shared`. Official chats keep `~/.grok` in shared mode and agent-home in independent mode. The Settings session-data control therefore no longer locks shared mode when providers exist.

API keys stay in agent-home `config.toml`, are never returned by `providers_list`, and never appear in spawn logs.

## Official tool injection

Settings → Account → **Extras** → toggle **Inject official tools** (`official_aux_inject`).

**Only for chats whose own provider is custom.** The gate is the session route passed at spawn, not a global default. Official Grok subscription chats never inject `official-aux` (native tools only), even while another chat uses a relay.

When the toggle is on, credentials exist, and the chat's route is custom: MCP **official-aux** (`web_search`, all `x_*`, `vision_describe`) under `agent-home-official`. Default does **not** also load extension MCPs (`official_aux_with_user_mcp` off) so tools are not stuck behind 30s Playwright timeouts. Does **not** put `auth.json` back into the custom main agent-home. See [model-routing.md](./model-routing.md).

## Route switching (auth isolation)

Grok Build 0.2.x will send **OIDC** when `auth.json` is present — even if the request URL is a custom relay. That produces:

`Unauthorized (401) from https://api.example.com/v1/responses` with `Auth: Oidc`.

Verified working combinations:

| Chat route | agent `--model` | sealed `GROK_HOME` auth |
|------------|-----------------|-------------------------|
| Custom relay | per-model section id, or the catalog id for `grok_build_proxy` | **absent** (api_key only) |
| Official (no provider preference) | catalog id (`grok-4.7`) | **synced** from `~/.grok` |

A chat's stored `provider_id` is the single route authority. `[models].default` is a legacy CLI key and never decides a session route. Host prepares auth before each ACP spawn from that chat's route (`prepare_route_auth(custom)`); after official login / account switch the canonical agent-home mirror is refreshed, and a custom spawn still seals a private home without `auth.json`. A live ACP process does not read that shared file: spawn seals a private `GROK_HOME` under `agent-proc/` (#1293). Custom ACP processes also **skip** `authenticate(cached_token)` because that RPC reads `~/.grok/auth.json` even when `GROK_HOME` is agent-home.

**Composer pick is the only switch.** The composer model menu writes that chat through `composer_prefs_set` (`provider_id` + request model). It does not touch a global route and does not call `recycle_all_agents`. When the chat's provider changes, Host clears **only** its `agent_session_id` and soft-respawns it, so the new process cannot `session/load` the previous route. Other chats keep their process and CLI session id. SSH projects list official models only, and the Host normalizes stale custom picks to an official model.

**Recovery.** Missing provider preference → official. A pre-refactor session saved with only a custom `model_id` gets a one-time idempotent backfill: when exactly one custom provider lists that model id, its `provider_id` is written back (model id, effort, and ordering untouched); ambiguous or official ids stay on the official route. The backfill re-runs on next launch when the provider config is unreadable, and never touches rows that already have a `provider_id`. App removal rewrites chats on that provider to official + `grok-4.7` and no longer resets `[models].default`; if a provider disappears outside the App, connect-time resolution still falls back to the official default. An official model id the live catalog no longer lists also resolves to the official default. An explicitly cleared custom catalog keeps child sections for existing chats; when a readable catalog removes a saved model, the chat resolves to the provider's current channel model.

## Host commands

| Command | Role |
|---------|------|
| `providers_list` | Providers + legacy default read (no raw keys); blocking pool |
| `providers_upsert` | Create/update; empty key keeps previous; invalidates only chats already on that provider so their next send uses the new config |
| `providers_remove` | Delete section; invalidates only chats on that provider (they fall back to official on connect) |
| `providers_ping` | `GET {base}/models` RTT |
| `providers_list_models` | Fetch remote model ids |
| `providers_test_model` | Per-model probe: one tiny non-streaming inference request to `{base}/chat/completions` (\| `/responses` \| `/v1/messages` by `api_backend`); success = HTTP 2xx |
| `providers_balance` | Account balance / plan probe (Phase 1: **DeepSeek only**) |
| `providers_cc_switch_scan` | Read-only scan of local **CC Switch** Grok Build providers |
| `providers_cc_switch_import` | Import selected CC Switch rows into custom providers |
| `editors_list` | Detected local IDEs |
| `open_in_editor` | Open path in chosen editor |

### Balance probe (Phase 1: DeepSeek)

| Item | Detail |
|------|--------|
| When | Channel id/host is DeepSeek (`deepseek` / `api.deepseek.com`) — **not** DeepSeek models on OpenCode Go / 火山方舟 |
| Endpoint | `GET https://api.deepseek.com/user/balance` (origin root; strip `/v1` from stored base) |
| Auth | Bearer `api_key` from agent-home (or form draft) |
| UI | Settings → Custom providers **Check balance** (full lines); expanded-sidebar pin chip `110.00 CNY` when active |
| Cache | Session memory, 5 min TTL; refresh on UserMenu open / explicit button; no disk, no polling |
| Honesty | Never invent `0.00` on failure; amounts stay **strings** |

Wire shape (confirmed):

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

Future providers (Coding Plan quotas, etc.) add adapters under the same `providers_balance` command.

**Provider edits.** Upserts and CC Switch imports invalidate only chats that use an affected provider. Removal sends those chats to the official default and invalidates their warm process; unrelated chats stay connected. A busy turn finishes under its current process and applies the change on reconnect.

## Import from CC Switch (#167)

Settings → Account → Custom providers → **Import from CC Switch**.

| Step | Behavior |
|------|----------|
| Detect | Resolve `cc-switch.db` (see paths below); open SQLite **read-only** |
| Scope | `providers` where `app_type = 'grokbuild'` |
| Preview | Multi-select list (no full API keys; status badges) |
| Import | Map TOML → current agent-home `config.toml`; **same id overwrites** (no UI toggle); does not auto-activate route |
| Native capability | An explicit `app_provider_mode` is honored. Otherwise a Responses provider is promoted to `grok_build_proxy` only when its selected real model advertises `supports_backend_search = true` in the live `/models` response |
| Apply | Successfully imported provider ids invalidate only their routed chats; other sessions stay connected |

### CC Switch data paths (cross-platform)

| Priority | Location |
|----------|----------|
| 1 | `GROK_APP_CC_SWITCH_DIR` or `CC_SWITCH_HOME` env (if set and contains db) |
| 2 | Tauri Store override: `app_config_dir_override` in `app_paths.json` under `com.ccswitch.desktop` |
| 3 | **Default:** `{user_home}/.cc-switch/cc-switch.db` (macOS / Windows / Linux) |
| 4 | Windows only: `{HOME}/.cc-switch/cc-switch.db` when Profile default is missing (v3.10.3 legacy) |

Store file locations:

| OS | `app_paths.json` |
|----|------------------|
| macOS | `~/Library/Application Support/com.ccswitch.desktop/app_paths.json` |
| Windows | `%APPDATA%\com.ccswitch.desktop\app_paths.json` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/com.ccswitch.desktop/app_paths.json` |

Official CC Switch rows are not imported as custom relays. Proxy-takeover placeholders (`PROXY_MANAGED`, `127.0.0.1:…`) are rejected.
Capability detection never matches provider names or hosts. Explicit native mode
fails closed when the live catalog cannot validate it; implicit probe failures
preserve the previous generic import behavior.

## Security

- UI only sees `hasApiKey`.
- Logs must redact keys (existing redact paths).
- Official OAuth (`auth.json`) stays separate from relay keys.

## Sponsorship (L3, future)

Recommended catalog / paid naming sits **above** L2 as templates only. Keys always user-owned. See `docs/分析-Grok-Desktop对照报告.md` §7.
