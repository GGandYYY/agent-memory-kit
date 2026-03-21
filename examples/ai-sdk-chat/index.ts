import { InMemoryStore } from "../../src/stores/in-memory-store";
import { StructuredMemoryEngine } from "../../src/core/memory-engine";
import { RelayCompactor } from "../../src/compaction/relay-compactor";
import { genericPreset } from "../../src/presets/generic";
import {
  createAISDKCompactionPrepareStep,
  persistSessionWorkingState,
  processCompletedTurn,
  rehydrateSessionMessages,
} from "../../src/integrations/ai-sdk";
import type { ScopeRef } from "../../src/types";

function textMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  } as const;
}

function runtimeMessage(role: "user" | "assistant", text: string) {
  return {
    role,
    content: text,
  } as const;
}

export async function runAISDKChatExample() {
  const store = new InMemoryStore();
  const engine = new StructuredMemoryEngine(store, {
    preset: genericPreset,
  });
  const compactor = new RelayCompactor();
  const scope: ScopeRef = {
    tenantId: "tenant-demo",
    scopeId: "scope-demo",
    namespace: "ai-sdk-chat",
  };

  const incomingMessages = [
    textMessage("u1", "user", "We will use Bun for the runtime."),
    textMessage("u2", "user", "We must keep all workspace data tenant-scoped."),
  ];
  const incomingRuntimeMessages = [
    runtimeMessage("user", "We will use Bun for the runtime."),
    runtimeMessage("user", "We must keep all workspace data tenant-scoped."),
  ];

  const { effectiveMessages, sessionState } = await rehydrateSessionMessages({
    store,
    scope,
    sessionId: "session-demo",
    incomingMessages: incomingRuntimeMessages as any,
  });

  const prepareStep = createAISDKCompactionPrepareStep({
    compactor,
    model: undefined,
    modelContextWindow: 2_000,
    initialCompactionState: {
      count: sessionState?.lastCompactionCount ?? 0,
      lastCompactedStep: -100,
    },
  });

  const oversizedMessages = Array.from({ length: 22 }, (_, index) =>
    runtimeMessage(
      index % 2 === 0 ? "user" : "assistant",
      `History message ${index} ${"context ".repeat(80)}`,
    ),
  );

  const prepareResult = await prepareStep({
    messages: oversizedMessages,
    steps: [
      {
        toolResults: [
          {
            result: "x".repeat(5_000),
          },
        ],
      },
    ],
    stepNumber: 4,
    experimental_context: {
      compaction: {
        count: 0,
        lastCompactedStep: -100,
      },
    },
  });

  const assistantText = "Acknowledged. I will preserve Bun and tenant isolation in memory.";

  await processCompletedTurn({
    engine,
    scope,
    messages: incomingMessages as any,
    assistantText,
  });

  await persistSessionWorkingState({
    store,
    scope,
    sessionId: "session-demo",
    messages: [...effectiveMessages, runtimeMessage("assistant", assistantText)],
    compactionCount: prepareResult.experimental_context?.compaction?.count ?? 0,
  });

  const persisted = await store.getSessionState(scope, "session-demo");

  return {
    compacted: Array.isArray(prepareResult.messages) && prepareResult.messages.length < oversizedMessages.length,
    persistedMessageCount: persisted?.lastMessageCount ?? 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAISDKChatExample().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  });
}
