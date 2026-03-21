import { describe, expect, it } from "vitest";
import { PrismaMemoryStore } from "../src/adapters/prisma/prisma-memory-store";
import type { ScopeRef } from "../src/types";

type Row = Record<string, any>;

function createDelegate(rows: Row[] = []) {
  return {
    async findMany(args: any) {
      const where = args?.where ?? {};
      return rows.filter((row) =>
        Object.entries(where).every(([key, value]) => row[key] === value),
      );
    },
    async findFirst(args: any) {
      const results = await this.findMany(args);
      return results[0] ?? null;
    },
    async create(args: any) {
      rows.push(args.data);
      return args.data;
    },
    async update(args: any) {
      const index = rows.findIndex((row) => row.id === args.where.id);
      rows[index] = args.data;
      return args.data;
    },
    async upsert(args: any) {
      const key = args.where.tenantId_scopeId_namespace_sessionId;
      const index = rows.findIndex(
        (row) =>
          row.tenantId === key.tenantId &&
          row.scopeId === key.scopeId &&
          row.namespace === key.namespace &&
          row.sessionId === key.sessionId,
      );
      if (index >= 0) {
        rows[index] = args.update;
        return args.update;
      }
      rows.push(args.create);
      return args.create;
    },
  };
}

describe("PrismaMemoryStore", () => {
  it("maps generic delegates for memory and session state", async () => {
    const memoryRows: Row[] = [];
    const sessionRows: Row[] = [];
    const scope: ScopeRef = {
      tenantId: "tenant-prisma",
      scopeId: "scope-prisma",
      namespace: "adapter-test",
    };

    const store = new PrismaMemoryStore({
      client: {
        agentMemoryItem: createDelegate(memoryRows),
        agentEpisode: createDelegate(),
        agentConflict: createDelegate(),
        agentSessionState: createDelegate(sessionRows),
      },
      models: {
        memoryItem: "agentMemoryItem",
        episode: "agentEpisode",
        conflict: "agentConflict",
        sessionState: "agentSessionState",
      },
    });

    await store.saveMemoryItem({
      id: "mem-1",
      ...scope,
      memoryType: "FACT",
      slotKey: "general.fact",
      valueText: "Use Prisma adapter",
      source: "user_confirmed",
      confidence: 0.8,
      importance: 0.7,
      weight: 0.6,
      isPinned: false,
      status: "ACTIVE",
      supersedesId: null,
      conflictCount: 0,
      firstObservedAt: new Date("2026-01-01T00:00:00Z"),
      lastObservedAt: new Date("2026-01-01T00:00:00Z"),
      lastAccessedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: null,
      ttlDays: 120,
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    await store.upsertSessionState({
      id: "session-1",
      ...scope,
      sessionId: "session-1",
      workingMessages: [{ role: "user", content: "hello" }],
      lastMessageCount: 1,
      lastCompactionCount: 0,
      phase: null,
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const items = await store.listMemoryItems(scope);
    const session = await store.getSessionState(scope, "session-1");
    expect(items).toHaveLength(1);
    expect(session?.sessionId).toBe("session-1");
  });
});
