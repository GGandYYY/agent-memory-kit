import { describe, expect, it } from "vitest";
import { PrismaMemoryStore } from "../src/adapters/prisma/prisma-memory-store";
import type { MemoryItem, ScopeRef } from "../src/types";

type Row = Record<string, any>;

function createDelegate(rows: Row[] = []) {
  return {
    async findMany(args: any) {
      let results = rows.filter((row) => matchesWhere(row, args?.where ?? {}));
      results = applyOrderBy(results, args?.orderBy);
      if (typeof args?.take === "number") results = results.slice(0, args.take);
      return results;
    },
    async findFirst(args: any) {
      const results = await this.findMany({ ...args, take: 1 });
      return results[0] ?? null;
    },
    async findUnique(args: any) {
      return rows.find((row) => row.id === args?.where?.id) ?? null;
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
    async count(args: any) {
      return rows.filter((row) => matchesWhere(row, args?.where ?? {})).length;
    },
  };
}

function matchesWhere(row: Row, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, value]) => {
    const actual = row[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if ("in" in value) return value.in.includes(actual);
      if ("gt" in value) return actual > value.gt;
      if ("lte" in value) return actual <= value.lte;
    }
    return actual === value;
  });
}

function applyOrderBy(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((left, right) => {
    for (const clause of clauses) {
      const [key, direction] = Object.entries(clause)[0] as [string, "asc" | "desc"];
      const multiplier = direction === "desc" ? -1 : 1;
      if (left[key] < right[key]) return -1 * multiplier;
      if (left[key] > right[key]) return 1 * multiplier;
    }
    return 0;
  });
}

describe("PrismaMemoryStore", () => {
  it("uses targeted queries instead of scope-wide scans in consumers", async () => {
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

    const item: MemoryItem = {
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
    };

    await store.saveMemoryItem(item);
    await store.upsertSessionState({
      id: "session-1",
      ...scope,
      sessionId: "session-1",
      workingMessages: [{ role: "user", content: "hello" }],
      messageFingerprintsTail: ["id:1"],
      lastMessageCount: 1,
      lastCompactionCount: 0,
      phase: null,
      metadata: {},
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const items = await store.listActiveMemoryItems(scope, { slotKeys: ["general.fact"] });
    const session = await store.getSessionState(scope, "session-1");
    const count = await store.countActiveMemoryItems(scope);
    const fetchedById = await store.getMemoryItemById("mem-1");

    expect(items).toHaveLength(1);
    expect(count).toBe(1);
    expect(fetchedById?.id).toBe("mem-1");
    expect(session?.sessionId).toBe("session-1");
  });
});
