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
} from "../../types";
import type { MemoryStore, SessionStateStore } from "../../stores/interfaces";

type Delegate = {
  findMany(args: Record<string, unknown>): Promise<any[]>;
  findFirst?(args: Record<string, unknown>): Promise<any | null>;
  findUnique?(args: Record<string, unknown>): Promise<any | null>;
  create(args: Record<string, unknown>): Promise<any>;
  update(args: Record<string, unknown>): Promise<any>;
  upsert?(args: Record<string, unknown>): Promise<any>;
  count?(args: Record<string, unknown>): Promise<number>;
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

  async listActiveMemoryItems(scope: ScopeRef, options: ActiveMemoryQuery = {}): Promise<MemoryItem[]> {
    const where: Record<string, unknown> = {
      ...this.scopeWhere(scope),
      status: "ACTIVE",
    };
    if (options.slotKeys?.length) {
      where.slotKey = { in: options.slotKeys };
    }
    if (options.updatedAfter) {
      where.updatedAt = { gt: options.updatedAfter };
    }
    return this.memoryItemModel.findMany({
      where,
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
      take: options.limit,
    }) as Promise<MemoryItem[]>;
  }

  async getActiveMemoryBySlot(scope: ScopeRef, slotKey: string): Promise<MemoryItem[]> {
    return this.memoryItemModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        status: "ACTIVE",
        slotKey,
      },
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
    }) as Promise<MemoryItem[]>;
  }

  async getMemoryItemById(id: string): Promise<MemoryItem | null> {
    if (this.memoryItemModel.findUnique) {
      return this.memoryItemModel.findUnique({ where: { id } }) as Promise<MemoryItem | null>;
    }
    if (this.memoryItemModel.findFirst) {
      return this.memoryItemModel.findFirst({ where: { id } }) as Promise<MemoryItem | null>;
    }
    const items = await this.memoryItemModel.findMany({ where: { id } });
    return (items[0] as MemoryItem | undefined) ?? null;
  }

  async saveMemoryItem(item: MemoryItem): Promise<void> {
    await this.memoryItemModel.create({ data: item });
  }

  async updateMemoryItem(item: MemoryItem): Promise<void> {
    await this.memoryItemModel.update({ where: { id: item.id }, data: item });
  }

  async bulkUpdateMemoryItems(items: MemoryItem[]): Promise<void> {
    for (const item of items) {
      await this.updateMemoryItem(item);
    }
  }

  async listEpisodes(scope: ScopeRef, options: EpisodeQuery = {}): Promise<Episode[]> {
    const where: Record<string, unknown> = this.scopeWhere(scope);
    if (options.createdAfter) {
      where.createdAt = { gt: options.createdAfter };
    }
    return this.episodeModel.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: options.limit,
    }) as Promise<Episode[]>;
  }

  async getEpisodeBySourceHash(scope: ScopeRef, sourceHash: string): Promise<Episode | null> {
    if (this.episodeModel.findFirst) {
      return this.episodeModel.findFirst({
        where: {
          ...this.scopeWhere(scope),
          sourceHash,
        },
      }) as Promise<Episode | null>;
    }
    const items = await this.episodeModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        sourceHash,
      },
      take: 1,
    });
    return (items[0] as Episode | undefined) ?? null;
  }

  async saveEpisode(episode: Episode): Promise<void> {
    await this.episodeModel.create({ data: episode });
  }

  async listOpenConflicts(scope: ScopeRef, options: ConflictQuery = {}): Promise<Conflict[]> {
    const where: Record<string, unknown> = {
      ...this.scopeWhere(scope),
      status: "OPEN",
    };
    if (options.slotKey) where.slotKey = options.slotKey;
    return this.conflictModel.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: options.limit,
    }) as Promise<Conflict[]>;
  }

  async getConflictById(scope: ScopeRef, conflictId: string): Promise<Conflict | null> {
    if (this.conflictModel.findUnique) {
      const item = await (this.conflictModel.findUnique({
        where: { id: conflictId },
      }) as Promise<Conflict | null>);
      return item && this.matchesScope(item, scope) ? item : null;
    }
    const item = this.conflictModel.findFirst
      ? await (this.conflictModel.findFirst({
          where: {
            ...this.scopeWhere(scope),
            id: conflictId,
          },
        }) as Promise<Conflict | null>)
      : null;
    if (item) return item;
    const items = await this.conflictModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        id: conflictId,
      },
      take: 1,
    });
    return (items[0] as Conflict | undefined) ?? null;
  }

  async saveConflict(conflict: Conflict): Promise<void> {
    await this.conflictModel.create({ data: conflict });
  }

  async updateConflict(conflict: Conflict): Promise<void> {
    await this.conflictModel.update({ where: { id: conflict.id }, data: conflict });
  }

  async listExpirableMemoryItems(scope: ScopeRef, before: Date, limit?: number): Promise<MemoryItem[]> {
    return this.memoryItemModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        status: "ACTIVE",
        expiresAt: { lte: before },
      },
      orderBy: { expiresAt: "asc" },
      take: limit,
    }) as Promise<MemoryItem[]>;
  }

  async countActiveMemoryItems(scope: ScopeRef): Promise<number> {
    if (this.memoryItemModel.count) {
      return this.memoryItemModel.count({
        where: {
          ...this.scopeWhere(scope),
          status: "ACTIVE",
        },
      });
    }
    const items = await this.listActiveMemoryItems(scope);
    return items.length;
  }

  async getSessionState(scope: ScopeRef, sessionId: string): Promise<SessionState | null> {
    if (this.sessionStateModel.findFirst) {
      return this.sessionStateModel.findFirst({
        where: {
          ...this.scopeWhere(scope),
          sessionId,
        },
      }) as Promise<SessionState | null>;
    }
    const items = await this.sessionStateModel.findMany({
      where: {
        ...this.scopeWhere(scope),
        sessionId,
      },
      take: 1,
    });
    return (items[0] as SessionState | undefined) ?? null;
  }

  async upsertSessionState(state: SessionState, options: UpsertSessionStateOptions = {}): Promise<void> {
    const preserveCreatedAt = options.preserveCreatedAt ?? true;
    const existing = preserveCreatedAt ? await this.getSessionState(state, state.sessionId) : null;
    const nextState = existing ? { ...state, createdAt: existing.createdAt } : state;

    if (!this.sessionStateModel.upsert) {
      if (existing) {
        await this.sessionStateModel.update({ where: { id: existing.id }, data: nextState });
        return;
      }
      await this.sessionStateModel.create({ data: nextState });
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
      create: nextState,
      update: nextState,
    });
  }

  private matchesScope(item: ScopeRef, scope: ScopeRef): boolean {
    return (
      item.tenantId === scope.tenantId &&
      item.scopeId === scope.scopeId &&
      item.namespace === scope.namespace
    );
  }
}
