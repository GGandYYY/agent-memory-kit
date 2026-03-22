export type {
  ActiveMemoryQuery,
  BuildContextInput,
  BuildContextResult,
  ClassifierResult,
  CompactInput,
  CompactResult,
  CompactState,
  Conflict,
  ConflictResolution,
  ConflictWinner,
  ConflictStatus,
  ConflictQuery,
  Episode,
  EpisodeQuery,
  MemoryCandidate,
  MemoryIntent,
  MemoryItem,
  MemoryPreset,
  MemorySource,
  MemoryStatus,
  MemoryType,
  PrepareStepCompactionConfig,
  ProcessTurnInput,
  ProcessTurnResult,
  ResolveConflictInput,
  ResolveConflictResult,
  ScopeRef,
  SessionState,
  SlotPolicy,
  SlotCardinality,
  UpsertSessionStateOptions,
} from "./types";
export type { MemoryStore, SessionStateStore } from "./stores/interfaces";
export type { StructuredMemoryEngineOptions } from "./core/memory-engine";
export { StructuredMemoryEngine } from "./core/memory-engine";
export { RelayCompactor } from "./compaction/relay-compactor";
export { InMemoryStore } from "./stores/in-memory-store";
export { FileStore } from "./stores/file-store";
export type { PrismaMemoryStoreConfig } from "./adapters/prisma/prisma-memory-store";
export { PrismaMemoryStore } from "./adapters/prisma/prisma-memory-store";
export { genericPreset } from "./presets/generic";
export { platformPreset } from "./presets/platform";
export {
  createAISDKCompactionPrepareStep,
  persistSessionWorkingState,
  processCompletedTurn,
  rehydrateSessionMessages,
} from "./integrations/ai-sdk";
