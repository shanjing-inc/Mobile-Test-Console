# Security Policy

## Supported versions

| Version | Support |
| --- | --- |
| `0.1.x-beta` | Security fixes and compatibility fixes |

## Reporting a vulnerability

Report vulnerabilities through the repository host's private security advisory feature. Include affected versions, reproduction steps, impact, and any proposed mitigation. Avoid opening a public issue before a fix is available.

The project handles local project paths, device identifiers, command output, test artifacts, account profiles, and optional repair-tool execution. Reports involving path traversal, command construction, credential exposure, unsafe artifact access, or cross-project state access receive priority.

## Operational guidance

- Keep the service bound to `127.0.0.1` unless access controls and a trusted network boundary are in place.
- Review every project configuration and plugin before loading it; they execute with the current user's permissions.
- Store secrets outside configuration files and pass them through controlled environment variables.
- Remove sensitive test artifacts according to the owning application's retention policy.
