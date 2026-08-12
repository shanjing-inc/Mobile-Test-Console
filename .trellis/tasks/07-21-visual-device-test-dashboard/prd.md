# 可视化设备测试控制页面

## Goal

建设一个可复用于多个 App 项目的本机可视化测试控制台。首个接入项目为返利 App，测试人员可以查看当前连接的 Android、iOS、HarmonyOS 设备，选择目标设备和测试套件，启动测试，并持续查看每台设备的测试状态与结果。

## What I Already Know

- 仓库已经提供 Android、iOS、HarmonyOS 三端 Lynx 自动化测试。
- `qa/run-lynx-three-platforms.sh` 支持 `all-pages`、`smoke`、`p0`、`p1`、`p2`、`business-all` 套件，并支持三端并行执行。
- Android 设备通过 `adb devices -l` 发现；iOS 模拟器通过 `xcrun simctl` 发现，真机通过 CoreDevice identifier/UDID 运行；HarmonyOS 设备通过 `hdc list targets` 发现。
- `qa-device-selector.cjs` 已经处理 Android 真机、模拟器、锁屏回退，以及 iOS 真机、模拟器选择。
- `qa-history.cjs` 在测试开始时创建 `status: running` 的运行详情，在结束时写入 `passed` 或 `failed`，并维护设备事件和运行历史。
- `qa-report.cjs` 已经生成静态 HTML 报告，包含运行中、通过、失败、警告等状态和设备、性能、错误、截图信息。
- 页面触发本机命令需要一个本机服务进程；现有静态报告生成器适合复用数据归一化与视觉信息结构。
- Lynx 官方文档入口 `lynx-docs://llms.txt` 已读取。控制页面运行在开发机浏览器中，设备端继续运行现有 Lynx 测试包。
- 仓库根目录没有统一的 pnpm workspace 配置，`packages/lynx` 是独立 Node.js 包，`tools/` 用于仓库开发工具。

## Assumptions (Temporary)

- 页面服务仅监听本机回环地址，服务端只暴露白名单测试动作。
- MVP 采用定时轮询刷新设备和运行状态，状态延迟目标为 1 至 2 秒。
- 每台设备同一时间只运行一个测试任务，不同设备可以并行测试。
- 通用控制台通过项目配置和适配器调用 runner，runner 继续负责构建协调、安装、执行和产物生成。
- 通用控制台位于 `/Users/loumzy/workspace/app/mobile-test-console/`，使用独立 Git 仓库和独立版本生命周期。

## Open Questions

- 当前无阻塞问题。

## Requirements (Evolving)

- 提供本机浏览器可访问的设备测试控制页面。
- 展示当前连接设备，至少包含平台、设备名称或 ID、设备类型和可用状态。
- 支持选择测试设备与测试内容并启动测试。
- 按设备展示空闲、准备中、运行中、通过、失败等状态。
- 展示运行开始时间、已运行时长、当前用例或阶段、完成结果和错误摘要。
- 页面持续刷新设备连接状态和测试状态。
- 复用现有 QA runner、运行历史和测试产物。
- 控制台核心不包含返利项目路径、命令和业务用例硬编码。
- 每个 App 通过独立配置文件声明项目名称、项目根目录、测试套件、启动命令、参数和结果适配器。
- 设备发现能力作为通用 provider 提供，首期覆盖 Android、iOS、HarmonyOS。
- 返利项目通过 `qa/mobile-test.config.cjs` 接入现有 QA runner。
- 返利项目首期开放 Lynx `smoke/p0/p1/p2/all-pages/business-all` 套件与 Android、iOS、HarmonyOS one-click。
- 支持一次选择多台设备启动测试，不同设备并行执行，每台设备同一时间只执行一个任务。
- 运行状态展示当前测试、当前阶段、开始时间、已运行时长、实时日志尾部和最终结果。
- 支持停止运行中的单个设备任务，停止后记录为 `cancelled`。
- 设备执行期间断开连接时，任务记录为失败并保留错误与日志。
- 控制服务重启后从持久化状态恢复历史结果，并将失去进程句柄的运行任务标记为 `interrupted`。

## Acceptance Criteria (Evolving)

- [x] 打开页面后可看到当前连接的 Android、iOS、HarmonyOS 设备。
- [x] 用户可选择设备和测试套件并启动测试。
- [x] 启动后目标设备在 2 秒内显示运行中状态。
- [x] 多台设备运行时，每台设备拥有独立状态和结果。
- [x] 测试结束后页面显示通过或失败、耗时和错误摘要。
- [x] 页面刷新后可恢复当前运行状态和最近结果。
- [x] 服务端仅允许执行预定义测试动作和参数。
- [x] 控制台切换到另一份项目配置后，可以展示该项目定义的测试套件并启动命令。
- [x] 通用控制台源码中没有返利仓库绝对路径和返利业务用例名称。
- [x] 用户可同时选择多台设备，页面分别展示每台设备的状态和日志。
- [x] 用户可停止运行中的任务，最终状态显示为已取消。
- [x] 设备断开、命令启动失败和服务重启均产生明确的终态与错误说明。

