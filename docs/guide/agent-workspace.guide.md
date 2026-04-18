# 外部 Agent 工作区（最后更新：2026-04-16）

`agent-workspace` 用于生成、校验和导入外部 Agent 工作区。

## 当前定位

- 为项目专用建项目 Agent 提供初始化入口
- 为模板工作区提供校验和发布入口
- 为 campaign / supervisor 提供批量验证入口

## 常用命令

```powershell
pnpm agent-workspace -- init --goal "build a gesture-recognition workflow" --base-url http://127.0.0.1:43123 --workspace .\tmp\external-agent-workspace
pnpm agent-workspace -- validate --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123
pnpm agent-workspace -- apply --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123 --dry-run
pnpm agent-workspace:campaign -- --manifest .\agent-workspace\campaign\scenarios.workflow.manifest.json --base-url http://127.0.0.1:43123
```

## 本地提交入口

初始化后的工作区默认使用本地 `template_bundle_guard`：

```powershell
node .agent-tools\scripts\template_bundle_guard.mjs check
node .agent-tools\scripts\template_bundle_guard.mjs publish
```

## 关键默认规则

- `init` 会复制静态模板工作区并补全 `base_url`
- 真正的外部 Agent 验证走单个 TemplateAgent 路径，不走批量 campaign real 模式
- 工作区产物、报告和 bundle 验证结果都留在工作区本地
