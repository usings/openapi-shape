# Repository Guidelines

Scale work to risk, use judgment, and explain material deviations. Change these guidelines only when the task authorizes it.

## Always apply

- Stay within the authorized objective; make routine implementation decisions autonomously and ask about material unresolved decisions.
- For an audit-only request, report findings without editing. Release only when explicitly requested.
- Verify the result and report material limitations.

## Load guidance by task

Before acting, explicitly read the guides matching the task. Load all applicable guides, not the whole directory. Reassess when scope or risk changes. Paths are relative to this file; numbers identify guides, not reading order.

| When                                                                                                             | Read                                              |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Planning, making, or reviewing a change                                                                          | [00 — Workflow](.agents/00-workflow.md)           |
| Choosing, writing, running, or reviewing tests; changing or auditing agent instructions or loading rules         | [01 — Testing](.agents/01-testing.md)             |
| In-depth reviews, High risk, complex compatibility or recovery, or blocked verification                          | [02 — Review](.agents/02-review.md)               |
| Writing, editing, or auditing reader-facing documentation                                                        | [03 — Documentation](.agents/03-documentation.md) |
| Delegating or coordinating parallel work; before dispatch                                                        | [04 — Subagents](.agents/04-subagents.md)         |
| Changing or reviewing code, dependencies, tooling, generated output, or contracts; repository checks or releases | [05 — Conventions](.agents/05-conventions.md)     |

Keep Workflow project-agnostic. Repository-specific commands and policies belong in Conventions. Keep detailed rules in their owning guide and update this index when triggers or paths change.
