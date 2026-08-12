# imageDialog 动态参数编辑

## Goal

在移动测试控制台的当前页面参数区域，为 `dynamicParameters` 页面提供可手动新增、编辑和删除参数键的能力。这样 `imageDialog` 可以直接填写 `image_url`、`image_width`、`image_height`、`route`、`clear_clipboard_data`、`search_keyword`、`dialog_style` 等运行参数，并通过现有页面测试和参数画像流程回放。

## What I already know

* 截图对应独立项目 `../mobile-test-console` 的 `PageParametersWorkspace`。
* 当前编辑器由 `resolveDraftFields(page, values)` 生成字段；页面扫描字段为空时显示“当前页面代码未读取路由参数，可直接测试打开”。
* `page.dynamicParameters === true` 会让页面进入“需参数”目录，但不会提供可编辑字段。
* Fanli 的 `imageDialog` 页面实际读取 `image_url`、`image_width`、`image_height`、`route`、`clear_clipboard_data`、`search_keyword`，动态消息更新还校验 `dialog_style`。
* 当前草稿、保存、历史画像、回放链路已经支持任意 `values` 键，缺少的是前端新增键入口。

## Assumptions (temporary)

* 以通用动态参数编辑器为主，所有动态页面都可新增任意合法参数键。
* 新增参数默认采用 `literal` 策略，键名和值均由测试人员填写。
* 参数键需去除空白并限制为单行非空文本；重复键直接复用已有字段。

## Open Questions

* 已确认采用通用手动新增参数键，并为 `imageDialog` 提供常用参数快捷预置。

## Requirements

* 动态参数页面的“当前路由参数”区域提供新增参数键和值的控件。
* 新增后参数立即进入当前草稿，可编辑取值策略、参数值并删除。
* 当前草稿保存和“测试当前页面”沿用现有画像与回放 API。
* 已有扫描字段、捕获字段和历史字段的交互保持不变。
* 处理空键、重复键和取消新增等边界状态，并提供中文界面提示。
* `imageDialog` 快捷预置包含 `image_url`、`image_width`、`image_height`、`route`、`clear_clipboard_data`、`search_keyword`、`dialog_style`。

## Acceptance Criteria

* [x] 选择 `imageDialog` 后，即使当前扫描字段为 0，也能新增并看到自定义字段行。
* [x] 可添加 `image_url` 等参数，编辑值后保存画像，保存请求包含这些键。
* [x] “测试当前页面”使用当前编辑的自定义参数进行回放。
* [x] 删除自定义字段后，保存请求和页面计数同步移除该键。
* [x] 空键不能添加，重复键不会生成重复字段。
* [x] 现有页面参数、历史画像、回放相关测试全部通过。

## Definition of Done

* 添加或更新 Web 单元测试。
* TypeScript、ESLint、Vitest 检查通过。
* 更新控制台文案或 README（若新增交互需要说明）。

## Out of Scope

* 修改 Fanli Lynx `imageDialog` 页面运行时协议。
* 修改参数扫描器对动态键的静态推断算法。
* 引入服务端新的参数存储格式。

## Technical Approach

在 `PageParametersWorkspace` 增加通用的“新增参数”编辑状态和操作，将自定义键写入现有 `values` / `valueOrigins` 草稿；在 `page-parameter-values` 中补充动态字段元数据生成与键名校验辅助函数；使用现有 `resolveDraftFields`、保存接口和回放接口完成数据流闭环。

## Decision (ADR-lite)

**Context**: 动态页面无法通过静态扫描得到参数字段，`imageDialog` 当前页面因此显示 0 个可编辑参数。

**Decision**: 提供通用的手动新增键入口，并针对 `imageDialog` 提供快捷预置键；所有键继续复用现有页面参数画像保存与回放链路。

**Consequences**: 动态页面获得可编辑能力，控制台需要维护预置键元数据和新增键校验；服务端契约保持兼容。

## Technical Notes

* 控制台前端：`../mobile-test-console/src/web/PageParametersWorkspace.tsx`
* 参数草稿工具：`../mobile-test-console/src/web/page-parameter-values.ts`
* 参数契约与保存接口：`../mobile-test-console/src/shared/contracts.ts`、`../mobile-test-console/src/server/page-parameters.ts`
* Fanli 页面参数读取：`packages/lynx/src/dialog/image-dialog/page.tsx`
