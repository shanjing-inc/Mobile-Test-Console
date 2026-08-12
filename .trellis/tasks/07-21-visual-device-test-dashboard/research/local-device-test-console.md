# 本机设备测试控制台调研

## 参考工具

### Maestro Studio

- 官方资料：https://docs.maestro.dev/getting-started/maestro-studio
- 以 workspace、连接设备和测试 flow 组织主要操作。
- 可视化入口保留测试文件作为事实来源，页面负责选择、启动和查看执行过程。
- 本项目采用相同边界：App 仓库配置测试动作，控制台负责调度与状态展示。

### Appium Inspector

- 官方资料：https://appium.github.io/appium-inspector/latest/
- 以显式设备 session 为核心，集中展示设备画面、页面结构与交互结果。
- 本项目将每个设备任务建模为独立 session，同一设备执行互斥，不同设备支持并行。

### Playwright UI Mode

- 官方资料：https://playwright.dev/docs/test-ui-mode
- 以项目、筛选条件、运行状态和 trace 详情组织测试调试流程。
- 本项目保留项目与测试筛选，运行详情展示状态、耗时、日志和错误；测试产物继续由项目 runner 生成。

## 仓库约束

- 返利 QA runner 使用 Node 18.20.7 与 pnpm 10.28.2。
- 返利已有三端设备发现、Lynx 套件、one-click runner、运行历史和报告生成能力。
- `qa:lynx` 的平台驱动、构建隔离、设备恢复和报告契约继续由返利仓库维护。
- 独立控制台只接收配置声明的测试 ID、设备 ID 和枚举参数，浏览器无法提交 shell 文本。

## 技术选择

- Node.js `>=18.20.0`：兼容返利 QA 固定运行时。
- TypeScript：共享配置、API、任务状态和页面类型。
- Fastify 4：本机 HTTP API、结构化错误和静态文件服务。
- React 18 + Vite 5：构建响应式操作控制台，并保持 Node 18 兼容。
- Zod 3：在配置入口与 HTTP 入口集中校验数据。
- Vitest：覆盖设备输出解析、配置解析、任务状态机与 API。
- 1 秒轮询：统一刷新设备、任务与日志尾部，MVP 保持简单稳定。

## 数据流

```text
App 配置文件
  -> 配置校验与命令模板解析
  -> 设备 provider + TaskManager
  -> 持久化任务快照
  -> HTTP API
  -> React 设备面板与运行详情
```

## 任务状态

```text
queued -> preparing -> running -> passed | failed | cancelled
                                  interrupted（服务重启恢复）
```

## 安全边界

- 默认只监听 `127.0.0.1`。
- API 根据配置白名单解析测试 ID、平台和参数。
- 子进程使用 executable + args 数组启动，参数经过枚举或格式校验。
- 页面只展示日志文本，React 默认转义输出。
- 日志和任务历史设置数量与长度上限。
