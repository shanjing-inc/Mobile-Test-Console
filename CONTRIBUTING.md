# Contributing

Mobile Test Console accepts focused changes that keep the platform core independent from any application repository.

## Development setup

1. Install Node.js 18.20 or newer and pnpm 10.
2. Run `pnpm install --frozen-lockfile`.
3. Run `pnpm dev` to start the project catalog without loading an application.
4. Run `pnpm check` before opening a pull request.

## Project boundaries

- Platform scheduling, device discovery, task state, schema validation, and result analysis belong in `src/`.
- Application build commands, page IDs, routes, account semantics, and raw-result conversion belong in the application configuration, Runner, and Project Provider.
- Public contract changes require a schema version review, compatibility tests, and an update to `docs/versioning.md`.
- Generated schemas come from the Zod owners in `src/server/config.ts` and `src/shared/result-bundle.ts`. Run `pnpm schema:generate` after changing either contract.

## Pull requests

- Keep commits scoped to one behavior or contract change.
- Add regression coverage for bug fixes and contract coverage for new fields.
- Include migration notes when a project configuration or plugin needs an update.
- Keep logs, fixtures, and examples free of credentials, account data, and local absolute paths.

By contributing, you agree that your contribution is licensed under the MIT License.
