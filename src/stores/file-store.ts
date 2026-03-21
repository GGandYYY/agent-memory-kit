import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryStore } from "./in-memory-store";
import type { Conflict, Episode, MemoryItem, ScopeRef, SessionState } from "../types";

interface PersistedState {
  memoryItems: MemoryItem[];
  episodes: Episode[];
  conflicts: Conflict[];
  sessionStates: SessionState[];
}

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
      for (const item of parsed.memoryItems ?? []) this.memoryItems.set(item.id, this.hydrateDates<MemoryItem>(item));
      for (const item of parsed.episodes ?? []) this.episodes.set(item.id, this.hydrateDates<Episode>(item));
      for (const item of parsed.conflicts ?? []) this.conflicts.set(item.id, this.hydrateDates<Conflict>(item));
      for (const item of parsed.sessionStates ?? []) {
        this.sessionStates.set(
          this.sessionKey(item, item.sessionId),
          this.hydrateDates<SessionState>(item),
        );
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
    for (const key of ["firstObservedAt", "lastObservedAt", "lastAccessedAt", "expiresAt", "createdAt", "updatedAt", "resolvedAt"]) {
      const raw = next[key];
      if (typeof raw === "string") next[key] = new Date(raw);
    }
    return next as T;
  }

  override async listMemoryItems(scope: ScopeRef): Promise<MemoryItem[]> {
    await this.ensureLoaded();
    return super.listMemoryItems(scope);
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

  override async listEpisodes(scope: ScopeRef, limit = 10): Promise<Episode[]> {
    await this.ensureLoaded();
    return super.listEpisodes(scope, limit);
  }

  override async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null> {
    await this.ensureLoaded();
    return super.getEpisodeBySourceHash(scope, sourceHash);
  }

  override async saveEpisode(episode: Episode): Promise<void> {
    await this.ensureLoaded();
    await super.saveEpisode(episode);
    await this.persist();
  }

  override async listOpenConflicts(scope: ScopeRef, limit = 10): Promise<Conflict[]> {
    await this.ensureLoaded();
    return super.listOpenConflicts(scope, limit);
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

  override async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    await this.ensureLoaded();
    return super.getSessionState(scope, sessionId);
  }

  override async upsertSessionState(state: SessionState): Promise<void> {
    await this.ensureLoaded();
    await super.upsertSessionState(state);
    await this.persist();
  }
}
