# Workflow 工作区逻辑（最后更新：2026-04-16）

```mermaid
flowchart TD
  A[进入 workflow run 页面] --> B[拉取 run 基本信息]
  B --> C[按当前子视图拉取 task tree runtime 或 chat 相关数据]
  C --> D[拉取 sessions / timeline / workspace 证据]
  D --> E[用户触发 chat 或 dispatch]
  E --> F[局部刷新运行态]
```

## 规则

- overview、task tree、chat、team config 共享同一个 run 视角
- 详情页刷新优先保持 run 级状态一致，再局部更新子视图
- session 与 timeline 只做观察，不在前端推导终态
- task tree 视图使用 task tree runtime，而不是独立 task runtime 快照
