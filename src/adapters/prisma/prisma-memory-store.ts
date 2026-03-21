import type { Conflict, Episode, MemoryItem, ScopeRef, SessionState } from "../../types";
import type { MemoryStore, SessionStateStore } from "../../stores/interfaces";

type Delegate = {
  findMany(args: Record<string, unknown>): Promise<any[]>;
  findFirst?(args: Record<string, unknown>): Promise<any | null>;
  findUnique?(args: Record<string, unknown>): Promise<any | null>;
  create(args: Record<string, unknown>): Promise<any>;
  update(args: Record<string, unknown>): Promise<any>;
  upsert?(args: Record<string, unknown>): Promise<any>;
};

export interface PrismaMemoryStoreConfig {
  client: Record<string, Delegate>;
  models?: {
    memoryItem?: string;
    episode?: string;
    conflict?: string;
    sessionState?: string;
  };
}

export class PrismaMemoryStore implements MemoryStore, SessionStateStore {
  private readonly memoryItemModel: Delegate;
  private readonly episodeModel: Delegate;
  private readonly conflictModel: Delegate;
  private readonly sessionStateModel: Delegate;

  constructor(config: PrismaMemoryStoreConfig) {
    this.memoryItemModel = this.resolveDelegate(config, "memoryItem", "memoryItem");
    this.episodeModel = this.resolveDelegate(config, "episode", "episode");
    this.conflictModel = this.resolveDelegate(config, "conflict", "conflict");
    this.sessionStateModel = this.resolveDelegate(config, "sessionState", "sessionState");
  }

  private resolveDelegate(
    config: PrismaMemoryStoreConfig,
    key: keyof NonNullable<PrismaMemoryStoreConfig["models"]>,
    fallback: string,
  ): Delegate {
    const name = config.models?.[key] ?? fallback;
    const delegate = config.client[name];
    if (!delegate) {
      throw new Error(`PrismaMemoryStore missing delegate "${name}"`);
    }
    return delegate;
  }

  private scopeWhere(scope: ScopeRef): Record<string, unknown> {
    return {
      tenantId: scope.tenantId,
      scopeId: scope.scopeId,
      namespace: scope.namespace,
    };
  }

  async listMemoryItems(scope: ScopeRef): Promise<MemoryItem[]> {
    return this.memoryItemModel.findMany({
      where: this.scopeWhere(scope),
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
    }) as Promise<MemoryItem[]>;
  }

  async saveMemoryItem(item: MemoryItem): Promise<void> {
    await this.memoryItemModel.create({ data: item });
  }

  async updateMemoryItem(item: MemoryItem): Promise<void> {
    await this.memoryItemModel.update({ where: { id: item.id }, data: item });
  }

  async listEpisodes(scope: ScopeRef, limit = 10): Promise<Episode[]> {
    return this.episodeModel.findMany({
      where: this.scopeWhere(scope),
      orderBy: { createdAt: "desc" },
      take: limit,
    }) as Promise<Episode[]>;
  }

  async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null> {
    if (this.episodeModel.findFirst) {
      return (this.episodeModel.findFirst({
        where: {
          ...this.scopeWhere(scope),
          sourceHash,
        },
      }) as Promise<Episode | null>);
    }
    const items = await this.listEpisodes(scope, 100);
    return items.find((item) => item.sourceHash === sourceHash) ?? null;
  }

  async saveEpisode(episode: Episode): Promise<void> {
    await this.episodeModel.create({ data: episode });
  }

  async listOpenConflicts(scope: ScopeRef, limit = 10): Promise<Conflict[]> {
    return this.conflictModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        status: "OPEN",
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }) as Promise<Conflict[]>;
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    await this.conflictModel.create({ data: conflict });
  }

  async updateConflict(conflict: Conflict): Promise<void> {
    await this.conflictModel.update({ where: { id: conflict.id }, data: conflict });
  }

  async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    if (this.sessionStateModel.findFirst) {
      return (this.sessionStateModel.findFirst({
        where: {
          ...this.scopeWhere(scope),
          sessionId,
        },
      }) as Promise<SessionState | null>);
    }
    return null;
  }

  async upsertSessionState(state: SessionState): Promise<void> {
    if (!this.sessionStateModel.upsert) {
      const existing = await this.getSessionState(state, state.sessionId);
      if (existing) {
        await this.sessionStateModel.update({ where: { id: existing.id }, data: state });
        return;
      }
      await this.sessionStateModel.create({ data: state });
      return;
    }
    await this.sessionStateModel.upsert({
      where: {
        tenantId_scopeId_namespace_sessionId: {
          tenantId: state.tenantId,
          scopeId: state.scopeId,
          namespace: state.namespace,
          sessionId: state.sessionId,
        },
      },
      create: state,
      update: state,
    });
  }
}
