# Conventions

Read before changing or reviewing code, dependencies, tooling, generated output, or contract formats, and before running repository checks or release commands. These are project-specific policies.

- Release only when asked: pushing a `v*` tag publishes to npm; `pnpm release` creates one.
- Follow **Web Standards First**: prefer native Web APIs and preserve their body consumption, cancellation reasons, backpressure, and resource ownership semantics. Introduce wrappers or custom behavior for a concrete need and explain any semantic differences.
- Generated output is a public format; `--check` compares bytes. Assess risk by semantic and compatibility effects. Update `README.md` and `docs/` where documented behavior changes. Use a `!` commit if old output stops compiling or an old contract stops working.
- Assess contract format changes against the latest published format. Assign a new version when that format changes; unpublished iterations normally reuse the assigned version. If intermediate artifacts must remain supported, reassess the version boundary rather than adding historical readers.
- Generator and client share `CONTRACT_VERSION` in `src/shared/contract.ts`. Accept only the current version; mismatches require regeneration with the installed package. Test that unsupported versions are rejected; keep no historical readers or fixtures that assert support for old versions.
- Update `tests/__snapshots__/` (`-u`) only for intended output changes; summarize meaningful before/after differences.
- `pnpm lint` omits `--type-aware`; a pass does not establish compliance with type-aware rules in `.oxlintrc.json`. For relevant code changes, use an executable check where available or targeted review, and report material gaps in coverage.

## Verification commands

Install missing dependencies with `pnpm install`. Before browser tests, read the instances configured in `vitest.config.ts` and install missing engines with `pnpm exec playwright install <engines>`; Linux CI can add `--with-deps` when needed. Keep the browser matrix in that config.

| Command             | Coverage                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify`       | All configured tests, type checking, lint, and formatting.                                                                   |
| `pnpm test:node`    | Node tests (`*.spec.ts`): generation, CLI/filesystem behavior, compiler checks, and Node-specific integration.               |
| `pnpm test:browser` | Browser tests (`*.browser.ts`): client and Web-platform behavior in the configured engines.                                  |
| `pnpm typecheck`    | Compile-time assertions, including `expectTypeOf` and `@ts-expect-error`; a passing test run alone does not establish these. |

Run `pnpm verify` when a code change has broad effects or its impact cannot be bounded. For bounded changes, run affected tests and relevant type, lint, and formatting checks; explain the chosen scope.

For documentation changes, choose relevant content and formatting checks. `pnpm test --run --project=node tests/docs.spec.ts` compiles examples, checks generated excerpts and local links/anchors, and verifies published resources with `npm pack --dry-run --ignore-scripts`. It covers `README.md` and top-level Markdown pages in `docs/`, not `AGENTS.md` or `.agents/`. Keep public documentation resources inside the package's published files.

For instruction-only changes, follow [Testing — Testing agent instructions](02-testing.md#testing-agent-instructions), check affected references and formatting, and report the limits of static review or task trials.

## Test resources

- Before reorganizing tests, read [the coverage map and organization conventions](../tests/README.md), which also describes shared test helpers.
- Documentation and tests share the public example in `docs/examples/petstore.yaml`.
