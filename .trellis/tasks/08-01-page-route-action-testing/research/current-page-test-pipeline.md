# 当前页面测试链路研究

## 结论

页面参数录制实际采集的是宿主运行时上报的 `lynx_page_parameters_observed` 事件。事件包含页面 ID、bundle 和当前路由参数；Harmony 从 `hilog` 读取，iOS 从 QA App 容器的 `runtime-log/events.jsonl` 读取。录制会话启动 QA App 并开启采集标记，操作人员在设备上打开和跳转页面，provider 轮询合并观察记录。

保存画像时，`PageParameterService` 校验页面字段中的 `required` 参数、敏感字段策略、动作目标和断言目标。回放时，`applyPageParameterProfile` 将画像值合并到 `routeParams` / `navigation`，并将画像中的 `actions` 与 `assertions` 传给平台 runner。

## 参数字段来源

`qa-page-parameters.cjs` 从三类来源建立页面字段：

1. QA manifest 用例的 `routeParams`：标记为 `required: true`，表示页面测试用例明确声明的必填路由参数。
2. 页面源码静态读取点：标记为 `required: false`，表示页面可能读取的可选参数。
3. 动态读取点：页面标记 `dynamicParameters: true`，需要通过录制确认真实键和值。

“参数契约”属于上一轮实现引入的自动生成概念，并非用户配置。当前脚本把 QA 用例中的示例 `routeParams` 自动标记为必填，这项推导缺少业务依据。界面应移除“参数契约”，改为从 `getPageParams()` 的真实读取和后续用途生成参数建议，再通过录制画像的逐项移除测试确认当前场景的必填参数。

## `getPageParams()` 使用模式

- 默认值：`pageTitle ?? "通知"` 表示缺失时页面仍有稳定值，归入可选。
- 条件使用：`if (invitationCode) bindInvitation()` 表示参数只启用附加流程，归入条件必填或可选。
- 无条件业务输入：通知页 `groupId` 无条件进入 GraphQL variables，属于必填候选。
- 多键回退：商品页从 `q`、`id`、`goods.id` 等选择第一个非空值，属于“至少一个”的候选组。
- 动态索引：`getPageParams()[key]` 无法在调用点确定键，归入动态未知并由录制补全。

当前 `scanPageParameterUsage` 只用正则识别 `getPageParam("key")`，对任何 `getPageParams()` 调用只设置 `dynamicParameters=true`。改造需要使用 TypeScript AST 建立局部数据流，并为每个字段记录读取位置、初步分类和候选组。静态分析负责缩小候选集合；逐项移除测试负责验证当前场景中的必要性。

## 当前交互执行链路

页面动作由页面目录中的 `targets` 声明，动作类型包括 `tap`、`input`、`select`、`submit`、`waitFor` 和 `screenshot`。结果断言由 `assertionTargets` 和 `runtimeEvent` 定义。平台执行器目前把动作按顺序执行，再执行结果断言；动作与断言在数据结构中分开保存，因此页面 UI 应使用“动作步骤 + 该步骤预期结果”的编辑模型，再编译为当前 runner 兼容的动作/断言数组。

`applyPageReplayOverrides` 当前会把 `semanticActions` 和 `assertions` 清空，导致单页面回放只打开页面。页面回放需要保留画像中的动作和断言，并继续使用画像路由参数。

## 方案比较

### 方案 A：自动发现并点击页面所有按钮

运行时抓取所有可点击节点并依次点击。覆盖率高，副作用和登录、跳转、删除等不可逆操作风险高，结果断言也无法自动推断。

### 方案 B：页面目录声明可测试目标，界面配置动作与结果断言（推荐）

页面通过现有 `targets` / `assertionTargets` 声明稳定目标；用户从页面列表选择页面，填写必填路由参数，选择按钮动作，再配置可见、文本、选中或运行时事件断言。录制用于发现路由参数和辅助定位目标，执行时只运行用户保存的确定性步骤。

### 方案 C：录制所有点击并生成脚本

录制设备上的点击顺序并自动转成动作。能降低编写成本，坐标和页面状态容易漂移，仍需要用户补充目标和断言，第一阶段会同时维护两套录制模型。

## 选择

采用方案 B。保留现有 provider 和平台执行器，把页面测试工作区改成以页面测试为中心；动作录制作为后续辅助能力，当前只负责路由参数捕获。
