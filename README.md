# agent-memory-kit

Structured memory and relay auto-compaction for TypeScript AI agents.

`agent-memory-kit` packages a reusable structured-memory and relay-compaction stack into a generic library:

- structured memory instead of naive full-history replay
- episodic summaries for long-running conversations
- conflict-aware slot updates for durable facts and decisions
- session working-memory rehydration
- relay-summary compaction instead of simple truncation
- AI SDK integration helpers for `prepareStep`, post-turn ingestion, and session persistence

The package is intentionally shaped as a standalone MIT-licensed project with a small, reusable public API.

## What Problems It Solves

Large agent systems usually fail in one of two ways:

1. They replay too much history and eventually hit context or cost limits.
2. They replay too little history and lose decisions, constraints, unresolved questions, or verified facts.

`agent-memory-kit` addresses that by separating memory into layers:

- `working memory`: the short recent window that still needs verbatim continuity
- `episodic memory`: compressed summaries of prior exchanges
- `structured memory`: durable facts, constraints, decisions, preferences, and questions
- `session state`: persisted working-message snapshots and compaction metadata

## Structured Memory vs Naive Message Replay

Naive replay keeps every past message and hopes the model re-discovers what matters. That is simple, but it has poor cost behavior and weak retrieval guarantees.

Structured memory extracts durable units such as:

- facts: `We use Bun for workers`
- constraints: `Tenant boundaries must never be crossed`
- decisions: `Use LanceDB for vector search`
- preferences: `Prefer Prisma for persistence adapters`
- questions: `Should compaction happen before or after tool execution?`

Those units become queryable memory items with scope, TTL, confidence, provenance, conflict handling, and selection logic.

## Truncation vs Relay Compaction

Simple truncation drops old messages when token pressure rises.

Relay compaction preserves continuity by:

1. pruning noisy historical messages
2. generating a structured relay summary
3. keeping a smaller recent window
4. carrying the summary forward as the compressed long-tail context

That means the agent keeps the current task, constraints, open questions, and key evidence even after aggressive compaction.

## Install

Until the package is published, use the source directly from this monorepo. Once published, the intended install flow is:

```bash
pnpm add agent-memory-kit ai
```

```bash
npm install agent-memory-kit ai
```

## Quickstart

### Minimal InMemoryStore Example

```ts
import {
  InMemoryStore,
  StructuredMemoryEngine,
  genericPreset,
} from "agent-memory-kit";

const store = new InMemoryStore();
const engine = new StructuredMemoryEngine(store, {
  preset: genericPreset,
});

await engine.processTurn({
  tenantId: "tenant-demo",
  scopeId: "scope-demo",
  namespace: "chat",
  messages: [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "We will deploy workers with Bun." }],
    },
    {
      id: "u2",
      role: "user",
      parts: [{ type: "text", text: "We must keep tenant isolation strict." }],
    },
  ],
});

const context = await engine.buildContext({
  tenantId: "tenant-demo",
  scopeId: "scope-demo",
  namespace: "chat",
  modelId: "openai:gpt-4o-mini",
  systemPrompt: "You are a coding agent.",
  modelMessages: [
    {
      role: "user",
      content: "What do we already know about the runtime and constraints?",
    },
  ],
});

console.log(context.memoryPrompt);
```

Runnable source version: [examples/basic-memory/index.ts](./examples/basic-memory/index.ts)

### AI SDK Streaming Example

