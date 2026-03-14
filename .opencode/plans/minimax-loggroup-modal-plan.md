# 计划：MiniMaxLogGroup 点击展开改为 Modal 显示

## 需求概述
将 MiniMaxLogGroup 组件的点击展开行为从"在 Task Details 面板底部展开"改为"弹出 TaskDetailsModal 显示"。

## 当前状态分析

### MiniMaxLogGroup 组件 (TaskTreeView.tsx:455-513)
- 点击时使用本地 `useState` 展开/折叠
- 内容直接渲染在 TaskTreeView 内部的 Task Details 面板底部
- 展示格式：按 stream 分组显示日志内容

### TaskDetailsModal (TaskDetailsModal.tsx)
- 尺寸：50vw x 66vh ✅
- 样式：玻璃拟态效果 (`rgba(26, 26, 26, 0.8)`, `backdropFilter: blur(10px)`) ✅
- 当前接收 props: `isOpen`, `onClose`, `children`, `timeline`, `createParams`
- 已有 `combineMiniMaxLogs` 函数处理 timeline 数据

## 实施方案

### 步骤 1：扩展 TaskDetailsModal 接口
**文件**: `dashboard-v2/src/views/TaskDetailsModal.tsx`

添加新 prop 支持直接传入 MinimaxLog 数据：
```typescript
interface TaskDetailsModalProps {
  // ... 现有 props
  minimaxLogEvents?: TaskLifecycleEvent[];  // 新增：直接传入 MinimaxLogGroup 的事件
}
```

### 步骤 2：修改 TaskDetailsModal 渲染逻辑
**文件**: `dashboard-v2/src/views/TaskDetailsModal.tsx`

在 Modal 内容区域添加对 `minimaxLogEvents` 的渲染：
- 按 stream 分组显示日志内容（复用 TaskTreeView 中的分组逻辑）
- 渲染格式与当前 MinimaxLogGroup 展开内容一致

### 步骤 3：修改 TaskTreeView 组件
**文件**: `dashboard-v2/src/views/TaskTreeView.tsx`

1. **导入 TaskDetailsModal**:
   ```typescript
   import { TaskDetailsModal } from "./TaskDetailsModal";
   import type { TaskLifecycleEvent } from "@autodev/agent_library";
   ```

2. **添加 Modal 状态**:
   ```typescript
   const [selectedMinimaxLogs, setSelectedMinimaxLogs] = useState<TaskLifecycleEvent[] | null>(null);
   ```

3. **修改 MinimaxLogGroup 点击行为**:
   - 传递 `onClick` props 给 MinimaxLogGroup
   - 点击时调用 `setSelectedMinimaxLogs(events)` 而不是本地展开

4. **渲染 Modal**:
   ```typescript
   <TaskDetailsModal
     isOpen={selectedMinimaxLogs !== null}
     onClose={() => setSelectedMinimaxLogs(null)}
     minimaxLogEvents={selectedMinimaxLogs}
   />
   ```

## 预期结果
- MiniMaxLogGroup 点击后弹出 TaskDetailsModal
- Modal 尺寸 50% x 66%，玻璃拟态效果
- Modal 内容显示与原来展开内容一致的日志分组
- 点击 Modal 关闭按钮或背景关闭 Modal

## 注意事项
- 保持原有日志分组逻辑的一致性
- Modal 关闭后状态正确重置
- 不影响现有的 TaskDetailsModal 其他功能（createParams、timeline 显示）
