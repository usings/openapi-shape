# Testing

Read before choosing, writing, running, or reviewing tests, or changing or auditing agent instructions and loading rules. Use the [Workflow](00-workflow.md) for risk and acceptance criteria, and [Conventions](01-conventions.md) for repository commands, test placement, and fixtures.

## Choose useful evidence

- Test observable requirements at the smallest layer that exercises the relevant behavior. Add durable tests when they protect a requirement; avoid tests that merely restate implementation or cover reversible cosmetic edits.
- Name the failure the test should catch. Derive expected values independently from requirements, literals, or checked fixtures, never from the implementation or helpers being tested.
- Assert consumer-visible outcomes. Exact strings or bytes are appropriate when the format itself is required; avoid pinning private structure or incidental wording.
- For regressions, use a focused case that exposes the original failure where practical. Include relevant failure paths and boundary cases rather than expanding coverage by quota.
- Distinguish runtime behavior, type contracts, and output stability. Run a compiler for type assertions. Use snapshots for intentional output contracts, with compilation or behavioral checks for any additional claims.

## Exercise real behavior

Exercise semantics in the runtime that owns them; a Node test does not establish browser-specific behavior. Keep the component under test real and place doubles at slow or external boundaries. Preserve relevant return shapes, errors, and side effects. Prefer real components when maintaining a complex mock obscures the behavior.

Assert arguments, counts, or ordering when they are part of the component's contract, rather than merely proving a mock was present or called.

## Keep checks reliable

Reuse existing helpers and fixtures when they express the requirement clearly. Prefer explicit synchronization and controlled clocks to arbitrary sleeps. Ensure asynchronous checks terminate, and clean up streams, servers, timers, and temporary files. Isolate mutable test state so parallel runs do not interfere.

Keep purely test-specific setup and cleanup in test utilities. Production lifecycle methods should reflect resource ownership needed by the component.

Before finishing, consider a plausible wrong branch, missing effect, or incorrect argument and identify the assertion that would fail. Address meaningful gaps without adding redundant tests.

## Testing agent instructions

For prompts, skills, and agent guides, check conflicting obligations, instruction precedence, load triggers, and references. Verify the entry file makes conditional guidance reachable; do not assume arbitrary files are discovered automatically.

When consequential behavior justifies a trial, use a realistic task in fresh context with the required tools and permissions. Define pass criteria first and judge actions and outcomes against them. For loading changes, exercise the affected loading and authorization behavior. Attributing a fix requires baseline evidence that reproduces the failure. If a trial is unavailable or disproportionate, report static findings without claiming improved execution behavior. State runtime or environment limitations that affect the conclusion.
