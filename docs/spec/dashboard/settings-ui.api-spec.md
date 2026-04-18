# Settings UI 规范（最后更新：2026-04-16）

## 页面范围

- 路由：`#/settings`
- 页面由系统运行时设置和前端本地显示偏好两部分组成。

## 后端接口消费

- `GET /api/settings`
- `PATCH /api/settings`
- `GET /api/models?refresh=true`

## 当前可编辑的运行时字段

- `codexCliCommand`
- `theme`
- `minimaxApiKey`
- `minimaxApiBase`
- `minimaxModel`
- `minimaxSessionDir`
- `minimaxMaxSteps`
- `minimaxTokenLimit`

## 当前只读展示字段

- `hostPlatform`
- `hostPlatformLabel`
- `supportedShellTypes`
- `defaultShellType`
- `codexCliCommandDefault`
- `macosUntested`

## 当前本地状态

- 本地数据源模式：`Live API / Mock Data`
- 本地主题回显缓存

## 明确不属于本页的能力

- 不加载项目模板列表
- 不加载基础 prompt 文本
- 不编辑 `minimaxMaxOutputTokens`
- 不编辑任何团队、项目、workflow 级配置
