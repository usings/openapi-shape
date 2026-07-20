# Repository Guidelines

## Project Structure & Module Organization

Source code lives in `src/`. Public entry points are `src/index.ts`, `src/client.ts`, and `src/cli.ts`; bundling emits their ESM packages to `dist/`. Most implementation code is grouped under `src/core/`: OpenAPI parsing and normalization in `openapi/`, contract modeling in `contract/`, declaration rendering in `declarations/`, and reusable utilities in `shared/`.

Tests mirror the source layout under `tests/`. Shared test helpers are in `tests/_helpers/`, OpenAPI samples are in `tests/fixtures/`, and generated-output snapshots are in `tests/__snapshots__/`.

## Build, Test, and Development Commands

Use Node.js 22 or newer and pnpm 11 (the pinned package manager).

- `pnpm install` installs dependencies and configures Lefthook hooks.
- `pnpm build` bundles all public entry points with tsdown into `dist/`.
- `pnpm test` starts Vitest in watch mode; `pnpm test --run` runs the suite once in non-watch mode.
- `pnpm typecheck` checks strict TypeScript types without emitting files.
- `pnpm lint` runs oxlint across the project.
- `pnpm format` applies oxfmt formatting.

Before submitting changes, run `pnpm test --run`, `pnpm typecheck`, and `pnpm lint`.
Lefthook also formats, lints, and type-checks relevant staged TypeScript or JavaScript files before each commit; tests are not part of this hook.

## Coding Style & Naming Conventions

Follow the existing TypeScript style: two-space indentation, double quotes, no semicolons, and trailing commas in multiline constructs. Let oxfmt resolve formatting rather than hand-aligning code. Use `camelCase` for functions and variables, `PascalCase` for types and interfaces, and descriptive kebab-case filenames such as `schema-ref.ts`. Keep modules focused and place new core logic in the matching `src/core/` area.

## Testing Guidelines

Tests use Vitest and follow the `*.test.ts` convention. Add focused unit tests beside the corresponding mirrored area (for example, `src/core/openapi/walk.ts` maps to `tests/core/openapi/walk.test.ts`). Reuse fixtures when possible. Update snapshots only when declaration output changes intentionally, and review the diff before committing. No numeric coverage threshold is configured; cover new behavior and regressions directly.

## Commit & Pull Request Guidelines

Commitlint enforces Conventional Commits. Keep commits scoped and imperative. Pull requests should explain the motivation and user-visible effect, link relevant issues, and list verification commands. Include before/after generated output for declaration-shape changes; screenshots are generally unnecessary for this CLI/library project.
