# Publishing checklist

1. Confirm `pnpm check` passes on the minimum and current LTS Node.js versions.
2. Confirm both Lynx fixtures pass through `pnpm test:integrations`.
3. Review generated schemas with `pnpm schema:check`.
4. Review the publish manifest with `pnpm check:package`.
5. Review dependency and repository security alerts.
6. Update the version and release notes according to `docs/versioning.md`.
7. Publish the beta package with the `beta` distribution tag.

```bash
pnpm publish --tag beta
```

The release package contains the CLI, SDK declarations, JSON Schemas, onboarding documentation, and generic Lynx examples.
