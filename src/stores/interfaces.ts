import type {
  Conflict,
  MemoryItem,
  ScopeRef,
  SessionState,
  Episode,
} from "../types";

export interface MemoryStore {
  listMemoryItems(scope: ScopeRef): Promise<MemoryItem[]>;
  saveMemoryItem(item: MemoryItem): Promise<void>;
  updateMemoryItem(item: MemoryItem): Promise<void>;
  listEpisodes(scope: ScopeRef, limit?: number): Promise<Episode[]>;
  getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null>;
  saveEpisode(episode: Episode): Promise<void>;
  listOpenConflicts(scope: ScopeRef, limit?: number): Promise<Conflict[]>;
  saveConflict(conflict: Conflict): Promise<void>;
  updateConflict(conflict: Conflict): Promise<void>;
}

export interface SessionStateStore {
  getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null>;
  upsertSessionState(state: SessionState): Promise<void>;
}
