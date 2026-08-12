# com.shanjing.example

这是一个最小 Android Lynx 示例项目，用于验证 Mobile Test Console 的项目选择、接入检测、设备发现、构建安装、执行测试和 Result Bundle 分析流程。

项目只保留以下运行链路：

- 一个 `main.bundle` Lynx 页面。
- 一个包名为 `com.shanjing.example` 的 Android 宿主。
- 一个 Android Smoke 测试。
- 一个 Project Provider 和一个 Runner。
- `page_opened`、`page_ready`、截图、运行日志和 Result Bundle。

## 环境准备

- Node.js 18.20 或更高版本。
- pnpm 10.28.2。
- JDK 17 或 Android Studio 自带 JBR。
- Android SDK 34、Gradle 8.4 或更高版本。
- 一台通过 `adb devices` 可见且状态为 `device` 的 Android 设备或模拟器。

安装 Lynx 构建依赖：

```bash
cd examples/com.shanjing.example
pnpm install
```

## 接入 Mobile Test Console

在 MTC 首页点击“添加项目”，选择此文件：

```text
examples/com.shanjing.example/mobile-test.config.cjs
```

MTC 会读取以下项目元数据：

```text
项目 ID: shanjing-example
项目名称: com.shanjing.example
接入类型: lynx-app
平台: android
```

连接 Android 设备并完成项目概览中的四项检查后，进入“执行测试”，选择 `Lynx 单页 Smoke`。Runner 会依次完成 Lynx Bundle 构建、Android APK 构建、设备安装、Deep Link 启动、`page_ready` 等待、截图和结果分析。

也可以从 MTC 仓库直接启动：

```bash
pnpm test:shanjing-example
```

## 独立验证

只检查 Lynx 代码：

```bash
pnpm typecheck
pnpm build:lynx
```

构建 Android APK：

```bash
pnpm build:android
```

APK 输出位置：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

这个示例使用 Lynx 运行所需的最小依赖集合，未引入业务 SDK、账号系统、网络层和图片库。
