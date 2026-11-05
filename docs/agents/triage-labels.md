# Triage labels

Internal Linear tickets use these five canonical roles. The label string equals the role
name; do not invent synonyms.

| Role | Label | Meaning |
|------|-------|---------|
| Needs triage | `needs-triage` | Incoming, not yet judged |
| Needs information | `needs-info` | Waiting on the reporter |
| Ready for agent | `ready-for-agent` | Scoped enough for an implementer agent to start |
| Ready for human | `ready-for-human` | Needs a human decision or manual verification |
| Won't fix | `wontfix` | Deliberately out of scope |

Spec issues and tracer-bullet tickets are published with `ready-for-agent` unless the
delivery instructions say otherwise.
