# Workflow

Use this guide when planning, making, or reviewing changes, or assessing existing work. Keep it project-agnostic; project-specific commands and policies belong in the repository's conventions.

**Model → Implement → Test → Simplify → Attack → Verify**, scaled to risk. These are thinking steps, not required report sections. Iterate as needed. For review-only tasks, assess the applicable steps and report findings; implement or fix only when authorized.

## 0. Level

Classify by actual behavior, impact, and recovery cost, not edit size or file type. Instructions an agent follows are behavior. Reassess when the scope or evidence changes. The user's requested depth wins.

- **Light** — no behavior change, such as formatting or prose edits that do not alter operational guidance. Implement → Verify.
- **Standard** — a bounded behavior change without High risks. Use all steps; Attack may be a self-check.
- **High** — substantial failure consequences, difficult recovery, or broad impact, such as changes to security or privilege boundaries, breaking public or persisted contracts, destructive operations, or architecture changes with broad effects. Use all steps and independent review when available and permitted by current instructions; otherwise disclose the limitation and strengthen self-checks.

Resolve uncertainty through focused investigation where practical; use greater depth when consequential uncertainty remains.

## 1. Model

Establish the observable objective, constraints, affected behavior, and acceptance criteria. Treat existing code, tests, and documentation as evidence, not unquestionable truth. For bug fixes, identify the failure mechanism. Trace relevant inputs and consumers; investigate as widely as necessary while keeping the edit scope focused.

Within the task's requirements, prefer **correctness → simplicity → reversibility → consistency**.

## 2. Implement

Make the change needed for the authorized objective while preserving required behavior and compatibility. Avoid unrelated cleanups. Make routine decisions autonomously; ask when a material product, compatibility, or irreversible-action decision remains unresolved by the instructions.

For broad changes or migrations, sequence work into units with observable acceptance checks. Verify each unit before building dependent changes on it; choose units by behavior rather than individual edits. Verify the integrated result afterward.

## 3. Test

Define pass criteria and choose evidence capable of exposing failures in the changed behavior. Use [Testing](02-testing.md) for test design; evidence may also include structural checks, direct inspection, or realistic walkthroughs.

## 4. Simplify

Add abstractions, dependencies, configuration, or compatibility paths only for a present need. Remove unnecessary branches, state, indirection, and duplication introduced or exposed by the change without sacrificing clarity or correctness.

When the same correction recurs, prefer an enforceable type, check, or structural constraint over another instruction, within the authorized scope. Keep prose for decisions that still require judgment; avoid maintaining the same rule in multiple forms without a distinct purpose.

## 5. Attack

Challenge the model with plausible failures. Use [Review](03-review.md) for in-depth or High-risk work. A blocking finding needs a concrete regression, unmet requirement, or specific reason the required result cannot be established; distinguish other concerns as notes. Surface risks promptly if they could change the user's next decision.

### Fixing

Address blocking findings at their cause. Re-check fixes for regressions, add repeatable regression coverage where suitable, and reassess their risk. Apply this to every additional edit, including fixes to non-blocking notes. When fixes repeatedly fail, identify their shared premise and test an observation that could disprove it before making another fix based on it. Revisit the design when evidence contradicts its assumptions or patches accumulate exceptions. Ask the user if this exposes an unresolved decision or scope change.

## 6. Verify

Verify the final integrated result. Use focused checks when effects can be bounded and broader checks when they cannot. Checks cover the state examined: repeat affected tests and reviews after edits, and reuse results only while their inputs and dependencies remain unchanged.

Report the change or review findings, checks and results, compatibility effects, material notes, and residual risks or unverified assumptions. Distinguish checks that passed, failed, were not run, or were blocked.
