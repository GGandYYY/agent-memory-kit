# API

## Core Classes

### `StructuredMemoryEngine`

Main entry point for structured memory retrieval and post-turn ingestion.

Constructor:

```ts
new StructuredMemoryEngine(store, {
  preset,
  now?,
})
```

Methods:

- `buildContext(input: BuildContextInput): Promise<BuildContextResult>`
- `processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult>`

### `RelayCompactor`

Compacts long message histories into a relay summary plus recent window.

Method:

- `compact(input: CompactInput): Promise<CompactResult | null>`

## Stores

### `MemoryStore`

Required for `StructuredMemoryEngine`.

Methods:

- `listMemoryItems(scope)`
- `saveMemoryItem(item)`
- `updateMemoryItem(item)`
- `listEpisodes(scope, limit?)`
- `getEpisodeBySourceHash(scope, sourceHash)`
- `saveEpisode(episode)`
- `listOpenConflicts(scope, limit?)`
- `saveConflict(conflict)`
- `updateConflict(conflict)`

### `SessionStateStore`

Required for session rehydration and persistence helpers.

Methods:

- `getSessionState(scope, sessionId)`
- `upsertSessionState(state)`

### Concrete Stores

- `InMemoryStore`
- `FileStore`
- `PrismaMemoryStore`

## Integration Helpers

### `rehydrateSessionMessages`

Loads prior working messages and merges them with small incremental incoming turns.

### `persistSessionWorkingState`

Prunes and persists the latest working-message snapshot.

### `createAISDKCompactionPrepareStep`

Creates an AI SDK-compatible `prepareStep` handler that triggers compaction under:

- token pressure
- message-count pressure
- large tool-result pressure
- periodic cleanup windows

### `processCompletedTurn`

Feeds the final assistant output back into the memory engine after streaming completes.

## Public Types

### Scope and Identity

- `ScopeRef`

### Memory Domain

- `MemoryType`
- `MemorySource`
- `MemoryStatus`
- `MemoryIntent`
- `SlotCardinality`
- `SlotPolicy`
- `ClassifierResult`
- `MemoryCandidate`
- `MemoryItem`
- `Episode`
- `Conflict`
- `ConflictStatus`
- `ConflictResolution`
- `SessionState`
- `MemoryPreset`

### Engine Inputs and Outputs

- `BuildContextInput`
- `BuildContextResult`
- `ProcessTurnInput`
- `ProcessTurnResult`
- `CompactInput`
- `CompactResult`
- `CompactState`
- `PrepareStepCompactionConfig`

### Adapter Types

- `PrismaMemoryStoreConfig`
- `StructuredMemoryEngineOptions`

## Presets

### `genericPreset`

Default generic heuristics for facts, decisions, constraints, preferences, and questions.

### `platformPreset`

Optional preset carrying platform-oriented slot policies and classifiers such as:

- cloud provider
- database
- identity provider
- MFA status
- code repository platform

## Stability Notes

- v0.x APIs should be treated as iterating toward a stable public contract.
- Storage interfaces are the primary long-term compatibility surface.
- Presets are intentionally replaceable and app-specific by design.
