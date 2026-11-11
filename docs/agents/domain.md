# Domain docs

How the engineering skills read this repo's domain documentation.

## Layout

Single-context repo: one `CONTEXT.md` at the root and decisions under `docs/adr/`.

```
/
├── CONTEXT.md        ← glossary of product / composer terms
├── docs/adr/         ← numbered architecture decision records
└── docs/llm-wiki/    ← product rules for agents (i18n, dialogs, composer, …)
```

## Before exploring

- Read `CONTEXT.md` for the vocabulary you should reuse.
- Read the ADRs that touch the area (`docs/adr/`), especially 0002–0004 for the composer and
  0006 for literal paste.
- For composer, i18n, dialog, and settings rules, read `docs/llm-wiki/` — `AGENTS.md` lists
  which page applies to which change.

Proceed silently if a file does not exist; the domain-modeling skill creates them lazily.

## Use the glossary

Name domain concepts exactly as `CONTEXT.md` defines them in issue titles, specs, ticket
bodies, ADRs, and test names. If a needed concept is missing, either you are inventing
language the project does not use, or there is a real gap worth recording.

## Flag ADR conflicts

If a change contradicts an existing ADR, say so explicitly instead of silently overriding
it, and name the ADR number.
