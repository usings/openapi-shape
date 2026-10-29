# Subagents

Read before delegating to subagents or coordinating parallel work.

Delegate only when current instructions and permissions allow it, independent judgment or parallel work justifies the coordination cost, and the tools support it. Tool availability alone is not authorization. Give each agent a bounded objective, relevant context, constraints, and expected evidence, while allowing inspection of related paths to test its assumptions. Provide the applicable guidance or direct it to read the relevant guides; do not assume it inherits the coordinator's loaded context.

Before dispatch, assess task complexity, uncertainty, and the consequences of error. Where supported and permitted, explicitly select a reasoning effort appropriate to the task. Otherwise, retain the tool's default or inherited setting. Do not assume prompt wording changes the configured effort.

Avoid concurrent edits to the same file in one working tree; use disjoint files or separate worktrees. Share interface assumptions before dispatch. Have agents return their changes, checks, findings, and unresolved assumptions.

The coordinator owns integration, cross-slice interactions, and verification of the combined result. Reassess the combined change's risk and repeat checks affected by integration.
