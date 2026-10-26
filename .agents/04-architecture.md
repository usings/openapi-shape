# Architecture

Read before designing or reviewing module interfaces, responsibility boundaries, or dependency direction, and for architecture refactoring or assessment. Apply these design criteria within the [Workflow](00-workflow.md); keep investigation proportional to the task.

## Design useful modules

- A **module** is anything with an interface and implementation: a function, class, file, package, subsystem, or feature slice spanning layers. Its scope follows a coherent responsibility, independent of language constructs or directory layout. Its **interface** includes everything callers must understand: types, invariants, ordering, errors, configuration, and relevant performance constraints.
- Prefer **deep modules**: substantial behavior behind an interface that is simple to learn and use. Judge depth by complexity removed from callers, not implementation size. Seek **locality**, so related knowledge, changes, and verification stay together.
- A **seam** allows behavior to vary behind an interface; an **adapter** supplies an implementation there. Add seams for demonstrated variation or an external dependency that needs isolation, rather than hypothetical alternatives. Keep internal composition private where callers do not need it.
- Apply the **deletion test**: if removing a module removes only forwarding or ceremony, consider removing it; if complexity spreads into callers, the module provides useful encapsulation. File count and file length alone do not establish a problem.
- Test meaningful behavior through the interface callers use. Prefer explicit dependencies and returned values where they clarify ownership; avoid exposing internals or fragmenting cohesive behavior merely to make isolated tests easy.

## Find improvements from evidence

- Start with the user's named area or pain point. For an open architecture assessment, choose promising areas from available evidence, such as reported friction, current code and tests, or recurring changes. Consult Git history when it helps locate or explain a problem; it is an optional source, not a required scan.
- Read existing domain documentation and relevant design decisions where available. Preserve established terminology; explain concrete evidence before recommending that a recorded decision be revisited.
- Trace representative behavior through callers, implementations, dependencies, and tests. Look for concepts scattered across files, repeated caller orchestration, leaked implementation details, tightly coupled modules, and tests that miss failures in their collaboration. Treat these as investigation leads, not automatic reasons to refactor.
- For each worthwhile candidate, identify affected files, observed friction, proposed responsibility changes, expected improvement in locality and caller simplicity, test implications, costs, and confidence. Distinguish supported recommendations from speculation and explain the priority. Use a before/after diagram when it clarifies the relationships.

## Carry the design through safely

Check proposed responsibility and dependency changes against actual consumers. Keep required public behavior and compatibility explicit, including errors and resource ownership. A private reorganization does not by itself justify a public contract change. Use [Conventions](01-conventions.md) for repository-specific contract and verification policies.

Use [Testing](02-testing.md) to verify preserved behavior and the interaction that motivated the change. Retain useful coverage; change tests tied to superseded internals only when equivalent behavioral evidence remains.
