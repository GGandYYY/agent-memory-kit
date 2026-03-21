import { PrismaMemoryStore } from "../../src/adapters/prisma/prisma-memory-store";
import { StructuredMemoryEngine } from "../../src/core/memory-engine";
import { platformPreset } from "../../src/presets/platform";
import type { ScopeRef } from "../../src/types";

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
  };
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

  const items = await store.listMemoryItems(scope);

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
