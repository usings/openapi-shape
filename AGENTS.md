# Repository Guidelines

This file serves you, the agent: how much process a change is worth, and how to check it. Where it does not fit the case, use judgment; where it is wrong or in the way, change it and say so. Keep it project-agnostic: toolchain specifics live in Code Conventions, project specifics elsewhere.

## Change Workflow

**Model → Implement → Test → Simplify → Attack → Verify**, scaled to risk, in one pass over the whole delta. Implement, Test, and Simplify are the build loop, repeated freely. Attack and Verify are gates over the finished delta; each judges one fixed state of it, so a gate that takes a while runs on a snapshot (a commit, a worktree, a copy) while work goes on, and its findings are read against that snapshot. What the gates find goes through _Fixing_, and Verify always comes last, as the proof of the final state.

Anything worth telling the user but not worth acting on now is a **note**, for the report (Verify). A risk you notice and keep goes to the user when you see it if it could change what they decide next.

### 0. Level

Classify by the riskiest thing the delta _changes_, not the area or size of the edit. Instructions an agent follows (prompts, skills, agent docs) are behavior.

- **Light** — no behavior change: formatting, renames, mechanical edits, docs nothing acts on. Implement → Verify.
- **Standard** — a local behavior change, nothing under High. All steps; Attack is a self-check.
- **High** — changes the semantics of a trust boundary, authentication or privilege, a persisted or published format, the public contract, writes to data the code does not own, destructive operations, state and ordering, or broad architecture. All steps; Attack is an independent review.

When unsure, go higher; the user's call on depth wins. Level again from the actual delta before the gates, and if it rose, first do what the new level adds.

### 1. Model

Reason from the externally observable objective; existing code, tests, and behavior are evidence, not truth. Standard needs the intended behavior, root cause, and preserved behavior; High adds invariants, trust boundaries, compatibility, and which facts are verified versus assumed.

Gather evidence in proportion to the decision it serves: instruments, counts and samples first, a full read only where a sample cannot answer (how a whole reads, what it never does), and nothing past the delta's boundary unless the evidence shows the behavior crossing it.

Prefer **correctness → simplicity → reversibility → consistency**.

### 2. Implement

Make the change the objective needs, at whatever size: rework a design, delete a module, or break a format when that is the right shape. Unrelated cleanups stay out of the delta, as notes. A change that adds an exception, a user-visible option, or alters a stated rule is a decision, even inside a fix: take it to the user before making it.

### 3. Test

Test observable behavior, as often as it helps:

- **Code**: focused regression coverage and the failure paths that could violate the objective.
- **Persisted or published formats**: what the change can break: existing data, partial application, recovery, stale artifacts, old/new compatibility.
- **Instructions an agent follows**: their behavior is an agent following them, which unit tests reach only in structure. Give a fresh agent the smallest realistic task that exercises the change, with the instructions and nothing else, and treat what it trips on as findings. State the pass criterion before the run and report against it as stated; a criterion relaxed after the result is a failed run. A trial earns its cost only if it could fail: when the change claims to fix a failure, first run the old instructions once on the same task, and if they do not fail, report that the trial cannot show the fix instead of running more. Repeat a run only when one left the answer unclear.

### 4. Simplify

Add abstractions, dependencies, configuration, or compatibility paths only for a present need, and remove the branches, state, indirection, or duplication the change introduced or exposed, within the delta, without losing clarity or correctness.

### 5. Attack

Try to build one failing case rather than confirm the change works: input outside the assumed alphabet, size, or shape; an empty or missing collection; a stale artifact; a boundary crossed through an alias; a resource readable but not writable; a second run of something assumed to run once.

- **Standard**: a self-check, one or two attempts.
- **High**: one independent reviewer given only the delta, the objective, and the invariants, so it tests the author's assumptions instead of inheriting them.

A finding blocks only with a concrete input or state that violates the objective or an invariant; everything else, including problems outside the delta, is a note. Reviewers report findings; the author fixes them. A change made after Attack that no reviewer has seen, other than a fix under _Fixing_, gets the Attack its own level calls for.

#### Fixing

Blocking findings, from Attack, a trial, or a failed Verify, are patched in place:

1. Collect the findings first, then fix each blocking one at the root with a regression test (a failing Verify test already is one), changing only what it needs.
2. Re-check each fix: does it resolve its finding, and does it break a case its parent handled? A case the parent misses too is a note, unless it violates the objective. At Standard you re-check it yourself; at High a reviewer gets the finding, the fix's diff, and this bar, and nothing more. A fix that fails is patched and re-checked once more. A note you choose to fix needs only Verify.
3. Verify.

The change has the wrong shape when a finding needs more than a patch, a fix fails its second re-check, or a second finding turns up in the same mechanism: rework that part as a new pass, replacing the mechanism with a simpler one that has fewer cases (record instead of measure, flag instead of parse), not a smarter one. If the rework fails too, take it to the user; the objective likely needs a decision.

### 6. Verify

The final delta must pass lint on the changed files and the tests covering what it can reach, or the full suite when that reach is broad or cannot be bounded. A passing result stands until something it depends on is edited, so reuse earlier results and run only what later edits can affect. Compilation or a happy path is not verification.

A failure the delta caused is a blocking finding for _Fixing_; one it did not cause is a note.

Finish with the report: what was verified, what the delta breaks, the notes, and any residual risk or unverified assumption.

### Subagents

An agent costs a full context: it loads its instructions, then reads everything it is given, and resuming it reloads all of that, so a small follow-up is often cheaper as a fresh agent given only what it needs. Start one when its answer can change a decision and nothing cheaper can get it (a tool, a count, a search, a sample you read yourself); give it the narrowest question and only the inputs that answer it. Size a fan-out by what it decides, not by what it could turn up.

A split task is still one pass over the combined delta. No two agents edit the same file in the same working tree at once: slices get disjoint files in a shared tree, or separate worktrees when they need the same files. The coordinator levels and models the task before dispatch and gives each slice its objective, files, invariants, and the interfaces it shares; each comes back with its diff, the tests it ran, and its assumptions about the others. The coordinator then adds what only the combination shows (its references, tests, simplifications) and runs the gates as the author, since only it sees every finding.

## Code Conventions

Only what scanning the repo would miss.

- Run `pnpm verify` for tests, type checking, lint, and formatting.
- Release only when asked: pushing a `v*` tag publishes to npm; `pnpm release` creates one.
- Generated output is a public format; `--check` compares bytes. Changes are High and update `README.md` and `docs/` together. Use a `!` commit if old output stops compiling or an old contract stops working.
- Contract format changes bump `version` in the renderer and `src/shared/contract.ts`. Accept only that version; mismatches require regeneration with the installed package. Keep no historical readers or compatibility fixtures.
- Update `tests/__snapshots__/` (`-u`) only for intended output changes; report before/after.
- Extensionless `src` imports cannot run directly in Node. Use `pnpm build`, then `node dist/cli.mjs <doc> -o <tmp>/out.ts`.
- oxlint omits `--type-aware`; check those rules in `.oxlintrc.json` manually.
