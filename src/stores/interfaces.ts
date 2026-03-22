import type {
  ActiveMemoryQuery,
  Conflict,
  ConflictQuery,
  Episode,
  EpisodeQuery,
  MemoryItem,
  ScopeRef,
  SessionState,
  UpsertSessionStateOptions,
} from "../types";

export interface MemoryStore {
  listActiveMemoryItems(scope: ScopeRef, options?: ActiveMemoryQuery): Promise<MemoryItem[]>;
  getActiveMemoryBySlot(scope: ScopeRef, slotKey: string): Promise<MemoryItem[]>;
  getMemoryItemById(id: string): Promise<MemoryItem | null>;
  saveMemoryItem(item: MemoryItem): Promise<void>;
  updateMemoryItem(item: MemoryItem): Promise<void>;
  bulkUpdateMemoryItems(items: MemoryItem[]): Promise<void>;
  listEpisodes(scope: ScopeRef, options?: EpisodeQuery): Promise<Episode[]>;
  getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null>;
  saveEpisode(episode: Episode): Promise<void>;
  listOpenConflicts(scope: ScopeRef, options?: ConflictQuery): Promise<Conflict[]>;
  getConflictById(scope: ScopeRef, conflictId: string): Promise<Conflict | null>;
  saveConflict(conflict: Conflict): Promise<void>;
  updateConflict(conflict: Conflict): Promise<void>;
  listExpirableMemoryItems(scope: ScopeRef, before: Date, limit?: number): Promise<MemoryItem[]>;
  countActiveMemoryItems(scope: ScopeRef): Promise<number>;
}

export interface SessionStateStore {
  getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null>;
  upsertSessionState(state: SessionState, options?: UpsertSessionStateOptions): Promise<void>;
}
