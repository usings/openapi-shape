# Conventions

Read before changing or reviewing code, dependencies, tooling, generated output, or contract formats, and before running repository checks or release commands. These are project-specific policies.

- Release only when asked: pushing a `v*` tag publishes to npm; `pnpm release` creates one.
- Follow **Web Standards First**: prefer native Web APIs and preserve their body consumption, cancellation reasons, backpressure, and resource ownership semantics. Introduce wrappers or custom behavior for a concrete need and explain any semantic differences.
- Generated output is a public format; `--check` compares bytes. Assess compatibility against the latest published version and any explicitly supported artifacts. Use a `!` commit when a change breaks that baseline. Update `README.md` and `docs/` where documented behavior changes.
- Assign a new contract version when the published format changes; unpublished iterations normally reuse the assigned version and do not automatically become supported historical formats. If intermediate artifacts must remain supported, reassess the version boundary rather than adding historical readers.
- Generator and client share `CONTRACT_VERSION` in `src/shared/contract.ts`. Accept only the current version; mismatches require regeneration with the installed package. Test that unsupported versions are rejected; keep no historical readers or fixtures that assert support for old versions.
- Update `tests/fixtures/output/` (`-u`) only for intended output changes; summarize meaningful before/after differences.
- `pnpm lint` omits `--type-aware`; a pass does not establish compliance with type-aware rules in `.oxlintrc.json`. For relevant code changes, use an executable check where available or targeted review, and report material gaps in coverage.

## Source and type design

- Keep `src/core/` flat. Choose files by coherent responsibility; avoid forwarding-only modules.
- Prefer TypeScript built-ins and local mapped types. Reuse or add type utilities for a demonstrated semantic benefit, not merely to reduce syntax. Keep general client type utilities in `src/client/types/utils.ts` and domain rules in their owning modules.
- Check union distribution, optional properties, and generic forwarding when changing inference. Object-literal calls alone do not establish that constraints survive composition.
- Keep static media selection consistent with runtime behavior. Opaque inputs such as `Headers` or a broad `string` must not imply a definite media type without supporting static information.

## Commits

Inspect the current diff and staged scope before committing; preserve user changes and split commits by independently explainable and verifiable intent. Commit, push, release, and history rewriting each require authorization for that action; honor authorization already established in the task or session without asking again. Formatting hooks can change staged content; inspect the resulting commit and remaining working tree afterward.

## Verification commands

Install missing dependencies with `pnpm install`. Before browser tests, read the instances configured in `vitest.config.ts` and install missing engines with `pnpm exec playwright install <engines>`; Linux CI can add `--with-deps` when needed. The browser target is Chromium; keep the matrix in that config and do not expand it without an authorized requirement.

| Command             | Coverage                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`       | Runtime tests, root type checking, both static type configurations, lint, and formatting.                      |
| `pnpm test:node`    | Node tests (`*.spec.ts`): generation, CLI/filesystem behavior, compiler checks, and Node-specific integration. |
| `pnpm test:browser` | Browser tests (`*.browser.ts`): client and Web-platform behavior in the configured engines.                    |
| `pnpm typecheck`    | Source and tests included by the root TypeScript config; excludes `tests/types/`.                              |
| `pnpm test:types`   | Static assertions in `tests/types/`, in baseline and strict optional/index modes.                              |

Run `pnpm verify` when a code change has broad effects or its impact cannot be bounded. For bounded changes, run affected tests and relevant type, lint, and formatting checks; explain the chosen scope.

Run `pnpm test:types` when changing client public types, overloads, generic defaults, or type utilities. Also run related generated-consumer tests when generated declarations and the client interact. Runtime test passes and commit hooks do not replace these checks; the current hook's root type check excludes `tests/types/`.

For documentation changes, choose relevant content and formatting checks. `pnpm test --run --project=node tests/documentation/docs.spec.ts` compiles examples, checks generated excerpts and local links/anchors, and verifies published resources with `npm pack --dry-run --ignore-scripts`. It covers `README.md` and top-level Markdown pages in `docs/`, not `AGENTS.md` or `.agents/`. Keep public documentation resources inside the package's published files.

For instruction-only changes, follow [Testing — Testing agent instructions](02-testing.md#testing-agent-instructions), check affected references and formatting, and report the limits of static review or task trials.

## Test resources

- Before reorganizing tests, read [the coverage map and organization conventions](../tests/README.md), which also describes shared test helpers.
- Documentation and tests share the public example in `docs/examples/petstore.yaml`.
