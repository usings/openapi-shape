# Workflow

Use this guide when planning, making, or reviewing changes, or assessing existing work. Keep it project-agnostic; project-specific commands and policies belong in the repository's conventions.

**Model → Implement → Test → Simplify → Attack → Verify**, scaled to risk. Iterate as needed. For review-only tasks, assess the applicable steps and report findings; implement or fix only when authorized.

## 0. Level

Classify by actual behavior, impact, and recovery cost, not edit size or file type. Instructions an agent follows are behavior. Reassess when the scope or evidence changes. The user's requested depth wins.

- **Light** — no behavior change, such as formatting or prose edits that do not alter operational guidance. Implement → Verify.
- **Standard** — a bounded behavior change without High risks. Use all steps; Attack may be a self-check.
- **High** — substantial failure consequences, difficult recovery, or broad impact, such as changes to security or privilege boundaries, breaking public or persisted contracts, destructive operations, or architecture changes with broad effects. Use all steps and independent review when available; otherwise disclose the limitation and strengthen self-checks.

Resolve uncertainty through focused investigation where practical; use greater depth when consequential uncertainty remains.

## 1. Model

Establish the observable objective, constraints, affected behavior, and acceptance criteria. Treat existing code, tests, and documentation as evidence, not unquestionable truth. For bug fixes, identify the failure mechanism. Trace affected behavior through inputs and consumers, checking relevant invariants, boundaries, and compatibility. Investigate as widely as necessary, but keep the edit scope focused.

Within the task's requirements, prefer **correctness → simplicity → reversibility → consistency**.

## 2. Implement

Make the change needed for the authorized objective while preserving required behavior and compatibility. Avoid unrelated cleanups. Make routine decisions autonomously; ask when a material product, compatibility, or irreversible-action decision remains unresolved by the instructions.

## 3. Test

Choose checks capable of exposing failures in the changed behavior, including relevant boundaries and failure paths. Use the appropriate evidence: automated tests, compilation, structural checks, direct inspection, or realistic walkthroughs. For published or persisted artifacts, examine affected compatibility, partial-application, recovery, and stale-data cases. Define pass criteria before testing.

## 4. Simplify

Add abstractions, dependencies, configuration, or compatibility paths only for a present need. Remove unnecessary branches, state, indirection, and duplication introduced or exposed by the change without sacrificing clarity or correctness.

## 5. Attack

Challenge assumptions rather than merely confirm success. Probe unexpected inputs, boundary cases, and repeated or interrupted work. Scale review to risk. A blocking finding needs a concrete regression, unmet requirement, or specific reason the required result cannot be established; distinguish other concerns as notes. Surface risks promptly if they could change the user's next decision.

### Fixing

Address blocking findings at their cause. Re-check fixes for regressions, add repeatable regression coverage where suitable, and reassess their risk. Apply this to every additional edit, including fixes to non-blocking notes. Revisit the design when patches repeatedly fail or accumulate exceptions. Ask the user if this exposes an unresolved decision or scope change.

## 6. Verify

Verify the final integrated result. Use focused checks when effects can be bounded and broader checks when they cannot. Checks cover the state examined: repeat affected tests and reviews after edits, and reuse results only while their inputs and dependencies remain unchanged.

Report the change or review findings, checks and results, compatibility effects, material notes, and residual risks or unverified assumptions. Distinguish checks that passed, failed, were not run, or were blocked.
