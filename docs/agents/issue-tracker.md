# Issue Tracker

Issues for this repo live in **Linear**, read and written through the Linear MCP server (`linear__*` tools). There is no GitHub/`gh` issue workflow here; PRs are not a request surface.

## Where things live

- **Team**: `Boring Link` (key `BOR`) — matches the `origin` remote (`BoringLink/grok-app`).
- **Project**: delivery work is filed under the existing project **`Grok App`** (`P-BOR-3`). One requirement is delivered at a time; do not create a second project for the same product.
- **Shape of a delivery**: one parent issue carrying the Spec, with the tracer-bullet tickets as its **sub-issues**.
- **Blocking**: express dependencies with Linear's native `blockedBy` relation, created after the blocking issue exists. Never encode "blocked by" only in prose.

## Status mapping

Map skill vocabulary to Linear state **by statusType**, never by hardcoded names:

| Skill says | Linear statusType | Status in BOR today |
| --- | --- | --- |
| 未开始 / not started | `unstarted` | `Todo` |
| 进行中 / in progress | `started` | `In Progress` |
| 待评审 | `started` | `In Review` |
| 已完成 / done | `completed` | `Done` |

Use `linear__list_issue_statuses` before setting a state; the statuses above are what the team has today, not a contract.

## Labels

Issue labels follow `docs/agents/triage-labels.md`. Read that file before applying a triage label. Type labels used in this team: `Feature`, `Improvement`, `Bug`.

## Notes

- Field limits: Linear mutations take string content directly, with real newlines rather than `\n` escapes.
- A stuck ticket goes back with a comment (`linear__save_comment`) describing what was tried; do not silently skip it or widen its scope.
