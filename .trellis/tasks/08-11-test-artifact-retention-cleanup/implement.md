# 实施计划

## Phase 1: 阻止新增重复诊断

- [x] Fanli 模拟器仅复制当前 `runId` 的 diagnostics。
- [x] Fanli 真机 `devicectl` 仅拉取当前 `runId` 的 diagnostics。
- [x] 保持 `ios-diagnostics/<runId>` 结果结构兼容。
- [x] 增加历史目录存在时仍只采集当前运行的回归测试。
- [x] 运行 Fanli QA 测试。

## Phase 2: Fanli 清理适配器

- [x] 定义 cleanup request/response v1。
- [x] 实现 `plan` dry-run。
- [x] 实现受限路径下的 `apply`。
- [x] 覆盖幂等、路径越界和活动运行保护测试。

## Phase 3: MTC 策略与存储

- [x] 增加保留策略和配置 schema。
- [x] 增加清理候选计算、审计状态和后台执行。
- [x] 增加外接磁盘/NAS artifact root 检查。
- [x] 回收终态 repair worktree 等 MTC 自有数据。

## Phase 4: MTC 界面

- [x] 增加存储概览和空间分类。
- [x] 增加清理预览、立即清理和任务保留标记。
- [x] 清理入口先扫描运行清单，支持逐项勾选、全选和空清单反馈。
- [x] 长时间清理展示持续活动进度、已用时和本次处理规模，执行期间锁定关闭入口。
- [x] 增加清理结果与失败重试反馈。
- [x] 测试结果概览按测试条目显示对应截图，默认显示图片并支持隐藏后卸载图片节点。

## Phase 5: 历史数据迁移

- [x] 对现有产物生成只读 dry-run 报告。
- [x] 校验重复数据与规范副本。
- [ ] 用户确认后执行历史去重和索引更新。

## Follow-up: 运行级写入预算

- [ ] 版本化 Runner/Provider 写入预算契约。
- [ ] 在任务创建前估算 `estimatedBytes`，在终态采集 `writtenBytes`。
- [ ] 由项目 Runner 对录屏和非必要诊断实施运行中熔断，同时持续保留摘要与错误日志。
- [ ] Result Bundle 摄取确认后回收设备侧当前运行 diagnostics。
