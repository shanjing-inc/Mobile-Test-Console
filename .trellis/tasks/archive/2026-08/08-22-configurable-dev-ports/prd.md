# 配置自定义开发端口

## Goal

允许项目配置文件声明 Mobile Test Console 的监听地址和端口，减少每次启动时重复传递 CLI 参数。

## Requirements

- 项目配置支持可选 `console.host`、`console.port` 和 `console.webPort`。
- CLI 参数 `--host`、`--port` 优先级高于配置文件，配置缺省时保持现有默认值。
- 生产模式使用 `console.port`；开发模式 API 使用 `console.port`，Vite 使用 `console.webPort`。
- `webPort` 缺省时使用 `port + 1`，端口值必须是 1-65535 的整数。
- 开发启动器的端口占用检查、重启等待和 Vite API 代理使用配置后的端口。
- 文档和示例配置说明配置方式。

## Acceptance Criteria

- [x] 配置文件设置 `console: { port: 4500, webPort: 4501 }` 后，`pnpm dev -- --config <path>` 使用 4500/4501。
- [x] 配置文件设置 `console.host` 后，服务绑定该地址。
- [x] `mobile-test-console --port 4600` 覆盖配置文件端口。
- [x] 未配置 `console` 时沿用 4310/4311 和 `127.0.0.1`。
- [x] 非法端口在配置加载或启动时给出明确错误。
- [x] 现有测试、lint、typecheck 全部通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
