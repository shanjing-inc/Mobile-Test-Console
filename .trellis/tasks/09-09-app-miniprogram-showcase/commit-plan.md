# 提交计划

## 批次
`docs(showcase): 增加 App 与小程序实录演示`

包含：
- README.md
- README.en.md
- assets/showcase/showcase.mp4
- assets/showcase/app-demo.gif
- assets/showcase/wechat-results.gif
- assets/showcase/poster.jpg
- scripts/build-showcase.py
- docs/showcase.md
- .trellis/tasks/09-09-app-miniprogram-showcase/（任务规划、检查与收尾记录）

当前分支：codex/app-miniprogram-showcase。
原始视频保留在用户本地目录。当前工作区未发现本任务之外的改动。

## 验证
媒体解码、字幕与遮挡独立审阅、GIF时长/循环、资源链接、lint、类型检查、构建、Schema与打包检查通过。干净HEAD复现相同的10项测试失败，以及测试路由被开源扫描误报为Linux路径；相关基线问题未纳入本任务修复。

## 审批后
确认后执行本批次本地提交，再按Trellis规则记录/归档；远程发布另行处理。
