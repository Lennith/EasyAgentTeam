# 外部 Agent 工作区（最后更新：2026-04-25）

文档状态：`验证中`

`@autodev/agent-workspace` 是 EasyAgentTeam 的一等 CLI 入口，用于生成、校验和导入外部 Agent 工作区。

## 当前定位

- 为项目专用建项目 Agent 提供初始化入口。
- 为模板工作区提供校验和发布入口。
- 为 campaign / supervisor 提供批量验证入口。
- 作为 workspace package 参与 monorepo 版本、测试和本地 artifact 打包。

## 常用命令

```powershell
pnpm agent-workspace -- init --goal "build a gesture-recognition workflow" --base-url http://127.0.0.1:43123 --workspace .\tmp\external-agent-workspace
pnpm agent-workspace -- validate --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123
pnpm agent-workspace -- apply --bundle .\agent-workspace\examples\bundle.sample.json --base-url http://127.0.0.1:43123 --dry-run
pnpm agent-workspace:campaign -- --manifest .\agent-workspace\campaign\scenarios.workflow.manifest.json --base-url http://127.0.0.1:43123
pnpm agent-workspace:pack
```

Linux 辅助入口保留为脚本形态，本轮只随源码提供，不进入 release gate：

```sh
sh tools/linux/agent-workspace.sh init --goal "build a gesture-recognition workflow" --base-url http://127.0.0.1:43123 --workspace ./tmp/external-agent-workspace
sh tools/linux/quickstart-agent-workspace.sh
```

## 本地提交入口

初始化后的工作区默认使用本地 `template_bundle_guard`：

```powershell
node .agent-tools\scripts\template_bundle_guard.mjs check
node .agent-tools\scripts\template_bundle_guard.mjs publish
```

## 本地分发包

`pnpm agent-workspace:pack` 会在 `dist/release_artifacts/` 下生成 `@autodev/agent-workspace` 的 `.tgz` 包与 manifest（包含校验信息）。该包用于本地交付和回溯，不表示本轮发布到 npm registry。

建议在 release gate 前执行：

```powershell
pnpm agent-workspace:verify
```

该命令会执行 artifact checksum 校验，并在隔离目录做 CLI 安装/启动 smoke。

## 关键默认规则

- `init` 会复制静态模板工作区并补全 `base_url`。
- 真正的外部 Agent 验证走单个 TemplateAgent 路径，不走批量 campaign real 模式。
- 工作区产物、报告和 bundle 验证结果都留在工作区本地。
