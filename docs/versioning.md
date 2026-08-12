# Versioning and compatibility

Mobile Test Console follows semantic versioning. The `0.x` line is a beta line, so a minor release may change public integration contracts with migration notes.

## Public contracts

The following values form the compatibility boundary:

- `mobile-test-console.config.v1`
- `mobile-test-console.runner-plugin.v1`
- `mobile-test-console.project-provider-plugin.v1`
- `mobile-test-console.project-provider.v1`
- `test-analysis.run.v1`

Patch releases preserve these contracts. A contract change that existing projects must adopt requires a new schema or API version. The previous version stays readable for at least one minor release when a safe compatibility adapter exists.

## SDK imports

Use `mobile-test-console/sdk` for new integrations. `mobile-test-console/runner` remains the compatibility entry for the `0.1.x` line. JSON Schemas are exported through `mobile-test-console/schemas/mobile-test.config.v1.json` and `mobile-test-console/schemas/test-analysis.run.v1.json`.

## Deprecation process

1. Mark the old API in documentation and release notes.
2. Add a runtime warning with a migration target.
3. Keep a contract test for the supported compatibility window.
4. Remove the old API in the next eligible version boundary.
