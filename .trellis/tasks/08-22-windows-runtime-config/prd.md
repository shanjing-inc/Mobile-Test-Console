# 评估 Windows 运行配置

## Goal

评估 Mobile Test Console 从 macOS 迁移到 Windows 开发机时的运行条件、功能边界与所需工程改动。

## Confirmed Facts

- 平台核心要求 Node.js >= 18.20.0 与 pnpm 10.x；前端和服务端均基于 Node.js、Vite 与 Fastify。
- Windows 已实现项目目录和配置文件的原生选择器，使用 PowerShell 与 `System.Windows.Forms`。
- Android 与 HarmonyOS 通过 `adb`、`hdc` 接入；显式环境变量已支持 `ANDROID_ADB_PATH`、`ANDROID_SDK_ROOT`、`ANDROID_HOME`、`HARMONY_HDC_PATH`、`HARMONY_SDK_HOME` 与 `DEVECO_SDK_HOME`。
- iOS 设备发现、Simulator 与 Xcode 构建依赖 macOS。Windows 上的平台接入检查会明确标记 iOS 为阻塞状态。
- 设备工具自动探测包含 macOS 专用默认目录。Windows 可通过 PATH 或上述显式环境变量稳定接入工具链。
- 开发启动器及示例配置直接通过 Node `spawn` 调用 `pnpm`。Windows 上需要验证并处理 `pnpm.cmd` 启动语义。

## Requirements

- 给出 Windows 开发机运行平台本身、Android 测试与 HarmonyOS 测试的配置清单。
- 明确 iOS 测试需保留在 macOS 执行的原因与可行的协作方式。
- 确认 Windows 对目录选择、路径解析、设备工具发现和项目命令执行的现有支持与缺口。
- 在用户确定目标平台范围后，提供相应的最小修复方案和验收命令。

## Requirements

- TBD

## Acceptance Criteria

- [ ] 用户可按文档在 Windows 上安装运行时并启动控制台。
- [ ] Android 与 HarmonyOS 的工具链路径、设备授权与配置变量清晰可执行。
- [ ] iOS 功能边界与 macOS 执行要求清晰。
- [ ] Windows 上调用 pnpm 的兼容策略经代码或验证确认。
- [ ] 最终方案包含适当的验证命令。

## Notes

- 当前任务为轻量平台兼容性评估；范围确定后决定是否进入工程修改。

## Open Questions

- Windows 环境需要支持 Android、HarmonyOS，还是还要把 iOS 纳入跨机器测试流程？
