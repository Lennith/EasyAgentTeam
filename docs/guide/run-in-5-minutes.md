# 5 分钟上手（最后更新：2026-04-25）

文档状态：`验证中`

这条路径面向第一次接触仓库的人，目标是在最短时间内使用项目专用建项目 Agent 初始化一个可用工作区。

## 前置条件

- Node.js 20+
- pnpm 9+
- PowerShell（Windows 正式 gate 路径）
- Linux/macOS 可使用产品运行时；Linux shell 脚本本轮只作为辅助入口，不进入 release gate

## 步骤

1. 安装依赖。

```powershell
pnpm i
```

2. 启动后端和 Dashboard。

```powershell
pnpm dev
```

3. 使用一等 CLI 入口 `@autodev/agent-workspace` 初始化工作区。

```powershell
pnpm agent-workspace -- init --goal "build a first project workspace" --base-url http://127.0.0.1:43123 --workspace .\tmp\project-builder-workspace
```

Linux 辅助脚本：

```sh
sh tools/linux/quickstart-agent-workspace.sh
```

4. 进入生成的工作区，按本地 TemplateAgent 提交流程检查和发布。

```powershell
node .\tmp\project-builder-workspace\.agent-tools\scripts\template_bundle_guard.mjs check
node .\tmp\project-builder-workspace\.agent-tools\scripts\template_bundle_guard.mjs publish
```

5. 如需本地交付 `@autodev/agent-workspace`，执行打包与校验。

```powershell
pnpm agent-workspace:pack
pnpm agent-workspace:verify
```

## 成功标志

- Dashboard 可以访问。
- 初始化工作区生成成功。
- `template_bundle_guard` 检查通过。
- 发布结果里能看到模板或项目注册成功。

## 下一步

- 看项目文档：[what-is-this.md](./what-is-this.md)
- 看外部 Agent 工作区说明：[agent-workspace.guide.md](./agent-workspace.guide.md)
- 做 E2E 验证：[../../E2ETest/README.md](../../E2ETest/README.md)
