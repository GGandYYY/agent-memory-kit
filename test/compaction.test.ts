import { describe, expect, it, vi } from "vitest";
import {
  createAISDKCompactionPrepareStep,
  persistSessionWorkingState,
  rehydrateSessionMessages,
} from "../src/integrations/ai-sdk";
import { InMemoryStore } from "../src/stores/in-memory-store";

function makeMessage(index: number) {
  return {
    id: `msg-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index} ${"context ".repeat(120)}`,
  };
}

describe("RelayCompactor", () => {
  it("generates a relay summary when summarize succeeds and includes the relay marker", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<any>("ai");
      return {
        ...actual,
        generateText: vi.fn(async () => ({
          text: [
            "[Task]",
            "- Continue the task",
            "[Decisions]",
            "- Use Bun",
            "[Constraints]",
            "- Keep isolation",
            "[Open Questions]",
            "- None",
            "[Key Evidence]",
            "- Tool output captured",
            "[Next Actions]",
            "- Finish the implementation",
          ].join("\n"),
        })),
      };
    });

    const { RelayCompactor } = await import("../src/compaction/relay-compactor");
    const compactor = new RelayCompactor();
    const result = await compactor.compact({
      stepMessages: Array.from({ length: 18 }, (_, index) => makeMessage(index)),
      stepNumber: 4,
      model: { provider: "mock" },
      modelContextWindow: 2_000,
      targetWindow: 10,
      isTokenHard: true,
      isTokenEmergency: false,
      compactReasons: ["token-hard"],
      compactionState: {
        count: 0,
        lastCompactedStep: -100,
      },
    });

    expect(result?.summaryGenerated).toBe(true);
    expect(result?.usedFallbackSummary).toBe(false);
    expect(String(result?.finalMessages[0]?.content ?? "")).toContain("[Context Relay Summary");
  });

  it("falls back when the LLM summary does not contain required sections", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<any>("ai");
      return {
        ...actual,
        generateText: vi.fn(async () => ({
          text: "This is not structured enough.",
        })),
      };
    });

    const { RelayCompactor } = await import("../src/compaction/relay-compactor");
    const compactor = new RelayCompactor();
    const result = await compactor.compact({
      stepMessages: Array.from({ length: 18 }, (_, index) => makeMessage(index)),
      stepNumber: 4,
      model: { provider: "mock" },
      modelContextWindow: 2_000,
      targetWindow: 10,
      isTokenHard: true,
      isTokenEmergency: false,
      compactReasons: ["token-hard"],
      compactionState: {
        count: 0,
        lastCompactedStep: -100,
      },
    });

    expect(result?.summaryGenerated).toBe(true);
    expect(result?.usedFallbackSummary).toBe(true);
    expect(String(result?.finalMessages[0]?.content ?? "")).toContain("[Task]");
  });

  it("triggers compaction from prepareStep on token, message count, and tool-result pressure", async () => {
    const compact = vi.fn(async () => ({
      finalMessages: [{ role: "assistant", content: "compacted" }],
      nextState: {
        count: 1,
        lastCompactedStep: 4,
      },
      summaryGenerated: true,
      usedFallbackSummary: false,
      summaryTokens: 100,
      historyTokens: 400,
      retainedMessageCount: 8,
    }));

    const prepareStep = createAISDKCompactionPrepareStep({
      compactor: { compact } as any,
      model: undefined,
      modelContextWindow: 4_000,
    });

    const result = await prepareStep({
      messages: Array.from({ length: 22 }, (_, index) => makeMessage(index)),
      stepNumber: 4,
      steps: [
        {
          toolResults: [
            {
              result: "x".repeat(5_000),
            },
          ],
        },
      ],
      experimental_context: {
        compaction: {
          count: 0,
          lastCompactedStep: -100,
        },
      },
    });

    expect(compact).toHaveBeenCalledTimes(1);
    const args = compact.mock.calls[0]?.[0];
    expect(args.compactReasons).toEqual(
      expect.arrayContaining(["message-count", "large-tool-result", "periodic"]),
    );
    expect(result.messages).toEqual([{ role: "assistant", content: "compacted" }]);
  });
});

describe("AI SDK integration", () => {
  it("does not dedupe distinct messages that only share the same text", async () => {
    const store = new InMemoryStore();
    const scope = {
      tenantId: "tenant",
      scopeId: "scope",
      namespace: "chat",
    };

    await persistSessionWorkingState({
      store,
      scope,
      sessionId: "session-1",
      messages: [
        { id: "m1", role: "user", content: "repeat" },
        { id: "m2", role: "assistant", content: "ack" },
      ],
    });

    const result = await rehydrateSessionMessages({
      store,
      scope,
      sessionId: "session-1",
      incomingMessages: [{ id: "m3", role: "user", content: "repeat" }],
    });

    expect(result.effectiveMessages).toHaveLength(3);
    expect(result.effectiveMessages[2]?.id).toBe("m3");
  });

  it("merges append-only incremental turns but refuses non-tail duplicates", async () => {
    const store = new InMemoryStore();
    const scope = {
      tenantId: "tenant",
      scopeId: "scope",
      namespace: "chat",
    };

    await persistSessionWorkingState({
      store,
      scope,
      sessionId: "session-1",
      messages: [
        { id: "m1", role: "user", content: "first" },
        { id: "m2", role: "assistant", content: "second" },
        { id: "m3", role: "user", content: "third" },
      ],
    });

    const merged = await rehydrateSessionMessages({
      store,
      scope,
      sessionId: "session-1",
      incomingMessages: [
        { id: "m3", role: "user", content: "third" },
        { id: "m4", role: "assistant", content: "fourth" },
      ],
    });
    const replaced = await rehydrateSessionMessages({
      store,
      scope,
      sessionId: "session-1",
      incomingMessages: [{ id: "m1", role: "user", content: "first" }],
    });

    expect(merged.effectiveMessages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(replaced.effectiveMessages).toEqual([{ id: "m1", role: "user", content: "first" }]);
  });

  it("preserves createdAt across repeated session persistence", async () => {
    const store = new InMemoryStore();
    const scope = {
      tenantId: "tenant",
      scopeId: "scope",
      namespace: "chat",
    };

    await persistSessionWorkingState({
      store,
      scope,
      sessionId: "session-1",
      messages: [{ id: "m1", role: "user", content: "first" }],
    });
    const createdAt = (await store.getSessionState(scope, "session-1"))!.createdAt;

    await persistSessionWorkingState({
      store,
      scope,
      sessionId: "session-1",
      messages: [
        { id: "m1", role: "user", content: "first" },
        { id: "m2", role: "assistant", content: "second" },
      ],
    });

    const persisted = await store.getSessionState(scope, "session-1");
    expect(persisted?.createdAt.getTime()).toBe(createdAt.getTime());
    expect(persisted?.messageFingerprintsTail?.length).toBeGreaterThan(0);
  });
});
