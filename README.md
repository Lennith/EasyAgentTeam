# EasyAgentTeam

Task-driven multi-agent orchestration framework with project/workflow runtimes and observable execution.

## Start Here

- 文档总入口：[docs/README.md](./docs/README.md)
- 5 分钟上手：[docs/guide/run-in-5-minutes.md](./docs/guide/run-in-5-minutes.md)
- 架构与接口导航：[docs/architecture-and-api.md](./docs/architecture-and-api.md)
- E2E 说明：[E2ETest/README.md](./E2ETest/README.md)

## Common Commands

```powershell
pnpm i
pnpm dev
pnpm build
pnpm test
pnpm docs:check
pnpm e2e:first-run
```

## Project Builder Agent

首次体验默认使用一等 CLI 入口 `@autodev/agent-workspace`：

```powershell
pnpm agent-workspace -- init --goal "build a first project workspace" --base-url http://127.0.0.1:43123 --workspace .\tmp\project-builder-workspace
```

本地分发包可通过以下命令生成到 `dist/release_artifacts/`：

```powershell
pnpm agent-workspace:pack
```

完整路径、发布步骤和外部 Agent 工作区说明见：

- [docs/guide/run-in-5-minutes.md](./docs/guide/run-in-5-minutes.md)
- [docs/guide/agent-workspace.guide.md](./docs/guide/agent-workspace.guide.md)

## Release Gate

- 正式上线检测规则属于仓库流程控制，权威规则以根 [AGENTS.md](./AGENTS.md) 为准。
- [docs/ops/release-gate.sop.md](./docs/ops/release-gate.sop.md) 只说明辅助脚本和排障路径。

## License

This project is source-available for non-commercial use.
