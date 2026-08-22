# 技术设计

## 配置契约

在项目配置根节点增加 `console`：

```js
console: {
  host: "127.0.0.1",
  port: 4310,
  webPort: 4311,
}
```

解析后的 `LoadedProjectConfig.console` 保存默认后的值。CLI 通过显式参数判断覆盖配置；开发启动器将解析后的端口通过环境变量传给 API 与 Vite 子进程。

## 数据流

项目配置 -> `loadProjectConfig` 校验/默认 -> `src/server/cli.ts` 解析 API 地址 -> `scripts/dev.mjs` 端口检查与子进程环境 -> `vite.config.ts` API 代理和前端端口。

## 兼容性

现有配置无需修改。命令行参数继续优先于配置。平台模式使用默认端口。
