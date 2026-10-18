# Domain Docs

How the engineering skills consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists: it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you are about to work in. Existing records: `0001-custom-stt-per-provider-keys`, `0002-composer-editor-kernel`, `0003-composer-document-position-editing`, `0004-composer-editor-dual-implementation`, `0005-pr-monitor-is-session-bound`. Number new records after the highest existing one.

If any of these files do not exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. Domain docs are created lazily, when terms or decisions actually get resolved.

`docs/llm-wiki/` is a different thing: it holds product rules for agents (i18n, dialogs, settings IA, release flow, …). Read it when your work touches those rules, and keep it updated per `AGENTS.md`. It is not the domain glossary.

## File structure

Single-context repo (this one — `pnpm-workspace.yaml` declares a single package):

```
/
├── CONTEXT.md
├── docs/
│   ├── adr/                  ← 0001 … 0005 today
│   └── llm-wiki/             ← product rules for agents
└── src/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (record it).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