## Definition of Done

- 设备发现、测试启动、状态读取的核心逻辑有自动化测试。
- 页面关键状态与异常场景有测试覆盖。
- Lynx 包的现有 `qa:test`、typecheck 和相关检查通过。
- QA README 增加启动与操作说明。
- 本机服务退出时妥善处理运行任务和状态记录。

## Out of Scope (Explicit)

- 远程部署和公网访问。
- 用户账号、权限系统和多租户任务调度。
- 云真机与设备农场接入。
- 修改设备端 Lynx 业务页面测试协议。
- 浏览器内编辑任意 shell 命令。
- 首期接入 Harmony Monkey 与自定义命令预设。

## Technical Approach (Provisional)

推荐增加一个自包含的本机测试控制台项目。通用核心负责设备发现、任务调度、子进程生命周期、状态 API 和 Web 页面；项目适配器负责测试套件、命令模板、参数约束与结果解析。服务端维护设备任务映射，浏览器页面以 1 至 2 秒轮询更新设备列表和任务状态。现有 `qa-report.cjs` 的运行记录归一化逻辑适合通过返利适配器复用，历史报告继续保留。

建议目录结构：

```text
mobile-test-console/
  .git/
  package.json
  src/core/                 # 配置、任务模型、调度与进程生命周期
  src/providers/            # Android、iOS、HarmonyOS 设备发现
  src/server/               # 本机 HTTP API
  src/web/                  # 可视化控制页面
  tests/
fanli/qa/mobile-test.config.cjs   # 返利项目测试套件和 runner 适配
```

控制台通过配置文件路径接入目标 App 项目。各 App 仓库独立维护自己的测试套件、命令模板和结果适配配置。

## Technical Notes

- 设备选择：`packages/lynx/scripts/qa/qa-device-selector.cjs`
- 运行记录：`packages/lynx/scripts/qa/qa-history.cjs`
- 静态报告：`packages/lynx/scripts/qa/qa-report.cjs`
- 三端执行：`qa/run-lynx-three-platforms.sh`
- 通用预设执行：`packages/lynx/scripts/qa/qa-codex-run.cjs`
- 测试清单：`qa/coverage/lynx-pages.json`
- 现有依赖保持轻量，控制服务可以优先使用 Node.js 内置 HTTP 与子进程 API。

## Decision (ADR-lite, Evolving)

**Context**：控制台需要服务返利项目，并具备接入其他 App 项目的能力。

**Decision**：采用通用控制台核心与项目配置适配器的结构。通用实现放入同级独立 Git 项目 `/Users/loumzy/workspace/app/mobile-test-console/`，返利项目细节保留在 `fanli/qa/mobile-test.config.cjs`。

**Consequences**：首期会增加一层配置与适配接口；设备发现、任务状态和页面能力可以跨项目复用，控制台拥有独立版本、提交历史和发布节奏。

## Expansion Decisions

- **Future evolution**：配置协议保留自定义设备 provider、测试类型和结果解析器扩展点。
- **Related scenarios**：首期统一 Lynx 套件与三端 one-click 的启动和状态模型。
- **Failure handling**：覆盖设备断开、启动失败、任务取消和服务重启导致的任务中断。

## Implementation Plan

1. 建立独立 Node.js + TypeScript 项目、配置协议和测试框架。
2. 实现 Android、iOS、HarmonyOS 设备发现与统一设备模型。
3. 实现白名单任务启动、每设备互斥、并行调度、日志和持久化状态。
4. 实现本机 HTTP API 与响应式 Web 控制台。
5. 增加返利项目配置，接入 Lynx 套件和三端 one-click。
6. 完成自动化测试、类型检查、浏览器视觉验证和使用文档。

## Verification

- `mobile-test-console`: ESLint 通过。
- `mobile-test-console`: Vitest 6 个测试文件、15 个测试全部通过。
- `mobile-test-console`: TypeScript 类型检查通过。
- `mobile-test-console`: Vite Web 构建与 tsup Server 构建通过。
- `fanli/packages/lynx`: QA runner 91 个测试全部通过。
- 编译链路：服务启动阶段按输入指纹准备一次共享 Lynx QA 产物；设备套件跳过重复 Lynx 编译、原生构建和安装。
- Sidecar 链路：共享构建计算指纹前完成全量预检；替换点仍唯一时自动刷新源码哈希，结构漂移时在 Rspeedy 编译前直接报出 sidecar 和 replacement 序号。
- 并发链路：同平台设备准备阶段通过平台锁串行，准备完成后的设备测试套件并行执行。
- 真实设备发现：Android、iOS 真机与模拟器、HarmonyOS 均返回结构化设备。
- 浏览器验证：桌面与 390×844 移动视口无横向溢出，平台筛选、设备选择、测试入口切换通过。
- 示例任务验证：`running`、实时日志、设备占用、停止入口与 `passed` 终态均正确呈现。
- 浏览器控制台：无 error 或 warning；开发端口 `4311` 已验证页面完整渲染。
