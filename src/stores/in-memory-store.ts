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
import type { MemoryStore, SessionStateStore } from "./interfaces";

function sameScope(left: ScopeRef, right: ScopeRef): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.scopeId === right.scopeId &&
    left.namespace === right.namespace
  );
}

function sortMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((left, right) => {
    if (left.isPinned !== right.isPinned) return left.isPinned ? -1 : 1;
    return right.updatedAt.getTime() - left.updatedAt.getTime();
  });
}

export class InMemoryStore implements MemoryStore, SessionStateStore {
  protected readonly memoryItems = new Map<string, MemoryItem>();
  protected readonly episodes = new Map<string, Episode>();
  protected readonly conflicts = new Map<string, Conflict>();
  protected readonly sessionStates = new Map<string, SessionState>();

  async listActiveMemoryItems(scope: ScopeRef, options: ActiveMemoryQuery = {}): Promise<MemoryItem[]> {
    const filtered = [...this.memoryItems.values()].filter((item) => {
      if (!sameScope(item, scope)) return false;
      if (item.status !== "ACTIVE") return false;
      if (options.slotKeys?.length && !options.slotKeys.includes(item.slotKey)) return false;
      if (options.updatedAfter && item.updatedAt.getTime() <= options.updatedAfter.getTime()) return false;
      return true;
    });
    const sorted = sortMemoryItems(filtered);
    return typeof options.limit === "number" ? sorted.slice(0, options.limit) : sorted;
  }

  async getActiveMemoryBySlot(scope: ScopeRef, slotKey: string): Promise<MemoryItem[]> {
    return this.listActiveMemoryItems(scope, { slotKeys: [slotKey] });
  }

  async getMemoryItemById(id: string): Promise<MemoryItem | null> {
    return this.memoryItems.get(id) ?? null;
  }

  async saveMemoryItem(item: MemoryItem): Promise<void> {
    this.memoryItems.set(item.id, item);
  }

  async updateMemoryItem(item: MemoryItem): Promise<void> {
    this.memoryItems.set(item.id, item);
  }

  async bulkUpdateMemoryItems(items: MemoryItem[]): Promise<void> {
    for (const item of items) {
      this.memoryItems.set(item.id, item);
    }
  }

  async listEpisodes(scope: ScopeRef, options: EpisodeQuery = {}): Promise<Episode[]> {
    const filtered = [...this.episodes.values()]
      .filter((item) => sameScope(item, scope))
      .filter((item) => !options.createdAfter || item.createdAt.getTime() > options.createdAfter.getTime())
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return typeof options.limit === "number" ? filtered.slice(0, options.limit) : filtered;
  }

  async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null> {
    return (
      [...this.episodes.values()].find(
        (item) => sameScope(item, scope) && item.sourceHash === sourceHash,
      ) ?? null
    );
  }

  async saveEpisode(episode: Episode): Promise<void> {
    this.episodes.set(episode.id, episode);
  }

  async listOpenConflicts(scope: ScopeRef, options: ConflictQuery = {}): Promise<Conflict[]> {
    const filtered = [...this.conflicts.values()]
      .filter((item) => sameScope(item, scope) && item.status === "OPEN")
      .filter((item) => !options.slotKey || item.slotKey === options.slotKey)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return typeof options.limit === "number" ? filtered.slice(0, options.limit) : filtered;
  }

  async getConflictById(scope: ScopeRef, conflictId: string): Promise<Conflict | null> {
    const conflict = this.conflicts.get(conflictId) ?? null;
    if (!conflict || !sameScope(conflict, scope)) return null;
    return conflict;
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    this.conflicts.set(conflict.id, conflict);
  }

  async updateConflict(conflict: Conflict): Promise<void> {
    this.conflicts.set(conflict.id, conflict);
  }

  async listExpirableMemoryItems(scope: ScopeRef, before: Date, limit?: number): Promise<MemoryItem[]> {
    const filtered = [...this.memoryItems.values()]
      .filter((item) => sameScope(item, scope))
      .filter((item) => item.status === "ACTIVE")
      .filter((item) => item.expiresAt != null && item.expiresAt.getTime() <= before.getTime())
      .sort((left, right) => left.expiresAt!.getTime() - right.expiresAt!.getTime());
    return typeof limit === "number" ? filtered.slice(0, limit) : filtered;
  }

  async countActiveMemoryItems(scope: ScopeRef): Promise<number> {
    return [...this.memoryItems.values()].filter((item) => sameScope(item, scope) && item.status === "ACTIVE").length;
  }

  async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    return this.sessionStates.get(this.sessionKey(scope, sessionId)) ?? null;
  }

  async upsertSessionState(state: SessionState, options: UpsertSessionStateOptions = {}): Promise<void> {
    const key = this.sessionKey(state, state.sessionId);
    const existing = this.sessionStates.get(key) ?? null;
    const preserveCreatedAt = options.preserveCreatedAt ?? true;
    this.sessionStates.set(key, {
      ...state,
      createdAt: preserveCreatedAt && existing ? existing.createdAt : state.createdAt,
    });
  }

  protected sessionKey(scope: ScopeRef, sessionId: string): string {
    return `${scope.tenantId}:${scope.scopeId}:${scope.namespace}:${sessionId}`;
  }
}
