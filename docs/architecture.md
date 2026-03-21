# Architecture

## Design Goal

`agent-memory-kit` keeps the parts of long-running agent context that remain useful after the original message stream becomes too expensive or too noisy to replay verbatim.

The design is deliberately layered.

## Memory Layers

### Working Memory

Working memory is the short message window that the model still benefits from seeing verbatim. It is stored in `SessionState.workingMessages`.

Use it for:

- the most recent user request
- tool result continuity
- current plan execution
- near-term conversational tone or wording

### Episodic Memory

Episodes summarize previous conversation chunks after enough interaction has accumulated. They preserve narrative continuity without storing the entire transcript.

Episode fields include:

- `sourceHash`
- `sourceMessageCount`
- `sourceTokenEstimate`
- `summaryText`
- `quality`
- `tokenSavedEstimate`

### Structured Memory

Structured memory stores durable units that should survive beyond the most recent turn window:

- `FACT`
- `CONSTRAINT`
- `DECISION`
- `PREFERENCE`
- `QUESTION`

Each memory item is scoped by `tenantId + scopeId + namespace`, so the engine remains generic and multi-tenant friendly.

### Session State

Session state persists:

- current working messages
- compaction counters
- phase metadata

This is what makes incremental turns rehydratable.

## Turn Processing Flow

1. Read incoming `UIMessage[]`.
2. Convert message parts into plain text.
3. Split messages into sentences.
4. Classify sentences through a preset.
5. Produce `MemoryCandidate` values.
6. Apply slot policy, conflict rules, TTL, and storage updates.
7. Optionally create an episode summary for long enough turns.
8. Auto-prune excess active memories.

## Retrieval Flow

`buildContext()` performs retrieval in four stages.

1. Expire stale memories first.
2. Load active memories, recent episodes, and open conflicts for the scope.
3. Build a query context from the latest user message plus retrieval corpus.
4. Score and select memories and episodes under a token budget.

The scoring is hybrid:

- lexical overlap with the current query
- source priority
- recency
- memory importance
- confidence
- weight
- pinned priority

Selection then applies:

- token budget limits
- per-slot cardinality limits
- an MMR-style diversity penalty to reduce redundant selections

## Conflict Resolution

Single-value slots can only have one active winner at a time.

When a new candidate targets a single-value slot:

- identical values refresh the existing item
- a stronger candidate can supersede the existing item
- a weaker candidate becomes a dropped record
- an uncertain high-risk conflict remains open for user confirmation

The result is stored as a `Conflict` record rather than silently overwriting a fact.

## TTL and Pruning

TTL is resolved from preset policy and memory intent.

- expired active memories become `EXPIRED`
- oversized active sets are ranked and pruned to the configured cap
- pinned items survive pruning whenever possible

## Compaction Flow

Relay compaction is separate from structured memory.

1. `prepareStep` detects token pressure or message pressure.
2. `RelayCompactor` prunes noisy history.
3. Older history becomes a relay summary.
4. A recent window is retained verbatim.
5. The new compacted message array is returned to the runtime.
6. The latest working-state snapshot is persisted after the turn.

This separation matters:

- structured memory preserves durable knowledge
- relay compaction preserves short-term execution continuity

## Storage Model

The package starts with interfaces:

- `MemoryStore`
- `SessionStateStore`

Then provides three implementations:

- `InMemoryStore`
- `FileStore`
- `PrismaMemoryStore`

The engine depends only on interfaces, so production apps can provide their own store layer without changing engine logic.
