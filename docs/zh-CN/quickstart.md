# 快速开始

`agent-memory-kit` 是一个给 AI Agent 用的结构化记忆与自动上下文压缩工具包。

它解决的不是“怎么把所有消息重新喂给模型”，而是：

- 怎么把长期有价值的信息抽成结构化记忆
- 怎么在长对话里保留关键上下文
- 怎么在 token 压力升高时自动做 relay summary compact

## 最小示例

```ts
import {
  InMemoryStore,
  StructuredMemoryEngine,
  genericPreset,
} from "agent-memory-kit";

const store = new InMemoryStore();
const engine = new StructuredMemoryEngine(store, {
  preset: genericPreset,
});

await engine.processTurn({
  tenantId: "tenant-demo",
  scopeId: "scope-demo",
  namespace: "chat",
  messages: [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "We will deploy workers with Bun." }],
    },
  ],
});

const context = await engine.buildContext({
  tenantId: "tenant-demo",
  scopeId: "scope-demo",
  namespace: "chat",
  modelId: "openai:gpt-4o-mini",
  systemPrompt: "You are a coding agent.",
  modelMessages: [{ role: "user", content: "What runtime are we using?" }],
});
```

## 核心概念

- `working memory`：最近几轮的原始消息窗口
- `episodic memory`：把较长历史压成 episode summary
- `structured memory`：事实、约束、决策、偏好、问题
- `session state`：working messages 和 compact 状态

## 常见集成方式

1. turn 开始前先 `rehydrateSessionMessages`
2. 调 `buildContext` 生成 memory prompt
3. 把 memory prompt 拼进 system prompt
4. 用 `createAISDKCompactionPrepareStep` 接到 `streamText`
5. 回复完成后调 `processCompletedTurn`
6. 最后 `persistSessionWorkingState`

更详细内容见：

- [Architecture](../architecture.md)
- [AI SDK Integration](../ai-sdk-integration.md)
- [Compaction](../compaction.md)
