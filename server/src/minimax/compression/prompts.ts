export const COMPRESSION_PROMPT = `你是一个上下文压缩助手。你的任务是将对话历史压缩为简洁但完整的摘要。

## 压缩目标
将以下对话历史压缩到原大小的 30%-50%，同时保留所有关键信息。

## 必须保留的信息
1. **用户身份**：用户是谁，有什么特征或偏好
2. **Agent 角色**：当前 Agent 扮演的角色和职责
3. **任务概述**：整体任务是什么
4. **最新任务**：最近正在处理的具体任务
5. **任务进度**：已完成什么，当前在做什么
6. **阻塞点**：遇到的问题或障碍
7. **后续计划**：接下来要做什么
8. **关键决策**：重要的决定和结论
9. **文件状态**：创建/修改了哪些文件，当前状态如何

## 压缩格式
请按以下格式输出压缩后的摘要：

### 用户信息
[用户身份和偏好]

### 任务概述
[整体任务描述]

### 当前进度
- 已完成：[列出已完成的工作]
- 进行中：[当前正在处理的工作]
- 阻塞点：[遇到的问题，如果没有写"无"]

### 关键决策
[重要的决定和结论]

### 文件变更
[创建或修改的文件及其状态]

### 后续计划
[接下来要做的事情]

## 原始对话历史
{conversation_history}`;

export function formatConversationHistory(
  messages: Array<{ role: string; content: string; timestamp?: string }>
): string {
  return messages
    .map((msg) => {
      const timestamp = msg.timestamp ? `[${msg.timestamp}] ` : "";
      return `${timestamp}[${msg.role.toUpperCase()}]: ${msg.content}`;
    })
    .join("\n\n");
}

export function buildCompressionPrompt(messages: Array<{ role: string; content: string; timestamp?: string }>): string {
  const history = formatConversationHistory(messages);
  return COMPRESSION_PROMPT.replace("{conversation_history}", history);
}
