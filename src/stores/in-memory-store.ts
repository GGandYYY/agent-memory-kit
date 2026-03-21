import { randomUUID } from "node:crypto";
import type {
  Conflict,
  Episode,
  MemoryItem,
  ScopeRef,
  SessionState,
} from "../types";
import type { MemoryStore, SessionStateStore } from "./interfaces";

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.scopeId === right.scopeId &&
    left.namespace === right.namespace
  );
}

export class InMemoryStore implements MemoryStore, SessionStateStore {
  protected readonly memoryItems = new Map<string, MemoryItem>();
  protected readonly episodes = new Map<string, Episode>();
  protected readonly conflicts = new Map<string, Conflict>();
  protected readonly sessionStates = new Map<string, SessionState>();

  protected nextId(prefix: string): string {
    return `${prefix}_${randomUUID()}`;
  }

  async listMemoryItems(scope: ScopeRef): Promise<MemoryItem[]> {
    return [...this.memoryItems.values()]
      .filter((item) => sameScope(item, scope))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  async saveMemoryItem(item: MemoryItem): Promise<void> {
    this.memoryItems.set(item.id || this.nextId("mem"), item);
  }

  async updateMemoryItem(item: MemoryItem): Promise<void> {
    this.memoryItems.set(item.id, item);
  }

  async listEpisodes(scope: ScopeRef, limit = 10): Promise<Episode[]> {
    return [...this.episodes.values()]
      .filter((item) => sameScope(item, scope))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null> {
    return (
      [...this.episodes.values()].find(
        (item) => sameScope(item, scope) && item.sourceHash === sourceHash,
      ) ?? null
    );
  }

  async saveEpisode(episode: Episode): Promise<void> {
    this.episodes.set(episode.id || this.nextId("episode"), episode);
  }

  async listOpenConflicts(scope: ScopeRef, limit = 10): Promise<Conflict[]> {
    return [...this.conflicts.values()]
      .filter((item) => sameScope(item, scope) && item.status === "OPEN")
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    this.conflicts.set(conflict.id || this.nextId("conflict"), conflict);
  }

  async updateConflict(conflict: Conflict): Promise<void> {
    this.conflicts.set(conflict.id, conflict);
  }

  async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    return this.sessionStates.get(this.sessionKey(scope, sessionId)) ?? null;
  }

  async upsertSessionState(state: SessionState): Promise<void> {
    this.sessionStates.set(this.sessionKey(state, state.sessionId), state);
  }

  protected sessionKey(scope: ScopeRef, sessionId: string): string {
    return `${scope.tenantId}:${scope.scopeId}:${scope.namespace}:${sessionId}`;
  }
}
