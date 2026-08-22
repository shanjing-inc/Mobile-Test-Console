# 技术设计

## 配置边界

新增 `mtc.config.cjs`，结构只包含 MTC 进程级配置：

```js
module.exports = {
  host: "127.0.0.1",
  port: 4500,
  webPort: 4501,
};
```

测试项目继续通过 `mobile-test.config.cjs` 声明项目、测试、设备和生命周期。MTC 启动配置由开发启动器和服务端 CLI 独立读取。

## 数据流

`mtc.config.cjs` -> 配置读取/校验 -> `scripts/dev.mjs` -> API/Vite 环境变量和端口检查。

`mobile-test.config.cjs` -> 项目配置读取 -> 项目生命周期、Runner、设备和测试运行时。

CLI 显式 `--host`、`--port` 继续覆盖 MTC 启动配置；项目切换只重新加载项目配置，MTC 端口保持稳定。

## 兼容性

- 默认启动行为保持 `127.0.0.1:4310` API 与 `127.0.0.1:4311` 页面。
- 现有 `--config` 参数继续表示测试项目配置。
- 现有项目配置中的 `console` 字段读取逻辑逐步移除，避免项目切换改变控制台端口。
