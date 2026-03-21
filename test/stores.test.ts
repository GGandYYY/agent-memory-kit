import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryStore } from "../src/stores/in-memory-store";
import { FileStore } from "../src/stores/file-store";
import type { MemoryItem, ScopeRef, SessionState } from "../src/types";

const scope: ScopeRef = {
  tenantId: "tenant-store",
  scopeId: "scope-store",
  namespace: "store-tests",
};

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function baseMemoryItem(id: string): MemoryItem {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id,
    ...scope,
    memoryType: "FACT",
    slotKey: "general.fact",
    valueText: "Persistent fact",
    source: "user_confirmed",
    confidence: 0.8,
    importance: 0.7,
    weight: 0.6,
    isPinned: false,
    status: "ACTIVE",
    supersedesId: null,
    conflictCount: 0,
    firstObservedAt: now,
    lastObservedAt: now,
    lastAccessedAt: now,
    expiresAt: null,
    ttlDays: 120,
    metadata: { canonicalValue: "persistent-fact" },
    createdAt: now,
    updatedAt: now,
  };
}

function baseSessionState(id: string): SessionState {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    id,
    ...scope,
    sessionId: "session-1",
    workingMessages: [{ role: "user", content: "hello" }],
    lastMessageCount: 1,
    lastCompactionCount: 0,
    phase: "test",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

describe("stores", () => {
  it("supports the in-memory store contract", async () => {
    const store = new InMemoryStore();
    await store.saveMemoryItem(baseMemoryItem("mem-1"));
    await store.upsertSessionState(baseSessionState("state-1"));

    const items = await store.listMemoryItems(scope);
    const session = await store.getSessionState(scope, "session-1");
    expect(items).toHaveLength(1);
    expect(session?.sessionId).toBe("session-1");
  });

  it("persists and hydrates file-backed state", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-memory-kit-"));
    const filePath = path.join(tempDir, "memory.json");

    const firstStore = new FileStore(filePath);
    await firstStore.saveMemoryItem(baseMemoryItem("mem-1"));
    await firstStore.upsertSessionState(baseSessionState("state-1"));

    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("\"memoryItems\"");

    const secondStore = new FileStore(filePath);
    const items = await secondStore.listMemoryItems(scope);
    const session = await secondStore.getSessionState(scope, "session-1");
    expect(items[0]?.createdAt).toBeInstanceOf(Date);
    expect(session?.updatedAt).toBeInstanceOf(Date);
  });
});
