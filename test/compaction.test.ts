import { describe, expect, it, vi } from "vitest";
import { createAISDKCompactionPrepareStep } from "../src/integrations/ai-sdk";

function makeMessage(index: number) {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Message ${index} ${"context ".repeat(120)}`,
  };
}

describe("RelayCompactor", () => {
  it("generates a relay summary when summarize succeeds", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<any>("ai");
      return {
        ...actual,
        generateText: vi.fn(async () => ({
          text: "[Task]\n- Continue the task\n[Decisions]\n- Use Bun\n[Constraints]\n- Keep isolation\n[Open Questions]\n- None\n[Key Evidence]\n- Tool output captured\n[Next Actions]\n- Finish the implementation",
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

  it("falls back to deterministic summary when summarization fails", async () => {
    vi.resetModules();
    vi.doMock("ai", async () => {
      const actual = await vi.importActual<any>("ai");
      return {
        ...actual,
        generateText: vi.fn(async () => {
          throw new Error("LLM unavailable");
        }),
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
