# 技术设计

## 架构边界

```text
ConsoleSnapshot.tests
  -> 带 source 的预制/自定义入口列表
  -> App 测试入口选择 + 添加自定义命令
  -> POST /api/test-commands/preview
  -> 服务端校验 test/target/parameters
  -> resolveTargetCommand() 逐目标解析
  -> 脱敏结构化命令响应
  -> 右侧单命令展示 / 多命令详情弹窗

ProjectTestEntryWizard
  -> 单页快速表单（名称 + 命令 + 可选说明）
  -> 安全解析为 executable + args
  -> 高级设置按需展开
  -> 复用 editor/preview/apply API
  -> mobile-test.entries.json
  -> 刷新 snapshot.tests
  -> 自动选中新入口
```

命令定义和模板解析继续由服务端配置层拥有。浏览器只接收入口来源和脱敏后的结构化预览，避免把原始配置、环境变量值或模板解析逻辑复制到前端。

## 共享契约

```ts
type TestEntrySource = "preset" | "custom";

interface PublicTestDefinition {
  // existing fields
  source: TestEntrySource;
}

interface PreviewTestCommandsRequest {
  testId: string;
  targetKeys: string[];
  parameters: Record<string, string>;
}

interface TestCommandPreview {
  targetKey: string;
  targetLabel: string;
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, "<redacted>">;
}

interface PreviewTestCommandsResponse {
  schemaVersion: "mobile-test-console.test-command-preview.v1";
  testId: string;
  commands: TestCommandPreview[];
}
```

新增 `POST /api/test-commands/preview`。请求只支持当前小程序项目的已声明入口与 `targetKeys`；服务端复用 `validateParameters()`、配置目标查找和 `resolveTargetCommand()`。预览任务使用明确的运行时占位值，不创建任务、不执行 Runner，也不写文件。

## 入口来源投影

配置加载器已经保留 `mainConfigTests` 与 `sidecarTests`。新增统一投影函数按以下顺序生成公开入口：

1. 主配置入口，`source: "preset"`。
2. `mobile-test.entries.json` 入口，`source: "custom"`。

`/api/snapshot`、项目详情和入口编辑器统一使用该投影，兼容缺少来源分区的历史内存配置时将现有 `tests` 视为预制入口。入口选择器展示来源标签，任务启动仍只提交稳定的 `testId`。

## 命令预览数据流

1. 用户选择入口、目标或修改参数。前端将已勾选目标作为优先预览范围；当前选择为空时，使用入口 `targetKeys` 与快照已配置目标的交集。
2. 前端在短延迟后提交当前稳定快照，使用请求序号或取消信号丢弃过期响应。
3. 服务端校验入口、目标引用和参数默认值，展开页面选择预设，再逐目标解析结构化命令。
4. 服务端将所有环境变量值替换为 `<redacted>` 后返回。
5. 单目标命令在右侧说明区直接展示完整 executable、args、cwd 与 env 名称。
6. 多目标时说明区展示数量和“查看详情”；弹窗按目标分组展示同样的完整字段并提供复制按钮。
7. 入口支持目标为空时说明区展示无法解析提示；解析失败时展示错误并加入启动按钮禁用条件；Runner 接管型入口展示 Runner ID 并保留启动能力。

运行目标选择与命令预览采用两个明确状态：`selectedKeys` 只记录用户实际运行范围，`commandPreviewTargetKeys` 在其为空时投影入口支持范围。入口只支持一个已配置目标时，按项目 ID 与入口 ID 组成的上下文执行一次自动勾选；同一上下文后续的快照轮询和用户主动取消保持当前选择。切换入口或项目创建新上下文。启动成功只更新任务焦点与运行记录，保留 `selectedKeys`，使命令预览持续对应下一次运行范围。

命令格式化只用于显示和复制，不参与执行。执行仍由 `TaskManager` 在创建真实任务后调用同一个 `resolveTargetCommand()`，保证模板解析来源一致。

## 添加入口简化

