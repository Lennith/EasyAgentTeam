# TemplateAgent Static Workspace

这个目录是可直接复制使用的静态模板工作区，不依赖动态生成 `AGENTS.md`。

## 快速开始

1. 在 `bundles/submitted.bundle.json` 写入你的模板内容。
2. 执行：

```powershell
node .agent-tools/scripts/template_bundle_guard.mjs check
node .agent-tools/scripts/template_bundle_guard.mjs publish
```

3. 查看结果：

- `reports/template-guard/last_check.json|md`
- `reports/template-guard/last_publish.json|md`

## 说明

- `publish` 只做注册，不会自动启动 run。
- 如果脚本无法定位仓库根目录，设置环境变量 `EASYAGENTTEAM_ROOT` 指向仓库根目录。
