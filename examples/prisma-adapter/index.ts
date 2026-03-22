import { PrismaMemoryStore } from "../../src/adapters/prisma/prisma-memory-store";
import { StructuredMemoryEngine } from "../../src/core/memory-engine";
import { platformPreset } from "../../src/presets/platform";
import type { ScopeRef } from "../../src/types";

type Row = Record<string, any>;

function createDelegate(rows: Row[] = []) {
  return {
    async findMany(args: any) {
      const where = args?.where ?? {};
      let results = rows.filter((row) => matchesWhere(row, where));
      results = applyOrderBy(results, args?.orderBy);
      if (typeof args?.take === "number") {
        results = results.slice(0, args.take);
      }
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
      if (index >= 0) rows[index] = args.data;
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

function textMessage(id: string, text: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text", text }],
  };
}

export async function runPrismaAdapterExample() {
  const store = new PrismaMemoryStore({
    client: {
      agentMemoryItem: createDelegate(),
      agentEpisode: createDelegate(),
      agentConflict: createDelegate(),
      agentSessionState: createDelegate(),
    },
    models: {
      memoryItem: "agentMemoryItem",
      episode: "agentEpisode",
      conflict: "agentConflict",
      sessionState: "agentSessionState",
    },
  });

  const engine = new StructuredMemoryEngine(store, {
    preset: platformPreset,
  });

  const scope: ScopeRef = {
    tenantId: "tenant-demo",
    scopeId: "scope-demo",
    namespace: "prisma-example",
  };

  const result = await engine.processTurn({
    ...scope,
    messages: [
      textMessage("p1", "We run on AWS and use Postgres for persistence."),
    ] as any,
  });

  const items = await store.listActiveMemoryItems(scope);

  return {
    admitted: result.admitted,
    storedCount: items.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPrismaAdapterExample().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  });
}
