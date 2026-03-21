import { describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/in-memory-store";
import { StructuredMemoryEngine } from "../src/core/memory-engine";
import { genericPreset } from "../src/presets/generic";
import { platformPreset } from "../src/presets/platform";
import type { MemoryItem, ScopeRef } from "../src/types";

const scope: ScopeRef = {
  tenantId: "tenant-test",
  scopeId: "scope-test",
  namespace: "memory-engine",
};

function msg(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  } as const;
}

describe("StructuredMemoryEngine", () => {
  it("extracts and normalizes candidate memories from a turn", async () => {
    const store = new InMemoryStore();
    const engine = new StructuredMemoryEngine(store, {
      preset: genericPreset,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const result = await engine.processTurn({
      ...scope,
      messages: [
        msg("u1", "user", "We will deploy the runtime with Bun."),
        msg("u2", "user", "We must keep tenant isolation strict."),
        msg("u3", "user", "How should we persist relay summaries?"),
      ] as any,
    });

    const items = await store.listMemoryItems(scope);
    expect(result.admitted).toBeGreaterThanOrEqual(3);
    expect(items.map((item) => item.memoryType)).toEqual(
      expect.arrayContaining(["DECISION", "CONSTRAINT", "QUESTION"]),
    );
  });

  it("applies single-slot conflict rules and preserves open conflicts for high-risk slots", async () => {
    const store = new InMemoryStore();
    const engine = new StructuredMemoryEngine(store, {
      preset: platformPreset,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await engine.processTurn({
      ...scope,
      messages: [msg("u1", "user", "We use Okta as our identity provider.")] as any,
    });

    const result = await engine.processTurn({
      ...scope,
      messages: [msg("a1", "assistant", "We should replace Okta with Auth0.")] as any,
    });

    const conflicts = await store.listOpenConflicts(scope, 10);
    expect(result.openConflicts).toBe(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.slotKey).toBe("identity.provider");
  });

  it("expires stale memories and respects selection limits per slot", async () => {
    const store = new InMemoryStore();
    const fixedNow = new Date("2026-01-10T00:00:00Z");
    const engine = new StructuredMemoryEngine(store, {
      preset: platformPreset,
      now: () => fixedNow,
    });

    await store.saveMemoryItem({
      id: "expired-1",
      ...scope,
      memoryType: "FACT",
      slotKey: "infra.cloud_provider",
      valueText: "AWS",
      source: "user_confirmed",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.9,
      isPinned: false,
      status: "ACTIVE",
      supersedesId: null,
      conflictCount: 0,
      firstObservedAt: new Date("2025-01-01T00:00:00Z"),
      lastObservedAt: new Date("2025-01-01T00:00:00Z"),
      lastAccessedAt: new Date("2025-01-01T00:00:00Z"),
      expiresAt: new Date("2025-02-01T00:00:00Z"),
      ttlDays: 30,
      metadata: {},
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-01T00:00:00Z"),
    } satisfies MemoryItem);

    for (let index = 0; index < 4; index += 1) {
      await store.saveMemoryItem({
        id: `dup-${index}`,
        ...scope,
        memoryType: "FACT",
        slotKey: "code.repository",
        valueText: `GitHub repository ${index}`,
        source: "user_confirmed",
        confidence: 0.7,
        importance: 0.6,
        weight: 0.5,
        isPinned: false,
        status: "ACTIVE",
        supersedesId: null,
        conflictCount: 0,
        firstObservedAt: fixedNow,
        lastObservedAt: fixedNow,
        lastAccessedAt: fixedNow,
        expiresAt: null,
        ttlDays: 365,
        metadata: {},
        createdAt: fixedNow,
        updatedAt: fixedNow,
      } satisfies MemoryItem);
    }

    await store.saveMemoryItem({
      id: "repo-distinct",
      ...scope,
      memoryType: "FACT",
      slotKey: "monitoring.stack",
      valueText: "Datadog is the primary monitoring stack.",
      source: "user_confirmed",
      confidence: 0.7,
      importance: 0.6,
      weight: 0.5,
      isPinned: false,
      status: "ACTIVE",
      supersedesId: null,
      conflictCount: 0,
      firstObservedAt: fixedNow,
      lastObservedAt: fixedNow,
      lastAccessedAt: fixedNow,
      expiresAt: null,
      ttlDays: 365,
      metadata: {},
      createdAt: fixedNow,
      updatedAt: fixedNow,
    } satisfies MemoryItem);

    const context = await engine.buildContext({
      ...scope,
      modelId: "openai:gpt-4o-mini",
      systemPrompt: "You are a platform operations agent.",
      modelMessages: [{ role: "user", content: "What repository and monitoring details do we have?" }],
    });

    const lines = context.memoryPrompt
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    const repoLines = lines.filter((line) => line.includes("(code.repository)"));

    const items = await store.listMemoryItems(scope);
    const expired = items.find((item) => item.id === "expired-1");
    expect(expired?.status).toBe("EXPIRED");
    expect(repoLines.length).toBeLessThanOrEqual(2);
    expect(context.memoryPrompt).toContain("monitoring.stack");
  });

  it("creates and reuses episodic summaries for long turns", async () => {
    const store = new InMemoryStore();
    const engine = new StructuredMemoryEngine(store, {
      preset: genericPreset,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const messages = Array.from({ length: 10 }, (_, index) =>
      msg(
        `m-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Conversation segment ${index} with enough detail to become an episode summary.`,
      ),
    );

    const first = await engine.processTurn({
      ...scope,
      messages: messages as any,
    });
    const second = await engine.processTurn({
      ...scope,
      messages: messages as any,
    });

    const episodes = await store.listEpisodes(scope, 10);
    expect(first.episodesCreated).toBe(1);
    expect(second.episodesCreated).toBe(0);
    expect(episodes).toHaveLength(1);
  });

  it("auto-prunes excess active memories", async () => {
    const store = new InMemoryStore();
    const now = new Date("2026-01-01T00:00:00Z");
    const engine = new StructuredMemoryEngine(store, {
      preset: genericPreset,
      now: () => now,
    });

    for (let index = 0; index < 125; index += 1) {
      await store.saveMemoryItem({
        id: `bulk-${index}`,
        ...scope,
        memoryType: "FACT",
        slotKey: `general.fact.${index}`,
        valueText: `Fact ${index}`,
        source: "user_confirmed",
        confidence: 0.4,
        importance: 0.4,
        weight: 0.4,
        isPinned: false,
        status: "ACTIVE",
        supersedesId: null,
        conflictCount: 0,
        firstObservedAt: now,
        lastObservedAt: now,
        lastAccessedAt: now,
        expiresAt: null,
        ttlDays: 120,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      } satisfies MemoryItem);
    }

    const result = await engine.processTurn({
      ...scope,
      messages: [msg("tail", "user", "Please keep the memory set tidy.")] as any,
    });

    const items = await store.listMemoryItems(scope);
    const active = items.filter((item) => item.status === "ACTIVE");
    expect(result.autoPruned).toBe(6);
    expect(active.length).toBeLessThanOrEqual(120);
  });
});
