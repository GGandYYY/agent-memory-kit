# Adapters

## InMemoryStore

Use `InMemoryStore` for:

- unit tests
- local demos
- prototype agents

Example:

```ts
import { InMemoryStore } from "agent-memory-kit";

const store = new InMemoryStore();
```

## FileStore

`FileStore` persists the same data model into a JSON file.

Use it for:

- local CLIs
- lightweight dev environments
- examples that should survive process restarts

Example:

```ts
import { FileStore } from "agent-memory-kit";

const store = new FileStore("./tmp/agent-memory-kit.json");
```

## PrismaMemoryStore

`PrismaMemoryStore` is intentionally generic. It does not assume your app already uses the exact same table names as this repository.

You pass Prisma delegates explicitly:

```ts
const store = new PrismaMemoryStore({
  client: prisma,
  models: {
    memoryItem: "agentMemoryItem",
    episode: "agentEpisode",
    conflict: "agentConflict",
    sessionState: "agentSessionState",
  },
});
```

## Recommended Prisma Schema

This package does not generate Prisma schema for you, but the expected shape is straightforward.

```prisma
model AgentMemoryItem {
  id             String   @id
  tenantId       String
  scopeId        String
  namespace      String
  memoryType     String
  slotKey        String
  valueText      String
  valueJson      Json?
  source         String
  confidence     Float
  importance     Float
  weight         Float
  isPinned       Boolean
  status         String
  supersedesId   String?
  conflictCount  Int
  firstObservedAt DateTime
  lastObservedAt  DateTime
  lastAccessedAt  DateTime
  expiresAt      DateTime?
  ttlDays        Int?
  metadata       Json?
  createdAt      DateTime
  updatedAt      DateTime

  @@index([tenantId, scopeId, namespace, status])
  @@index([tenantId, scopeId, namespace, slotKey])
}

model AgentEpisode {
  id                 String   @id
  tenantId           String
  scopeId            String
  namespace          String
  sourceHash         String
  sourceMessageCount Int
  sourceTokenEstimate Int
  summaryText        String
  summaryJson        Json?
  quality            Float
  tokenSavedEstimate Int
  createdAt          DateTime
  updatedAt          DateTime

  @@unique([tenantId, scopeId, namespace, sourceHash])
  @@index([tenantId, scopeId, namespace, createdAt])
}

model AgentConflict {
  id               String   @id
  tenantId         String
  scopeId          String
  namespace        String
  slotKey          String
  existingMemoryId String?
  newMemoryId      String?
  winningMemoryId  String?
  reason           String
  status           String
  resolution       String?
  metadata         Json?
  resolvedAt       DateTime?
  createdAt        DateTime
  updatedAt        DateTime

  @@index([tenantId, scopeId, namespace, status])
}

model AgentSessionState {
  id                 String   @id
  tenantId           String
  scopeId            String
  namespace          String
  sessionId          String
  workingMessages    Json
  lastMessageCount   Int
  lastCompactionCount Int
  phase              String?
  metadata           Json?
  createdAt          DateTime
  updatedAt          DateTime

  @@unique([tenantId, scopeId, namespace, sessionId])
}
```

## Mapping Existing Models

If your existing schema already has equivalent tables, keep your current table names and map them through `models`.

Map your existing table names through `models` and keep the engine layer unaware of those storage details.

## Adapter Guidance

- Keep `tenantId + scopeId + namespace` indexed.
- Treat `sessionId` as a unique key within a scope.
- Store timestamps as actual `DateTime` columns.
- Preserve `Json` fields for metadata and working-message snapshots.
