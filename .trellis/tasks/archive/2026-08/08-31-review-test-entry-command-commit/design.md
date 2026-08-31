# 技术设计

## 审核边界

```text
MTC commit 88c8da4
  -> contracts / config projection / preview API / sidecar write
  -> App target-selection state / command panel / add-command dialog
  -> regression tests and responsive behavior

SaaS pickup-code-sort changes
  -> mobile-test.config.cjs preset entry
  -> package script -> run-e2e mode
  -> page-matrix runner -> list interaction -> sort implementation
  -> deterministic fixture -> unit and targeted E2E evidence
```

审核以行为链路为单位。MTC 的命令预览必须与实际启动复用同一服务端解析器；SaaS 的预制入口必须指向仓库内真实存在且可验证的命令。

## 状态契约

- `selectedKeys` 只表示实际运行范围。
- `commandPreviewTargetKeys` 在 `selectedKeys` 为空时使用入口支持目标与当前目标的交集。
- 单目标入口按项目与入口上下文执行一次自动选择；用户主动取消后保持空选择。
- 启动成功刷新快照时保留 `selectedKeys`。
- 命令预览请求使用入口、目标和物化参数组成稳定 key，并拒绝过期响应。

## 安全边界

- 浏览器只接收脱敏后的命令预览。
- 自定义命令继续保存为 `executable + args`，执行时保持 `shell: false`。
- sidecar 写入继续使用项目目录边界、preview/apply、计划过期、原子替换和备份保护。
- SaaS 预制入口声明项目已有命令，不由 MTC 改写项目配置。

## 提交边界

### MTC

审核修复以 `88c8da4` 的 follow-up 提交落地。现有 `task-manager`、重试测试、结果测试和 Android 报告保持在工作区。

### SaaS

只提交被完整追踪并通过验证的取件码排序功能集合。页面矩阵诊断任务文件及其专属修复保持独立。若两组改动在同一文件交叉，使用文件内差异证据确认完整性，无法安全拆分时停止提交并报告边界。

## 回滚

- MTC 审核修复使用独立提交，可单独 revert。
- SaaS 入口提交只有在脚本与实现链路完整时生成，可按仓库独立 revert。
- 审核过程不 amend 已有提交。
