# 测试产物保留惯例

## Comparable systems

### GitHub Actions

- 构建日志和产物采用仓库级保留周期，默认 90 天。
- 单个产物可配置更短的 `retention-days`。
- 启示：平台提供默认策略，任务可声明更短的生命周期。
- 参考：https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts

### GitLab CI

- `artifacts:expire_in` 声明产物过期时间。
- 最近一次成功流水线的产物可受到额外保护。
- 启示：时间规则与“最近成功结果保护”组合，能够兼顾空间和可调试性。
- 参考：https://docs.gitlab.com/ci/jobs/job_artifacts/

### Jenkins Build Discarder

- 支持按保留天数和保留构建数量清理历史。
- 构建记录与大体积产物可使用不同保留规则。
- 启示：数量和年龄应同时成为上限，摘要元数据可以保留更久。
- 参考：https://www.jenkins.io/doc/book/managing/system-configuration/

## Mapping to MTC

- MTC 需要统一计算时间、数量、状态和空间四类规则。
- 最近成功、最近失败、活动任务和用户保留任务组成保护集合。
- 项目适配器负责把运行 ID 映射到真实产物，保持开源平台与具体工程解耦。
- 清理计划与执行分离，先展示 dry-run，再执行并记录审计结果。
