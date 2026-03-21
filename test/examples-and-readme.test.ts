import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runBasicMemoryExample } from "../examples/basic-memory/index";
import { runAISDKChatExample } from "../examples/ai-sdk-chat/index";
import { runPrismaAdapterExample } from "../examples/prisma-adapter/index";

describe("examples and README", () => {
  it("keeps runnable examples valid", async () => {
    const basic = await runBasicMemoryExample();
    const aiSdk = await runAISDKChatExample();
    const prisma = await runPrismaAdapterExample();

    expect(basic.memoryPrompt).toContain("Structured Memory");
    expect(aiSdk.persistedMessageCount).toBeGreaterThan(0);
    expect(prisma.storedCount).toBeGreaterThan(0);
  });

  it("documents the major usage paths in the README", async () => {
    const readmePath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../README.md",
    );
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("Minimal InMemoryStore Example");
    expect(readme).toContain("AI SDK Streaming Example");
    expect(readme).toContain("Prisma Adapter Example");
    expect(readme).toContain("Structured Memory vs Naive Message Replay");
    expect(readme).toContain("Truncation vs Relay Compaction");
  });
});
