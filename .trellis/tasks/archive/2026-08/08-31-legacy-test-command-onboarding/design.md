# 技术设计

## 架构边界

```text
ProjectCatalogWorkspace
  -> GET test-entry-editor
  -> 用户填写 TestEntryDraft
  -> POST test-entries/preview
  -> ProjectCatalogService 校验 + 生成计划
  -> Web 展示 JSON / 命令预览 / 风险
  -> POST test-entries/apply { planId }
  -> 原子写入 mobile-test.entries.json
  -> loadProjectConfig 合并主配置 tests + sidecar tests
  -> 项目重新验证并进入运行页面
```

MTC 只拥有结构化测试入口契约和写入流程。项目继续拥有命令实现、测试框架、运行时语义和结果转换。
命令输入只来自用户提交的结构化表单，服务端不读取项目文件推断候选命令。

## 文件契约

配置文件同目录约定一个可选 sidecar：

```json
{
  "schemaVersion": "mobile-test-console.test-entries.v1",
  "tests": []
}
```

- `loadProjectConfig()` 在解析主配置前读取 sidecar，将 `tests` 合并后交给现有 `configSchema` 完整校验。
- 主配置测试排在前，sidecar 测试按文件顺序追加；任意重复 ID 触发现有唯一性错误，并补充来源路径。
- sidecar 缺失等价于空测试集合，保持现有项目兼容。
- sidecar 使用项目相对路径字段；加载阶段沿用现有 cwd 和命令模板解析规则。

## API 契约

```ts
interface ProjectTestEntryEditorResponse {
  schemaVersion: "mobile-test-console.project-test-entry-editor.v1";
  project: ProjectCatalogEntry;
  targets: MiniProgramRunTarget[];
  mainConfigTests: PublicTestDefinition[];
  editableTests: PublicTestDefinition[];
  entriesPath: string;
}

interface PreviewProjectTestEntryRequest {
  mode: "create";
  entry: ProjectTestEntryInput;
}

interface ProjectTestEntryPlan {
  schemaVersion: "mobile-test-console.project-test-entry-plan.v1";
  planId: string;
  projectId: string;
  entriesPath: string;
  contentPreview: string;
  commandPreview: ResolvedCommand;
  warnings: string[];
  canApply: boolean;
}

GET  /api/projects/:projectId/test-entry-editor
POST /api/projects/:projectId/test-entries/preview
POST /api/projects/:projectId/test-entries/apply
```

请求入口复用配置层的 `TestDefinition`、`TestParameterDefinition` 和命令 schema。HTTP 层只负责结构校验，配置层负责目标引用、模板变量和跨字段规则。

## 引导式表单

1. 测试信息：ID、名称、说明、类型。
2. 运行目标：从当前小程序项目 `testing.targets` 选择。
3. 执行命令：executable、可排序 args、cwd、env 键值对。
4. 参数与重试：添加 MTC 参数；页面类型展示重试变量、wrapper 示例和确认项。
5. 确认：渲染目标文件、JSON、命令预览、警告和“复制 AI 接入说明”。

表单保存在组件本地状态。切换项目或关闭引导时清理草稿，步骤切换保留草稿。命令参数使用独立输入行，避免浏览器端解析 shell 引号。

## 预览与写入安全

- `planId` 对项目 ID、配置文件摘要、sidecar 摘要和规范化请求求哈希。
- apply 重新读取并生成计划，摘要变化返回 `PROJECT_TEST_ENTRY_PLAN_STALE`。
- 写入前验证 entriesPath 与 realpath 父目录均位于项目根目录。
- 使用同目录临时文件写入并 rename；已有文件先复制为 `.bak`。
- 写入成功后触发项目 verify，API 返回更新后的编辑器快照。

## AI 引导

首版不调用模型。复制内容由服务端或共享纯函数基于当前目标、允许字段、模板变量、重试变量和脱敏表单生成。环境变量只展示键名，值统一替换为 `<redacted>`。

## 兼容与回滚

- 旧项目不创建 sidecar，行为保持一致。
- 删除或恢复 `mobile-test.entries.json.bak` 即可回滚可视化新增入口。
- 未完成的候选命令扫描代码在实施时移除，整文件 CJS 重写逻辑替换为 sidecar 写入。
