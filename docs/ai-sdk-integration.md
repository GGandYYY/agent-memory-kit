# AI SDK Integration

## Typical Lifecycle

The package is designed around the same integration points that long-running AI SDK chat systems usually need.

### Before a Turn

1. Rehydrate session working messages.
2. Build a memory prompt from structured memory and episodic summaries.
3. Inject that prompt into your system prompt or tool context.

Example shape:

```ts
const { effectiveMessages, sessionState } = await rehydrateSessionMessages({
  store,
  scope,
  sessionId,
  incomingMessages,
});

const memory = await engine.buildContext({
  ...scope,
  modelId: "openai:gpt-4o-mini",
  systemPrompt,
  modelMessages: effectiveMessages,
});

const fullSystemPrompt = [systemPrompt, memory.memoryPrompt].filter(Boolean).join("\n\n");
```

### During Streaming

Use `createAISDKCompactionPrepareStep()` inside `streamText()` when you want automatic compaction as the step count or token pressure grows.

```ts
const prepareStep = createAISDKCompactionPrepareStep({
  compactor,
  model,
  modelContextWindow: 128_000,
  initialCompactionState: {
    count: sessionState?.lastCompactionCount ?? 0,
    lastCompactedStep: -100,
  },
});
```

The helper can trigger on:

- token soft / hard / emergency thresholds
- message-count thresholds
- large tool results
- periodic cleanup windows

### After Streaming

1. Ingest the final assistant response into structured memory.
2. Persist a fresh working-message snapshot.

```ts
await processCompletedTurn({
  engine,
  scope,
  messages: incomingMessages,
  assistantText,
});

await persistSessionWorkingState({
  store,
  scope,
  sessionId,
  messages: [...effectiveMessages, { role: "assistant", content: assistantText }],
  compactionCount: sessionState?.lastCompactionCount ?? 0,
});
```

## Where To Put Memory Prompt

Two common patterns work well:

1. append it to the main system prompt
2. inject it into a dedicated "continuity" system section

The second option is usually easier to tune because it keeps memory instructions isolated from agent identity and tool-use policy.

## What This Package Does Not Force

The helpers do not force:

- a single database choice
- a single model provider
- a specific UI transport
- a specific agent framework outside the AI SDK integration points

You can use the core engine without the AI SDK helpers if your runtime already has a custom orchestration layer.