```ts
import {
  InMemoryStore,
  RelayCompactor,
  StructuredMemoryEngine,
  createAISDKCompactionPrepareStep,
  genericPreset,
  persistSessionWorkingState,
  processCompletedTurn,
  rehydrateSessionMessages,
} from "agent-memory-kit";
import { streamText } from "ai";

const store = new InMemoryStore();
const engine = new StructuredMemoryEngine(store, { preset: genericPreset });
const compactor = new RelayCompactor();
const scope = { tenantId: "tenant-demo", scopeId: "scope-demo", namespace: "chat" };

const { effectiveMessages, sessionState } = await rehydrateSessionMessages({
  store,
  scope,
  sessionId: "session-1",
  incomingMessages,
});

const result = streamText({
  model,
  system: "You are a reliable copilot.",
  messages: effectiveMessages,
  prepareStep: createAISDKCompactionPrepareStep({
    compactor,
    model,
    modelContextWindow: 128_000,
    initialCompactionState: {
      count: sessionState?.lastCompactionCount ?? 0,
      lastCompactedStep: -100,
    },
  }),
});

const assistantText = await result.text;

await processCompletedTurn({
  engine,
  scope,
  messages: incomingMessages,
  assistantText,
});

await persistSessionWorkingState({
  store,
  scope,
  sessionId: "session-1",
  messages: [...effectiveMessages, { role: "assistant", content: assistantText }],
  compactionCount: sessionState?.lastCompactionCount ?? 0,
});
```

Runnable source version: [examples/ai-sdk-chat/index.ts](./examples/ai-sdk-chat/index.ts)

### Prisma Adapter Example

```ts
import {
  PrismaMemoryStore,
  StructuredMemoryEngine,
  platformPreset,
} from "agent-memory-kit";

const store = new PrismaMemoryStore({
  client: prisma,
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
```

Runnable source version: [examples/prisma-adapter/index.ts](./examples/prisma-adapter/index.ts)

## Feature Matrix

| Capability | Included |
| --- | --- |
| Structured memory types | Yes |
| Candidate extraction | Yes |
| Slot cardinality | Yes |
| Conflict handling | Yes |
| TTL / expiration | Yes |
| Episodic summaries | Yes |
| Session working-state persistence | Yes |
| Relay summary compaction | Yes |
| AI SDK prepareStep helper | Yes |
| In-memory store | Yes |
| JSON file store | Yes |
| Generic Prisma adapter | Yes |
| UI / dashboard | No |
| Evaluation harness | No |

## Store Comparison

| Store | Best for | Durability | Extra dependency |
| --- | --- | --- | --- |
| `InMemoryStore` | tests, demos, local prototypes | process lifetime only | none |
| `FileStore` | local development, examples, CLI agents | JSON file | Node filesystem |
| `PrismaMemoryStore` | production apps already using Prisma | database-backed | Prisma client delegates |

## Package Structure

```text
src/
  core/           structured memory engine
  compaction/     relay summary compactor
  stores/         interfaces + in-memory + file-backed stores
  adapters/       Prisma adapter
  presets/        generic + platform presets
  integrations/   AI SDK integration helpers
examples/         runnable example programs
docs/             architecture, API, adapters, preset design
test/             unit tests
```

## Documentation

- [Architecture](./docs/architecture.md)
- [API](./docs/api.md)
- [Adapters](./docs/adapters.md)
- [AI SDK Integration](./docs/ai-sdk-integration.md)
- [Compaction](./docs/compaction.md)
- [Preset Design](./docs/preset-design.md)
- [中文快速开始](./docs/zh-CN/quickstart.md)
- [中文设计说明](./docs/zh-CN/design-notes.md)

## Limitations

- The default extraction/classification logic is heuristic and deterministic. It is intentionally generic, not domain-perfect.
- This package does not ship vector search, embedding retrieval, or semantic memory storage.
- Relay summaries can use an LLM when you provide one, but fallback summarization is rule-based.
- The Prisma adapter is generic. It expects compatible model delegates, not a bundled Prisma schema generator.

## Non-Goals

- It is not a full agent framework.
- It does not replace your app's authorization, tenancy, or execution-context boundaries.
- It does not include UI, hosted storage, or metrics dashboards.
- It does not migrate existing production tables for you.

## License

MIT. See [LICENSE](./LICENSE).

## Publishing Intent

The package is library-first and intentionally small in scope: it focuses on reusable memory and compaction primitives that can be embedded into many different agent runtimes.
