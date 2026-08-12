# Mobile Test Console

[简体中文](README.md) | [English](README.en.md)

Mobile Test Console is an open-source, configuration-driven test console that runs on your development machine. It gives mobile apps and mini programs one workspace for device management, test scheduling, live execution status, logs, and result analysis.

It supports Android, iOS, HarmonyOS, and mini-program targets. Projects integrate through configuration, Runner, Project Provider, and Result Bundle contracts while keeping test implementations and business data in their own repositories.

The current release is `0.1.0-beta.1` and is available for integration testing under the MIT License.

## Highlights

- Discover and manage Android, iOS, and HarmonyOS devices and mini-program targets
- Schedule test runs with concurrency control, cancellation, live status, and logs
- Review test cases, assertions, screenshots, network evidence, and diagnostics
- Extend project capabilities through the SDK, JSON Schemas, Runners, and Project Providers
- Govern test artifacts with retention policies, cleanup previews, disk checks, and audit records

## Requirements

- Node.js `>=18.20.0`
- pnpm `10.x`
- Android: `adb` available in `PATH`
- iOS: macOS with `xcrun simctl`; physical-device discovery uses `xcrun devicectl`
- HarmonyOS: `hdc` available in `PATH`
- WeChat mini programs: project-provided Node.js, package manager, WeChat DevTools, and test environment

## Quick Start

Install dependencies and start the API and Vite development server:

```bash
pnpm install
pnpm dev
```

Open [http://127.0.0.1:4311](http://127.0.0.1:4311).

Start the bundled local demo after building the project:

```bash
pnpm build
pnpm start -- --config examples/demo.config.cjs --port 4312
```

To run a project integration directly:

```bash
pnpm dev -- --config /path/to/app/qa/mobile-test.config.cjs
```

See the [Chinese README](README.md) for the complete configuration reference, project onboarding flow, Result Bundle contract, Runner SDK, and connector details. Lynx projects can start with the [Lynx App onboarding guide](docs/lynx-app-onboarding.md) and the [Lynx App Starter](examples/lynx-app-starter).

## Development

Run the complete quality gate:

```bash
pnpm check
```

## License

[MIT](LICENSE)
