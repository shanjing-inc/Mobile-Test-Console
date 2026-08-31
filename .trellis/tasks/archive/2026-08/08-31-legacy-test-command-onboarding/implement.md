# 执行计划

1. 整理共享契约：sidecar schema、编辑器快照、入口输入、预览计划与 apply 请求。
2. 扩展配置加载器：读取 `mobile-test.entries.json`、合并 tests、标注来源并覆盖兼容与冲突测试。
3. 重构 ProjectCatalogService：删除候选命令扫描入口和主 CJS 重写，增加 editor、preview、apply、路径边界、计划过期和原子写入。
4. 增加 HTTP API 与请求校验，复用配置层 schema 和模板解析能力。
5. 在 ProjectCatalogWorkspace 增加“添加测试命令”入口、五步表单、参数/命令行编辑、重试说明、AI 说明复制和确认弹窗。
6. 保存成功后刷新项目 detail/catalog，使新入口出现在检查清单和运行页。
7. 补充回归测试：
   - sidecar 缺失、有效合并、重复 ID、无效 schema；
   - preview 无副作用、apply、stale、备份、路径越界和主配置字节保持；
   - Web 步骤导航、字段保留、命令参数行、重试说明、脱敏 AI 文本和确认流程；
   - 现有主配置入口兼容。
8. 执行质量门禁：`pnpm check`、`git diff --check`，并用桌面与 390px 视口验证引导页无溢出和交互重叠。

## 风险与回滚点

- `src/server/config.ts` 是配置兼容边界，先完成 sidecar 单元测试再接入 API。
- `src/server/project-catalog.ts` 当前有未完成草稿，按 preview/apply 模式重构，保留无关用户改动。
- 表单字段较多，优先复用现有 onboarding 面板、确认弹窗、按钮和错误消息样式。
- sidecar 写入失败时保持原文件和主配置不变；备份只在成功替换前创建。
