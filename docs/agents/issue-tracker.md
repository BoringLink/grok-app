# Issue tracker: Linear (via MCP)

Internal orchestration for this repo lives in Linear. Read and write it with the Linear MCP
tools (`linear__*`), not by hand.

## Workspace conventions

- Team: **Boring Link** (`BOR`).
- **One requirement = one Linear Project.** Reuse a Project only when its name and summary
  already describe the same requirement; otherwise create one.
- Each Project holds one parent **Spec** issue. Tracer-bullet tickets are its sub-issues.
- Blocking edges use Linear's native `blockedBy` relation. Never encode a blocker as prose in
  the description.
- Status changes go through `linear__list_issue_statuses` and the returned `statusType`
  (`unstarted` / `started` / `completed`). Do not hardcode status names.
- Labels come from `docs/agents/triage-labels.md`.

## Public (upstream) record

This checkout is the fork `BoringLink/grok-app`; the upstream project is
`RongleCat/grok-app`, where the fork owner has read-only access. Public issues and pull
requests therefore live upstream, driven with `gh --repo RongleCat/grok-app`.

- **Search first**: `gh issue list --repo RongleCat/grok-app --search "<error text / feature name>" --state all`.
- **Create** with the repo's issue template and title convention; the body states problem,
  environment/version, reproduction, expected vs actual, approach, and blast radius.
- **Register** the upstream issue number in the parent Linear Spec issue description. Linear
  stays the internal record; the upstream issue is the public one.
- **One upstream issue per pull request.** Bind it in the PR body with `Closes #<n>` and
  verify with `gh pr view <n> --json closingIssuesReferences`.

## Fetching an issue

- Linear ticket: `linear__get_issue` with the identifier (for example `BOR-123`).
- Upstream issue: `gh issue view <n> --repo RongleCat/grok-app --comments`.
