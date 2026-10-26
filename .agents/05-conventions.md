# Conventions

Read before changing or reviewing code, dependencies, tooling, generated output, or contract formats, and before running repository checks or release commands. These are project-specific policies.

- Release only when asked: pushing a `v*` tag publishes to npm; `pnpm release` creates one.
- Generated output is a public format; `--check` compares bytes. Assess risk by semantic and compatibility effects. Update `README.md` and `docs/` where documented behavior changes. Use a `!` commit if old output stops compiling or an old contract stops working.
- Contract format changes bump `CONTRACT_VERSION` in `src/shared/contract.ts`; the renderer uses that shared constant. Accept only that version; mismatches require regeneration with the installed package. Keep no historical readers or fixtures that assert support for old versions; test that unsupported versions are rejected.
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

For documentation or instruction-only changes, use the relevant content, link, example, and formatting checks. Run a focused file with `pnpm test --run --project=node tests/docs.spec.ts`, replacing the project and file for other tests.

## Test resources

- Reuse `tests/helpers/`: `tsc.ts` compiles snippets and removes generated `@ts-nocheck` by default, `tmp.ts` manages temporary files, and `browser.ts` owns cross-origin loopback HTTP fixtures and teardown. Keep native Fetch/Streams checks in their intended runtime.
- `tests/fixtures/` holds test inputs. The public documentation example lives in `docs/examples/petstore.yaml`; documentation and tests share that file.
- `tests/docs.spec.ts` compiles documentation examples, checks generated excerpts and local links/anchors, and uses `npm pack --dry-run --ignore-scripts` to verify linked resources ship. Keep public documentation resources inside the package's published files.
