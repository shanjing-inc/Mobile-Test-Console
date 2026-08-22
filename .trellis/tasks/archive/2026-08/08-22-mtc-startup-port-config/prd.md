# 拆分 MTC 启动端口配置

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
# 拆分 MTC 启动端口配置

## Goal

将 MTC 自身的监听地址、API 端口和开发页面端口从测试项目配置中拆出，支持 `pnpm dev` 使用独立的 MTC 启动配置。

## Requirements

- 新增独立的 MTC 启动配置文件，支持 `host`、`port`、`webPort`。
- `pnpm dev` 默认读取仓库根目录的 MTC 启动配置，并保留 `4310/4311` 默认值。
- 项目 `mobile-test.config.cjs` 继续只描述测试项目；项目配置中的 `console` 字段不再决定 MTC 开发端口。
- CLI `--host`、`--port` 优先级高于 MTC 启动配置。
- 开发启动器、API、Vite 页面、代理和端口占用检查使用同一份 MTC 启动配置。
- 配置文件缺失、格式错误和非法端口提供明确错误。
- 文档和示例说明 Windows 上的端口调整方式。

## Acceptance Criteria

- [ ] `pnpm dev` 可以通过独立配置文件使用自定义 API/页面端口。
- [ ] `pnpm dev -- --config <project-config>` 仍能加载测试项目，同时使用 MTC 启动配置端口。
- [ ] `mobile-test-console --config <project-config> --port <port>` 继续覆盖 API 端口。
- [ ] 未配置 MTC 启动文件时沿用 `127.0.0.1:4310/4311`。
- [ ] API、Vite、代理、占用检查和重启等待使用同一组端口。
- [ ] 配置、启动器和端口冲突测试通过。