`ProjectTestEntryWizard` 保留现有组件边界和 editor/preview/apply 服务端接口，将五步状态机收敛为单页快速表单。默认可见字段为显示名称、命令和可选说明；“高级设置”承载目标、测试类型、业务分类、工作目录、环境变量、参数和页面重试。

快速表单按以下规则物化现有 `ProjectTestEntryInput`：

1. 命令行经安全 tokenizer 解析，首项成为 `executable`，其余项按顺序成为 `args`。
2. ID 根据命令生成小写连字符形式，并与主配置及 sidecar 已有 ID 比较后追加数字后缀。
3. `targetKeys` 默认包含 editor 返回的全部运行目标。
4. `kind` 默认 `general`，`testType` 默认“自定义测试”，`runnerId` 保持 `legacy-command-runner`。
5. `cwd` 默认项目根目录，环境变量与参数默认为空。

tokenizer 支持普通参数、空格、单引号与双引号，拒绝 `|`、`>`, `<`、`&&`、`||`、`;`、反引号和 `$` 展开。浏览器只负责即时提示；服务端在生成 preview plan 时再次解析或校验同一命令结构，保证写入边界可信。

点击“保存命令”先调用 preview，成功后立即使用返回的 `planId` 调用 apply。计划摘要和完整 JSON 放在“保存详情”折叠区供需要确认的用户查看，AI 接入说明保留在高级区域。执行页 apply 成功后：

1. 调用现有 snapshot 刷新链路。
2. 用向导返回的入口 ID 选中新入口。
3. 按新入口的目标约束清理失效目标选择。
4. 使用默认参数触发命令预览。

写入继续走现有 `mobile-test.entries.json` preview/apply、安全路径、原子替换、权限保持和 `.bak` 机制。

## UI 与响应式

- 保持 `.form-grid` 左侧入口/参数、右侧说明的现有布局。
- 添加命令弹窗移除五步指示器和上一步/下一步按钮，首屏固定展示三个输入区域与一个主保存按钮。
- 高级设置使用原生 `details`，默认收起；展开后沿用现有结构化编辑控件。
- 保存详情默认收起，包含目标文件、结构化命令、工作目录、警告和完整 JSON。
- 右侧说明升级为命令确认区域，包含入口类型、来源、用途和命令状态。
- 命令文本使用可换行代码块与稳定宽度，长参数不会扩大页面。
- 尚未选择运行目标时展示入口支持范围命令和“启动前请选择运行目标”提示；启动按钮继续受实际选择约束。
- 多目标详情使用当前页模态框，正文独立滚动，关闭后保留全部表单状态。
- `390x844` 下表单变为单列，命令详情和弹窗保持无横向溢出，按钮与代码互不遮挡。
- `390x844` 下弹窗正文独立滚动，底部“取消 / 保存命令”保持可见且等宽。

## 兼容与安全

- `StartTasksRequest`、Runner、任务持久化和 Result Bundle 契约保持原样。
- 快照新增的 `source` 是公开展示元数据；所有内部测试仍以配置对象为执行来源。
- 浏览器永远不接收未脱敏 env 值。
- 预览 API 拒绝未知入口、重复或未知目标、入口不支持的目标、legacy Runner 无命令和无效参数；自定义 Runner 无命令时返回空命令列表。
- 配置或 sidecar 写入后的运行时刷新沿用现有 apply 逻辑。
- 快速命令解析只生成结构化 executable/args，任务执行仍使用 `spawn(executable, args)`，不会启用 shell。

SaaS 小程序在项目自己的 `mobile-test.config.cjs` 中追加“员工取件码排序验证”预制入口。该入口复用现有项目 Runner、真实服务端页面兼容能力和结果分析能力，结构化命令固定为 `pnpm test:e2e:pickup-code-sort`。项目配置测试负责锁定入口名称、用途、能力和命令映射。

## 回滚

- 删除命令预览 API、来源字段和执行页入口即可恢复原执行 UI。
- 共享向导继续由执行页使用，不影响已有 sidecar 数据。
- 控制台功能不迁移或重写用户项目文件；SaaS 小程序示例入口由项目配置显式维护。
