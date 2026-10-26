# Review

Read for in-depth reviews and as soon as a High-risk change, complex compatibility or recovery work, or blocked verification is identified. It adds depth to the [Workflow](00-workflow.md), not a second workflow.

## Establish the risk model

Separate verified facts, assumptions, and explicitly authorized exceptions. Identify relevant invariants, input producers and consumers, trust boundaries, and compatibility or recovery obligations. Inspect beyond edited files to establish how the changed behavior can be reached.

Do not mistake an example, test, or current implementation for the entire public contract. Check old data and old clients when their continued support is required; check deliberate rejection when it is not.

## Choose failure-oriented checks

Prioritize cases that could violate the objective or a relevant invariant:

- Absent, empty, malformed, oversized, or otherwise unexpected inputs that a relevant producer or actor can supply.
- Repeated operations, retries, duplicates, partial completion, interruption, and restart.
- Stale caches or generated artifacts; old/new version mismatches; partial migrations and recovery.
- Reads that succeed where writes fail; permission changes; indirect or aliased paths across a trust boundary.
- Ordering and state transitions across components, especially where an operation was assumed to happen only once.

Select checks that establish the required behavior; a passing build or happy path covers only the claims it actually exercises.

## Independent review

For independent review, supply the reviewer with the objective, change, constraints, invariants, input sources, and known assumptions, along with access to supporting evidence. Ask the reviewer to challenge the author's model and inspect omitted paths. The reviewer identifies findings; the author owns authorized repairs and integration.

For concurrent work, a snapshot, commit, or separate worktree can preserve the reviewed state.

## Evidence and blocked verification

Support findings with a reproducible case or a specific causal explanation, including the reachable input or state. Check whether the stated trust model or input sources omit a relevant actor or path before dismissing a case as hypothetical.

Pre-existing failures are not automatically in scope, but they may prevent acceptance or verification. Establish whether an in-scope repair is needed or the result remains unverified. Identify which claims the missing evidence prevents establishing.
