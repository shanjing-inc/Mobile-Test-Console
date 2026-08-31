# 执行计划

1. 读取 MTC `88c8da4` 全量差异、归档任务契约和相关前后端规范。
2. 逐层审核共享类型、配置投影、预览 API、安全 tokenizer、sidecar 写入和前端状态流。
3. 审核测试有效性，重点检查状态保持、过期响应、无目标预览、多目标详情和错误阻断。
4. 读取 SaaS 仓库规则与 E2E 规范，区分取件码排序改动和页面矩阵诊断任务改动。
5. 追踪 `mobile-test.config.cjs -> package.json -> run-e2e.mjs -> runner/fixture/sort -> tests`，确认预制入口可执行。
6. 派发独立 `trellis-check` 审核；核实每项 finding 后修复机械局部问题。
7. 执行 MTC 全量质量门和 SaaS 定向质量门，并在浏览器验证桌面及 `390x844` 状态。
8. 检查规格同步；新增可复用契约时更新对应 spec。
9. 形成按仓库拆分的提交计划，提交已确认范围，保留其他任务改动。
10. 归档当前 Trellis 任务并记录工作提交。

## 验证命令

### MTC

```bash
pnpm exec tsc --noEmit
pnpm exec eslint src tests
pnpm exec vitest run
pnpm build
pnpm schema:check
pnpm check:package
git diff --check
```

### SaaS

```bash
pnpm exec eslint <审核范围文件>
pnpm exec vitest run --config tests/config/vitest.unit.config.ts <取件码排序相关测试>
git diff --check
```

## 风险与停止条件

- SaaS 同一文件若同时包含页面矩阵诊断修复和排序功能，无法证明提交边界时停止提交。
- 真实服务端、MySQL、Redis 或微信开发者工具缺失时，保留定向单元测试和配置解析证据，并明确剩余 E2E 风险。
- 公开契约变化或需要产品选择的 finding 返回规划阶段确认。
