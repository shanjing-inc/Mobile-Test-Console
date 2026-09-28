# 验证记录

## MTC

Node 环境：

```bash
PATH=/Users/loumzy/.nvm/versions/node/v24.14.0/bin:$PATH
```

已通过：

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

- Vitest：40 个测试文件，337 个测试全部通过。
- ESLint：0 error；`PageSelectionField.tsx` 保留 2 条既有 Fast Refresh warning。
- 本地界面：`http://127.0.0.1:4311/` 已验证页面选择布局、搜索、取消当前和清空控件。

## Fanli Lynx QA

执行目录：`../fanli/packages/lynx`

```bash
PATH=/Users/loumzy/.nvm/versions/node/v24.14.0/bin:$PATH pnpm qa:test
```

- 385 个测试通过。
- Fanli 与 MTC 两仓库 `git diff --check` 通过。
