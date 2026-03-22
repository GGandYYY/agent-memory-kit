import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryStore } from "./in-memory-store";
import type {
  Conflict,
  Episode,
  MemoryItem,
  ScopeRef,
  SessionState,
  UpsertSessionStateOptions,
} from "../types";

interface PersistedState {
  memoryItems: MemoryItem[];
  episodes: Episode[];
  conflicts: Conflict[];
  sessionStates: SessionState[];
}

const DATE_KEYS = [
  "firstObservedAt",
  "lastObservedAt",
  "lastAccessedAt",
  "expiresAt",
  "createdAt",
  "updatedAt",
  "resolvedAt",
] as const;

export class FileStore extends InMemoryStore {
  private loaded = false;

  constructor(private readonly filePath: string) {
    super();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedState;
      for (const item of parsed.memoryItems ?? []) this.memoryItems.set(item.id, this.hydrateDates(item));
      for (const item of parsed.episodes ?? []) this.episodes.set(item.id, this.hydrateDates(item));
      for (const item of parsed.conflicts ?? []) this.conflicts.set(item.id, this.hydrateDates(item));
      for (const item of parsed.sessionStates ?? []) {
        this.sessionStates.set(this.sessionKey(item, item.sessionId), this.hydrateDates(item));
      }
    } catch {
      // First run or empty file.
    }
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const state: PersistedState = {
      memoryItems: [...this.memoryItems.values()],
      episodes: [...this.episodes.values()],
      conflicts: [...this.conflicts.values()],
      sessionStates: [...this.sessionStates.values()],
    };
    await writeFile(this.filePath, JSON.stringify(state, null, 2), "utf8");
  }

  private hydrateDates<T>(value: T): T {
    const next = { ...(value as object) } as Record<string, unknown>;
    for (const key of DATE_KEYS) {
      const raw = next[key];
      if (typeof raw === "string") next[key] = new Date(raw);
    }
    return next as T;
  }

  override async listActiveMemoryItems(scope: ScopeRef, options = {}) {
    await this.ensureLoaded();
    return super.listActiveMemoryItems(scope, options);
  }

  override async getActiveMemoryBySlot(scope: ScopeRef, slotKey: string) {
    await this.ensureLoaded();
    return super.getActiveMemoryBySlot(scope, slotKey);
  }

  override async getMemoryItemById(id: string) {
    await this.ensureLoaded();
    return super.getMemoryItemById(id);
  }

  override async saveMemoryItem(item: MemoryItem): Promise<void> {
    await this.ensureLoaded();
    await super.saveMemoryItem(item);
    await this.persist();
  }

  override async updateMemoryItem(item: MemoryItem): Promise<void> {
    await this.ensureLoaded();
    await super.updateMemoryItem(item);
    await this.persist();
  }

  override async bulkUpdateMemoryItems(items: MemoryItem[]): Promise<void> {
    await this.ensureLoaded();
    await super.bulkUpdateMemoryItems(items);
    await this.persist();
  }

  override async listEpisodes(scope: ScopeRef, options = {}) {
    await this.ensureLoaded();
    return super.listEpisodes(scope, options);
  }

  override async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string) {
    await this.ensureLoaded();
    return super.getEpisodeBySourceHash(scope, sourceHash);
  }

  override async saveEpisode(episode: Episode): Promise<void> {
    await this.ensureLoaded();
    await super.saveEpisode(episode);
    await this.persist();
  }

  override async listOpenConflicts(scope: ScopeRef, options = {}) {
    await this.ensureLoaded();
    return super.listOpenConflicts(scope, options);
  }

  override async getConflictById(scope: ScopeRef, conflictId: string) {
    await this.ensureLoaded();
    return super.getConflictById(scope, conflictId);
  }

  override async saveConflict(conflict: Conflict): Promise<void> {
    await this.ensureLoaded();
    await super.saveConflict(conflict);
    await this.persist();
  }

  override async updateConflict(conflict: Conflict): Promise<void> {
    await this.ensureLoaded();
    await super.updateConflict(conflict);
    await this.persist();
  }

  override async listExpirableMemoryItems(scope: ScopeRef, before: Date, limit?: number) {
    await this.ensureLoaded();
    return super.listExpirableMemoryItems(scope, before, limit);
  }

  override async countActiveMemoryItems(scope: ScopeRef) {
    await this.ensureLoaded();
    return super.countActiveMemoryItems(scope);
  }

  override async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    await this.ensureLoaded();
    return super.getSessionState(scope, sessionId);
  }

  override async upsertSessionState(state: SessionState, options?: UpsertSessionStateOptions): Promise<void> {
    await this.ensureLoaded();
    await super.upsertSessionState(state, options);
    await this.persist();
  }
}
