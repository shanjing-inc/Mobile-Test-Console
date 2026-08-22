# 配置文件支持手动设置控制台端口

## Goal

TBD.

## Requirements

- TBD

## Acceptance Criteria

- [ ] TBD

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
# 配置文件支持手动设置控制台端口

## Goal

通过项目现有的 `mobile-test.config.cjs` 配置文件手动设置控制台监听地址和端口。

## Requirements

- 配置文件支持 `console.host`、`console.port` 和 `console.webPort`。
- 开发模式使用 `console.port` 启动 API，使用 `console.webPort` 启动页面。
- `webPort` 缺省时自动使用 `port + 1`。
- 未配置端口时保留 `127.0.0.1:4310` API 和 `127.0.0.1:4311` 页面默认值。
- 命令行 `--host`、`--port` 可以覆盖配置文件对应值。
- 文档和示例配置说明手动设置方式。

## Acceptance Criteria

- [x] `mobile-test.config.cjs` 中设置 `console.port` 后 API 使用配置端口。
- [x] 设置 `console.webPort` 后开发页面使用配置端口。
- [x] 未设置 `webPort` 时自动派生下一个端口。
- [x] 未配置 `console` 时保留默认端口。
- [x] 配置、CLI、开发启动器和 Vite 代理端口链路测试通过。
- [x] 文档提供可复制的配置示例。
