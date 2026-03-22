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
  it("extracts deduped candidate memories from a turn", async () => {
    const store = new InMemoryStore();
    const engine = new StructuredMemoryEngine(store, {
      preset: genericPreset,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    const result = await engine.processTurn({
      ...scope,
      messages: [
        msg("u1", "user", "We will deploy the runtime with Bun."),
        msg("u2", "user", "We will deploy the runtime with Bun."),
        msg("u3", "user", "We must keep tenant isolation strict."),
        msg("u4", "user", "How should we persist relay summaries?"),
      ] as any,
    });

    const items = await store.listActiveMemoryItems(scope);
    expect(result.admitted).toBeGreaterThanOrEqual(3);
    expect(items.map((item) => item.memoryType)).toEqual(
      expect.arrayContaining(["DECISION", "CONSTRAINT", "QUESTION"]),
    );
    expect(items.filter((item) => item.valueText.includes("deploy the runtime with Bun"))).toHaveLength(1);
  });

  it("refreshes same-value single-slot memories instead of creating duplicates", async () => {
    const store = new InMemoryStore();
    const engine = new StructuredMemoryEngine(store, {
      preset: platformPreset,
      now: () => new Date("2026-01-01T00:00:00Z"),
    });

    await engine.processTurn({
      ...scope,
      messages: [msg("u1", "user", "We run on AWS today.")] as any,
    });

    const second = await engine.processTurn({
      ...scope,
      messages: [msg("u2", "user", "Our cloud provider is Amazon Web Services.")] as any,
    });

    const items = await store.getActiveMemoryBySlot(scope, "infra.cloud_provider");
    expect(second.updated).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]?.metadata?.canonicalValue).toBe("aws");
  });

  it("creates auditable open conflicts with linked memory ids", async () => {
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

    const conflicts = await store.listOpenConflicts(scope, { limit: 10 });
    const conflict = conflicts[0];
    const newMemory = await store.getMemoryItemById(conflict!.newMemoryId);

    expect(result.openConflicts).toBe(1);
    expect(conflict?.slotKey).toBe("identity.provider");
    expect(conflict?.existingMemoryId).toBeTruthy();
    expect(conflict?.newMemoryId).toBeTruthy();
    expect(conflict?.winningMemoryId).toBeNull();
    expect(newMemory?.status).toBe("CONFLICTED");
  });

  it("resolves open conflicts and supersedes the losing memory", async () => {
    const store = new InMemoryStore();
    const fixedNow = new Date("2026-01-01T00:00:00Z");
    const engine = new StructuredMemoryEngine(store, {
      preset: platformPreset,
      now: () => fixedNow,
    });

    await engine.processTurn({
      ...scope,
      messages: [msg("u1", "user", "We use Okta as our identity provider.")] as any,
    });
    await engine.processTurn({
      ...scope,
      messages: [msg("a1", "assistant", "We should replace Okta with Auth0.")] as any,
    });

    const conflict = (await store.listOpenConflicts(scope, { limit: 1 }))[0]!;
    const resolution = await engine.resolveConflict({
      ...scope,
      conflictId: conflict.id,
      winner: "candidate",
    });

    const updatedConflict = await store.getConflictById(scope, conflict.id);
    const oldMemory = await store.getMemoryItemById(conflict.existingMemoryId);
    const newMemory = await store.getMemoryItemById(conflict.newMemoryId);

    expect(updatedConflict?.status).toBe("RESOLVED");
    expect(updatedConflict?.winningMemoryId).toBe(conflict.newMemoryId);
    expect(oldMemory?.status).toBe("SUPERSEDED");
    expect(newMemory?.status).toBe("ACTIVE");
    expect(resolution.winnerMemory.id).toBe(conflict.newMemoryId);
  });

  it("retrieves relevant memory without query-corpus self pollution", async () => {
    const store = new InMemoryStore();
    const fixedNow = new Date("2026-01-10T00:00:00Z");
    const engine = new StructuredMemoryEngine(store, {
      preset: platformPreset,
      now: () => fixedNow,
    });

    for (let index = 0; index < 12; index += 1) {
      await store.saveMemoryItem({
        id: `noise-${index}`,
        ...scope,
        memoryType: "FACT",
        slotKey: `general.fact.${index}`,
        valueText: `Unrelated business fact ${index}`,
        source: "user_confirmed",
        confidence: 0.5,
        importance: 0.35,
        weight: 0.35,
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
      id: "repo-1",
      ...scope,
      memoryType: "FACT",
      slotKey: "code.repository",
      valueText: "The source repository is hosted on GitHub.",
      source: "user_confirmed",
      confidence: 0.75,
      importance: 0.68,
      weight: 0.65,
      isPinned: false,
      status: "ACTIVE",
      supersedesId: null,
      conflictCount: 0,
      firstObservedAt: fixedNow,
      lastObservedAt: fixedNow,
      lastAccessedAt: fixedNow,
      expiresAt: null,
      ttlDays: 365,
      metadata: { canonicalValue: "github" },
      createdAt: fixedNow,
      updatedAt: fixedNow,
    } satisfies MemoryItem);

    await store.saveMemoryItem({
      id: "monitoring-1",
      ...scope,
      memoryType: "FACT",
      slotKey: "monitoring.stack",
      valueText: "Datadog is the primary monitoring stack.",
      source: "user_confirmed",
      confidence: 0.8,
      importance: 0.82,
      weight: 0.78,
      isPinned: false,
      status: "ACTIVE",
      supersedesId: null,
      conflictCount: 0,
      firstObservedAt: fixedNow,
      lastObservedAt: fixedNow,
      lastAccessedAt: fixedNow,
      expiresAt: null,
      ttlDays: 365,
      metadata: { canonicalValue: "datadog" },
      createdAt: fixedNow,
      updatedAt: fixedNow,
    } satisfies MemoryItem);

    const context = await engine.buildContext({
      ...scope,
      modelId: "openai:gpt-4o-mini",
      systemPrompt: "You are a platform operations agent.",
      modelMessages: [{ role: "user", content: "What repository and monitoring details do we have?" }],
    });

    expect(context.memoryPrompt).toContain("monitoring.stack");
    expect(context.memoryPrompt).toContain("code.repository");
    expect(context.selectedMemoryCount).toBeLessThan(context.candidateMemoryCount);
    expect(context.relevanceThresholdUsed).toBeGreaterThan(0);
  });

  it("expires stale memories, creates episodes once, and auto-prunes excess active state", async () => {
    const store = new InMemoryStore();
    const now = new Date("2026-01-10T00:00:00Z");
    const engine = new StructuredMemoryEngine(store, {
      preset: genericPreset,
      now: () => now,
    });

    await store.saveMemoryItem({
      id: "expired-1",
      ...scope,
      memoryType: "FACT",
      slotKey: "general.fact",
      valueText: "Expired fact",
      source: "user_confirmed",
      confidence: 0.6,
      importance: 0.5,
      weight: 0.5,
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

    const messages = Array.from({ length: 10 }, (_, index) =>
      msg(
        `m-${index}`,
        index % 2 === 0 ? "user" : "assistant",
        `Conversation segment ${index} with enough detail to become an episode summary and preserve context continuity over time.`,
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

    const expired = await store.getMemoryItemById("expired-1");
    const episodes = await store.listEpisodes(scope, { limit: 10 });
    const active = await store.listActiveMemoryItems(scope, { limit: 200 });

    expect(expired?.status).toBe("EXPIRED");
    expect(first.episodesCreated).toBe(1);
    expect(second.episodesCreated).toBe(0);
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.summaryJson?.sourceTokenEstimate).toBeGreaterThan(0);
    expect(first.autoPruned).toBeGreaterThan(0);
    expect(active.length).toBeLessThanOrEqual(120);
  });
});
