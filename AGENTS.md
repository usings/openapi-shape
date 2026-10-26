# Repository Guidelines

Scale work to risk, use judgment, and explain material deviations. Change these guidelines only when the task authorizes it.

## Always apply

- Stay within the authorized objective; make routine implementation decisions autonomously and ask about material unresolved decisions.
- For an audit-only request, report findings without editing. Release only when explicitly requested.
- Verify the result and report material limitations.

## Load guidance by task

Start with Workflow for changes and assessments. Load only applicable guides; before the relevant work, read every additional guide whose trigger matches the task. When scope or risk changes, load newly applicable guides. Within the current context, reread a guide only when it has changed, its contents are no longer available, or a specific clause needs checking.

Keep guide reads separate from large source or search outputs so the guidance remains visible. If output is truncated, read the missing portion before relying on it.

The list runs from general guidance to specialized tasks. Numbers aid navigation, not instruction precedence. Paths are relative to this file.

| When                                                                                                                                 | Read                                              |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Planning, implementing, or reviewing changes; assessing existing work                                                                | [00 — Workflow](.agents/00-workflow.md)           |
| Changing or reviewing code, dependencies, tooling, generated output, or contracts; before repository checks or releases              | [01 — Conventions](.agents/01-conventions.md)     |
| Choosing, writing, running, or reviewing tests; changing or auditing agent instructions or loading rules                             | [02 — Testing](.agents/02-testing.md)             |
| In-depth reviews, High risk, complex compatibility or recovery, or blocked verification                                              | [03 — Review](.agents/03-review.md)               |
| Designing or reviewing module interfaces, responsibility boundaries, or dependency direction; architecture refactoring or assessment | [04 — Architecture](.agents/04-architecture.md)   |
| Writing, editing, or auditing reader-facing documentation                                                                            | [05 — Documentation](.agents/05-documentation.md) |
| Before delegating or coordinating parallel work                                                                                      | [06 — Subagents](.agents/06-subagents.md)         |

Keep Workflow project-agnostic. Repository-specific commands and policies belong in Conventions. Keep detailed rules in their owning guide and update this index when triggers or paths change.
