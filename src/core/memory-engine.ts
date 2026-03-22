import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type {
  BuildContextInput,
  BuildContextResult,
  Conflict,
  ConflictResolution,
  Episode,
  MemoryCandidate,
  MemoryItem,
  MemoryIntent,
  MemoryPreset,
  MemorySource,
  MemoryType,
  ProcessTurnInput,
  ProcessTurnResult,
  QueryContext,
  ResolveConflictInput,
  ResolveConflictResult,
  ScopeRef,
  SlotPolicy,
} from "../types";
import type { MemoryStore } from "../stores/interfaces";
import { TokenCounter } from "../utils/token-counter";
import {
  addDays,
  average,
  clamp01,
  messageToText,
  normalizeText,
  splitIntoSentences,
} from "../utils/text";

const MAX_ACTIVE_MEMORIES = 120;
const MAX_CANDIDATES_PER_TURN = 20;
const MAX_CANDIDATES_PER_SLOT = 2;
const MAX_RETRIEVAL_MEMORY_CANDIDATES = 240;
const RECENT_MEMORY_FALLBACK_LIMIT = 120;
const MAX_EPISODE_CANDIDATES = 18;
const MEMORY_SECTION_BUDGET_RATIO = 0.65;
const EPISODE_SECTION_BUDGET_RATIO = 0.3;
const RETRIEVAL_MIN_RELEVANCE = 0.12;
const EPISODE_MIN_RELEVANCE = 0.08;
const MMR_LAMBDA = 0.78;
const MMR_DIVERSITY_PENALTY = 0.22;
const EPISODE_SUMMARY_MIN_TOKENS = 120;

const SOURCE_PRIORITY: Record<MemorySource, number> = {
  user_confirmed: 4,
  tool_verified: 3,
  assistant_inferred: 2,
  system: 1,
};

type SelectionEntry<T> = {
  item: T;
  text: string;
  score: number;
  relevance: number;
  slotKey?: string;
  pinned?: boolean;
};

export interface StructuredMemoryEngineOptions {
  preset: MemoryPreset;
  now?: () => Date;
}

export class StructuredMemoryEngine {
  private readonly preset: MemoryPreset;
  private readonly now: () => Date;

  constructor(
    private readonly store: MemoryStore,
    options: StructuredMemoryEngineOptions,
  ) {
    this.preset = options.preset;
    this.now = options.now ?? (() => new Date());
  }

  async buildContext(input: BuildContextInput): Promise<BuildContextResult> {
    const now = this.now();
    await this.expireMemories(this.scopeFromInput(input), now);

    const scope = this.scopeFromInput(input);
    const queryContext = this.buildQueryContext(input.systemPrompt, input.modelMessages);
    const [memoryItems, episodes, openConflicts] = await Promise.all([
      this.loadMemoryCandidates(scope, queryContext),
      this.store.listEpisodes(scope, { limit: MAX_EPISODE_CANDIDATES }),
      this.store.listOpenConflicts(scope, { limit: 6 }),
    ]);

    const memoryTokenBudget = this.calculateMemoryBudget({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      modelMessages: input.modelMessages,
    });

    if (memoryTokenBudget <= 0) {
      return {
        memoryPrompt: "",
        selectedMemoryCount: 0,
        selectedEpisodeCount: 0,
        openConflictCount: openConflicts.length,
        memoryTokenBudget,
        memoryTokensUsed: 0,
        retrievalQueryTokenCount: queryContext.tokens.length,
        selectedRelevantMemoryCount: 0,
        selectedRelevantEpisodeCount: 0,
        avgSelectedMemoryRelevance: 0,
        avgSelectedEpisodeRelevance: 0,
        candidateMemoryCount: memoryItems.length,
        candidateEpisodeCount: episodes.length,
        relevanceThresholdUsed: RETRIEVAL_MIN_RELEVANCE,
        pinnedMemoryCount: memoryItems.filter((item) => item.isPinned).length,
      };
    }

    const memoryBudget = Math.floor(memoryTokenBudget * MEMORY_SECTION_BUDGET_RATIO);
    const episodeBudget = Math.floor(memoryTokenBudget * EPISODE_SECTION_BUDGET_RATIO);

    const scoredMemories = memoryItems
      .map((item) => {
        const relevance = this.computeMemoryRelevance(item, queryContext);
        return {
          item,
          text: this.memoryItemToSearchText(item),
          score: this.computeMemoryRetrievalScore(item, now, relevance),
          relevance,
          slotKey: item.slotKey,
          pinned: item.isPinned,
        } satisfies SelectionEntry<MemoryItem>;
      })
      .filter((entry) => entry.item.isPinned || entry.relevance >= RETRIEVAL_MIN_RELEVANCE)
      .sort((left, right) => {
        if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
        return right.score - left.score;
      });

    const memorySelection = this.selectWithBudgetAndMmr(scoredMemories, memoryBudget, (entry) =>
      this.renderMemoryLine(entry.item),
    );

    const scoredEpisodes = episodes
      .map((episode) => {
        const relevance = this.computeEpisodeRelevance(episode, queryContext);
        return {
          item: episode,
          text: episode.summaryText,
          score: this.computeEpisodeRetrievalScore(episode, now, relevance),
          relevance,
        } satisfies SelectionEntry<Episode>;
      })
      .filter((entry) => entry.relevance >= EPISODE_MIN_RELEVANCE)
      .sort((left, right) => right.score - left.score);

    const episodeSelection = this.selectWithBudgetAndMmr(scoredEpisodes, episodeBudget, (entry) =>
      `- ${entry.item.summaryText}`,
    );

    const selectedItems = memorySelection.selected.map((entry) => entry.item);
    const selectedEpisodes = episodeSelection.selected.map((entry) => entry.item);
    const tokensUsed = memorySelection.tokensUsed + episodeSelection.tokensUsed;

    const touchedItems = selectedItems
      .filter((item) => item.lastAccessedAt.getTime() !== now.getTime())
      .map((item) => ({
        ...item,
        lastAccessedAt: now,
        updatedAt: now,
      }));
    if (touchedItems.length > 0) {
      await this.store.bulkUpdateMemoryItems(touchedItems);
    }

    return {
      memoryPrompt: this.renderMemoryPrompt(selectedItems, selectedEpisodes, openConflicts),
      selectedMemoryCount: selectedItems.length,
      selectedEpisodeCount: selectedEpisodes.length,
      openConflictCount: openConflicts.length,
      memoryTokenBudget,
      memoryTokensUsed: tokensUsed,
      retrievalQueryTokenCount: queryContext.tokens.length,
      selectedRelevantMemoryCount: memorySelection.selected.filter((entry) => entry.relevance >= RETRIEVAL_MIN_RELEVANCE).length,
      selectedRelevantEpisodeCount: episodeSelection.selected.filter((entry) => entry.relevance >= EPISODE_MIN_RELEVANCE).length,
      avgSelectedMemoryRelevance: average(memorySelection.selected.map((entry) => entry.relevance)),
      avgSelectedEpisodeRelevance: average(episodeSelection.selected.map((entry) => entry.relevance)),
      candidateMemoryCount: memoryItems.length,
      candidateEpisodeCount: episodes.length,
      relevanceThresholdUsed: RETRIEVAL_MIN_RELEVANCE,
      pinnedMemoryCount: memoryItems.filter((item) => item.isPinned).length,
    };
  }

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
    const now = input.now ?? this.now();
    const scope = this.scopeFromInput(input);
    await this.expireMemories(scope, now);

    const messages = input.messages.filter((message) => messageToText(message).trim().length > 0);
    const candidates = this.extractCandidates(scope, messages).slice(0, MAX_CANDIDATES_PER_TURN);

    let created = 0;
    let updated = 0;
    let dropped = 0;
    let conflicts = 0;
    let openConflicts = 0;

    for (const candidate of candidates) {
      const result = await this.upsertCandidate(candidate, now);
      created += result.created;
      updated += result.updated;
      dropped += result.dropped;
      conflicts += result.conflicts;
      openConflicts += result.openConflicts;
    }

    const episodesCreated = await this.createEpisodeIfNeeded(scope, messages, now);
    const autoPruned = await this.autoPruneMemories(scope, now);

    return {
      created,
      updated,
      dropped,
      conflicts,
      openConflicts,
      episodesCreated,
      autoPruned,
      admitted: created + updated,
      filteredOut: Math.max(0, candidates.length - (created + updated + dropped)),
    };
  }

  async resolveConflict(input: ResolveConflictInput): Promise<ResolveConflictResult> {
    const now = input.now ?? this.now();
    const scope = this.scopeFromInput(input);
    const conflict = await this.store.getConflictById(scope, input.conflictId);
    if (!conflict) {
      throw new Error(`Conflict "${input.conflictId}" not found`);
    }
    if (conflict.status !== "OPEN") {
      throw new Error(`Conflict "${input.conflictId}" is already resolved`);
    }

    const existing = await this.store.getMemoryItemById(conflict.existingMemoryId);
    const candidate = await this.store.getMemoryItemById(conflict.newMemoryId);
    if (!existing || !candidate) {
      throw new Error(`Conflict "${input.conflictId}" is missing linked memory items`);
    }

    let nextExisting = existing;
    let nextCandidate = candidate;
    let winnerMemory = candidate;

    if (input.winner === "existing") {
      nextExisting = { ...existing, status: "ACTIVE", updatedAt: now };
      nextCandidate = { ...candidate, status: "DROPPED", updatedAt: now };
      winnerMemory = nextExisting;
    } else if (input.winner === "candidate") {
      nextExisting = { ...existing, status: "SUPERSEDED", updatedAt: now };
      nextCandidate = { ...candidate, status: "ACTIVE", updatedAt: now };
      winnerMemory = nextCandidate;
    } else {
      const mergedValue = input.mergedValue?.trim();
      if (!mergedValue) {
        throw new Error("resolveConflict winner=merged requires mergedValue");
      }
      nextExisting = { ...existing, status: "SUPERSEDED", updatedAt: now };
      nextCandidate = {
        ...candidate,
        status: "ACTIVE",
        valueText: mergedValue,
        metadata: {
          ...(candidate.metadata ?? {}),
          ...(input.metadata ?? {}),
          mergedFromConflictId: conflict.id,
        },
        updatedAt: now,
        lastObservedAt: now,
        lastAccessedAt: now,
      };
      winnerMemory = nextCandidate;
    }

    await this.store.bulkUpdateMemoryItems([nextExisting, nextCandidate]);

    const nextConflict: Conflict = {
      ...conflict,
      resolution: input.winner === "merged" ? "merged" : input.winner,
      status: "RESOLVED",
      winningMemoryId: winnerMemory.id,
      metadata: {
        ...(conflict.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
      resolvedAt: now,
      updatedAt: now,
    };
    await this.store.updateConflict(nextConflict);

    return {
      conflict: nextConflict,
      winnerMemory,
      affectedMemoryIds: [nextExisting.id, nextCandidate.id],
    };
  }

  private scopeFromInput(input: ScopeRef): ScopeRef {
    return {
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      namespace: input.namespace,
    };
  }

  private async loadMemoryCandidates(scope: ScopeRef, queryContext: QueryContext): Promise<MemoryItem[]> {
    const activeCount = await this.store.countActiveMemoryItems(scope);
    if (activeCount <= MAX_RETRIEVAL_MEMORY_CANDIDATES) {
      return this.store.listActiveMemoryItems(scope, { limit: MAX_RETRIEVAL_MEMORY_CANDIDATES });
    }

    const candidates: MemoryItem[] = [];
    const seen = new Set<string>();
    const hintedSlotKeys = [...queryContext.slotHints];

    if (hintedSlotKeys.length > 0) {
      const hinted = await this.store.listActiveMemoryItems(scope, {
        slotKeys: hintedSlotKeys,
        limit: MAX_RETRIEVAL_MEMORY_CANDIDATES,
      });
      for (const item of hinted) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        candidates.push(item);
      }
    }

    const recent = await this.store.listActiveMemoryItems(scope, { limit: RECENT_MEMORY_FALLBACK_LIMIT });
    for (const item of recent) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      candidates.push(item);
    }

    return candidates.slice(0, MAX_RETRIEVAL_MEMORY_CANDIDATES);
  }

  private calculateMemoryBudget(input: {
    modelId: string;
    systemPrompt: string;
    modelMessages: Array<any>;
  }): number {
    const systemTokens = TokenCounter.estimateTokens(input.systemPrompt);
    const messageTokens = TokenCounter.estimateTokens(JSON.stringify(input.modelMessages));
    return Math.max(
      0,
      Math.floor(
        TokenCounter.calculateConversationBudget({
          modelId: input.modelId,
          reservedForSystem: systemTokens,
          reservedForMessages: messageTokens,
        }) * 0.35,
      ),
    );
  }

  private buildQueryContext(systemPrompt: string, messages: Array<any>): QueryContext {
    const latestUserQuery = this.extractLatestUserQueryFromModelMessages(messages);
    const recentContext = messages
      .slice(-4)
      .map((message) => this.modelMessageToText(message))
      .filter(Boolean)
      .join("\n");
    const querySeed = [latestUserQuery, recentContext, systemPrompt].filter(Boolean).join("\n");
    const normalizedQueryText = normalizeText(querySeed);
    const tokens = Array.from(new Set(normalizedQueryText.split(/\s+/).filter((token) => token.length > 2))).slice(0, 40);
    const slotHints = new Set<string>();

    for (const token of tokens) {
      if (token.includes(".")) slotHints.add(token);
    }
    for (const [slotKey, policy] of Object.entries(this.preset.slotPolicies)) {
      if (normalizedQueryText.includes(normalizeText(slotKey))) {
        slotHints.add(slotKey);
      }
      for (const alias of policy.aliases ?? []) {
        if (normalizedQueryText.includes(normalizeText(alias))) {
          slotHints.add(slotKey);
        }
      }
    }

    return {
      queryText: latestUserQuery,
      normalizedQueryText,
      tokens,
      slotHints,
    };
  }

  private extractLatestUserQueryFromModelMessages(messages: Array<any>): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "user") continue;
      const text = this.modelMessageToText(message);
      if (text) return text;
    }
    return "";
  }

  private modelMessageToText(message: any): string {
    if (typeof message?.content === "string") return message.content;
    if (Array.isArray(message?.content)) {
      return message.content
        .filter((part: any) => part?.type === "text")
        .map((part: any) => String(part.text ?? ""))
        .join("\n");
    }
    return "";
  }

  private computeMemoryRelevance(item: MemoryItem, queryContext: QueryContext): number {
    if (queryContext.tokens.length === 0) return item.isPinned ? 1 : 0.2;
    const normalized = normalizeText(this.memoryItemToSearchText(item));
    const words = new Set(normalized.split(/\s+/).filter(Boolean));
    const lexicalHits = queryContext.tokens.filter((token) => words.has(token)).length;
    const lexicalOverlap = clamp01(lexicalHits / Math.max(1, queryContext.tokens.length));

    const slotSignals = [item.slotKey, ...(this.preset.slotPolicies[item.slotKey]?.aliases ?? [])]
      .map((value) => normalizeText(value))
      .filter(Boolean);
    const slotMatch = slotSignals.some((value) => queryContext.normalizedQueryText.includes(value)) || queryContext.slotHints.has(item.slotKey)
      ? 1
      : 0;

    const focusTypes = this.inferQueryMemoryTypeFocus(queryContext.normalizedQueryText);
    const typeAffinity = focusTypes.size === 0 ? 0.5 : focusTypes.has(item.memoryType) ? 1 : 0;

    return clamp01(0.55 * lexicalOverlap + 0.3 * slotMatch + 0.15 * typeAffinity);
  }

  private computeEpisodeRelevance(episode: Episode, queryContext: QueryContext): number {
    if (queryContext.tokens.length === 0) return 0.2;
    const normalized = normalizeText(episode.summaryText);
    const words = new Set(normalized.split(/\s+/).filter(Boolean));
    const lexicalHits = queryContext.tokens.filter((token) => words.has(token)).length;
    return clamp01(lexicalHits / Math.max(1, queryContext.tokens.length));
  }

  private inferQueryMemoryTypeFocus(normalizedQueryText: string): Set<MemoryType> {
    const focus = new Set<MemoryType>();
    if (/(decision|decide|choice|chosen|plan|方案|决定|计划)/i.test(normalizedQueryText)) {
      focus.add("DECISION");
    }
    if (/(constraint|must|required|nonnegotiable|constraint|限制|约束|必须|不能|不得)/i.test(normalizedQueryText)) {
      focus.add("CONSTRAINT");
    }
    if (/(prefer|preference|倾向|偏好|最好)/i.test(normalizedQueryText)) {
      focus.add("PREFERENCE");
    }
    if (/(question|unknown|unclear|pending|问题|待确认|未确认)/i.test(normalizedQueryText)) {
      focus.add("QUESTION");
    }
    if (focus.size === 0 && /(fact|know|established|already|已知|已经|现有)/i.test(normalizedQueryText)) {
      focus.add("FACT");
    }
    return focus;
  }

  private computeMemoryRetrievalScore(item: MemoryItem, now: Date, relevance: number): number {
    const ageDays = Math.max(0, (now.getTime() - item.lastObservedAt.getTime()) / (1000 * 60 * 60 * 24));
    const recency = clamp01(1 - ageDays / 120);
    const sourceScore = clamp01((SOURCE_PRIORITY[item.source] ?? 1) / 4);
    return (
      0.26 * relevance +
      0.22 * clamp01(item.importance) +
      0.16 * clamp01(item.confidence) +
      0.1 * clamp01(item.weight) +
      0.12 * recency +
      0.08 * sourceScore +
      (item.isPinned ? 0.16 : 0)
    );
  }

  private computeEpisodeRetrievalScore(episode: Episode, now: Date, relevance: number): number {
    const ageDays = Math.max(0, (now.getTime() - episode.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const recency = clamp01(1 - ageDays / 60);
    return 0.5 * relevance + 0.3 * clamp01(episode.quality) + 0.2 * recency;
  }

  private selectWithBudgetAndMmr<T>(
    entries: Array<SelectionEntry<T>>,
    tokenBudget: number,
    renderLine: (entry: SelectionEntry<T>) => string,
  ): { selected: Array<SelectionEntry<T>>; tokensUsed: number } {
    const selected: Array<SelectionEntry<T>> = [];
    const slotCounts = new Map<string, number>();
    let tokensUsed = 0;
    const remaining = [...entries];

    while (remaining.length > 0) {
      let bestIndex = -1;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (candidate.slotKey) {
          const count = slotCounts.get(candidate.slotKey) ?? 0;
          if (count >= MAX_CANDIDATES_PER_SLOT && !candidate.pinned) continue;
        }
        const line = renderLine(candidate);
        const lineTokens = TokenCounter.estimateTokens(line);
        if (tokensUsed + lineTokens > tokenBudget && selected.length > 0) continue;

        const diversityPenalty =
          selected.length === 0
            ? 0
            : Math.max(...selected.map((picked) => this.computeTextSimilarity(picked.text, candidate.text)));
        const mmrScore = MMR_LAMBDA * candidate.score - MMR_DIVERSITY_PENALTY * diversityPenalty;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = index;
        }
      }
      if (bestIndex === -1) break;
      const winner = remaining.splice(bestIndex, 1)[0];
      const line = renderLine(winner);
      const lineTokens = TokenCounter.estimateTokens(line);
      if (tokensUsed + lineTokens > tokenBudget && selected.length > 0) break;
      selected.push(winner);
      tokensUsed += lineTokens;
      if (winner.slotKey) {
        slotCounts.set(winner.slotKey, (slotCounts.get(winner.slotKey) ?? 0) + 1);
      }
    }

    return { selected, tokensUsed };
  }

  private computeTextSimilarity(left: string, right: string): number {
    const leftTokens = new Set(normalizeText(left).split(/\s+/).filter(Boolean));
    const rightTokens = new Set(normalizeText(right).split(/\s+/).filter(Boolean));
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
    let shared = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) shared += 1;
    }
    return clamp01(shared / Math.max(leftTokens.size, rightTokens.size));
  }

  private renderMemoryPrompt(items: MemoryItem[], episodes: Episode[], conflicts: Conflict[]): string {
    if (items.length === 0 && episodes.length === 0 && conflicts.length === 0) return "";

    const lines: string[] = [];
    lines.push("## Structured Memory");
    lines.push("Use this memory to preserve continuity, constraints, decisions, and open questions.");

    if (items.length > 0) {
      lines.push("");
      lines.push("### Memory Items");
      lines.push(...items.map((item) => this.renderMemoryLine(item)));
    }

    if (episodes.length > 0) {
      lines.push("");
      lines.push("### Episodic Summaries");
      lines.push(...episodes.map((episode) => `- ${episode.summaryText}`));
    }

    if (conflicts.length > 0) {
      lines.push("");
      lines.push("### Open Conflicts");
      lines.push(
        ...conflicts.map(
          (conflict) => `- [${conflict.slotKey}] ${conflict.reason} (status=${conflict.status})`,
        ),
      );
    }

    return lines.join("\n");
  }

  private renderMemoryLine(item: MemoryItem): string {
    return `- [${item.memoryType}] (${item.slotKey}) ${item.valueText} | source=${item.source} confidence=${item.confidence.toFixed(2)}`;
  }

  private memoryItemToSearchText(item: MemoryItem): string {
    return [item.slotKey, item.valueText, item.memoryType, item.source].join(" ");
  }

  private extractCandidates(scope: ScopeRef, messages: UIMessage[]): MemoryCandidate[] {
    const deduped = new Map<string, MemoryCandidate>();

    for (const message of messages.slice(-12)) {
      const source = this.resolveSource(message.role);
      const text = messageToText(message);
      for (const sentence of splitIntoSentences(text)) {
        const classified = this.preset.classifySentence(sentence);
        if (!classified) continue;
        const intent = this.inferMemoryIntent(sentence, classified.memoryType);
        const canonicalValue = classified.canonicalValue?.trim().toLowerCase() ?? null;
        const candidate: MemoryCandidate = {
          ...scope,
          slotKey: classified.slotKey,
          memoryType: intent === "QUESTION" ? "QUESTION" : classified.memoryType,
          valueText: sentence.slice(0, 800),
          source,
          confidence: classified.confidence,
          importance: classified.importance,
          weight: classified.weight,
          isPinned: classified.isPinned || Boolean(this.preset.slotPolicies[classified.slotKey]?.isPinned),
          ttlDays: this.resolveTtlDaysForIntent(intent, classified.ttlDays),
          overrideSignal: classified.overrideSignal,
          intent,
          canonicalValue,
          metadata: {
            ...(classified.metadata ?? {}),
            intent,
            canonicalValue,
          },
        };

        const dedupeKey = `${candidate.slotKey}:${canonicalValue ?? normalizeText(candidate.valueText)}`;
        const existing = deduped.get(dedupeKey);
        if (!existing || this.candidateStrength(candidate) > this.candidateStrength(existing)) {
          deduped.set(dedupeKey, candidate);
        }
      }
    }

    return [...deduped.values()].sort((left, right) => this.candidateStrength(right) - this.candidateStrength(left));
  }

  private resolveSource(role: string): MemorySource {
    if (role === "user") return "user_confirmed";
    if (role === "tool") return "tool_verified";
    if (role === "assistant") return "assistant_inferred";
    return "system";
  }

  private inferMemoryIntent(sentence: string, fallbackType: MemoryType): MemoryIntent {
    const normalized = normalizeText(sentence);
    if (/[?？]$/.test(sentence.trim())) return "QUESTION";
    if (/(what|which|how|why|是否|吗|么|怎么|如何)/i.test(normalized)) return "QUESTION";
    if (/(please|help|can you|need you to|generate|prepare|list|create|build|draft|帮我|请|生成|整理|准备|列出|给我)/i.test(normalized)) {
      return "TASK";
    }
    if (/(fyi|note that|记住|注意|顺带|另外)/i.test(normalized)) return "NOTE";
    if (fallbackType === "DECISION") return "DECISION";
    return "FACT";
  }

  private resolveTtlDaysForIntent(intent: MemoryIntent, fallbackTtl: number | null): number | null {
    if (intent === "QUESTION") return 45;
    if (intent === "TASK") return 30;
    if (intent === "NOTE") return 60;
    return fallbackTtl;
  }

  private async upsertCandidate(
    candidate: MemoryCandidate,
    now: Date,
  ): Promise<{ created: number; updated: number; dropped: number; conflicts: number; openConflicts: number }> {
    const activeItems = await this.store.getActiveMemoryBySlot(candidate, candidate.slotKey);
    const sameValue = activeItems.find((item) => this.isSameMemoryValue(item, candidate));
    if (sameValue) {
      await this.store.updateMemoryItem({
        ...sameValue,
        confidence: Math.max(sameValue.confidence, candidate.confidence),
        importance: Math.max(sameValue.importance, candidate.importance),
        weight: Math.max(sameValue.weight, candidate.weight),
        lastObservedAt: now,
        lastAccessedAt: now,
        updatedAt: now,
      });
      return { created: 0, updated: 1, dropped: 0, conflicts: 0, openConflicts: 0 };
    }

    const slotPolicy = this.resolveSlotPolicy(candidate.slotKey);
    if (slotPolicy.cardinality !== "single" || activeItems.length === 0) {
      await this.store.saveMemoryItem(this.createMemoryItem(candidate, now, "ACTIVE"));
      return { created: 1, updated: 0, dropped: 0, conflicts: 0, openConflicts: 0 };
    }

    const existing = activeItems[0];
    const winner = this.chooseConflictWinner(existing, candidate, now, slotPolicy);

    if (winner === "candidate") {
      const nextExisting = { ...existing, status: "SUPERSEDED" as const, updatedAt: now };
      const nextCandidate = this.createMemoryItem(candidate, now, "ACTIVE", existing.id);
      const conflict = this.createConflict(candidate, existing.id, nextCandidate.id, nextCandidate.id, winner, now, "RESOLVED");
      await this.store.bulkUpdateMemoryItems([nextExisting]);
      await this.store.saveMemoryItem(nextCandidate);
      await this.store.saveConflict(conflict);
      return { created: 1, updated: 1, dropped: 0, conflicts: 1, openConflicts: 0 };
    }

    if (winner === "existing") {
      const dropped = this.createMemoryItem(candidate, now, "DROPPED", existing.id);
      const conflict = this.createConflict(candidate, existing.id, dropped.id, existing.id, winner, now, "RESOLVED");
      await this.store.saveMemoryItem(dropped);
      await this.store.saveConflict(conflict);
      return { created: 0, updated: 0, dropped: 1, conflicts: 1, openConflicts: 0 };
    }

    const conflicted = this.createMemoryItem(candidate, now, "CONFLICTED", existing.id);
    const conflict = this.createConflict(candidate, existing.id, conflicted.id, null, "needs_user", now, "OPEN");
    await this.store.saveMemoryItem(conflicted);
    await this.store.saveConflict(conflict);
    return { created: 0, updated: 0, dropped: 0, conflicts: 1, openConflicts: 1 };
  }

  private resolveSlotPolicy(slotKey: string): SlotPolicy {
    return this.preset.slotPolicies[slotKey] ?? { cardinality: "multi" };
  }

  private createMemoryItem(
    candidate: MemoryCandidate,
    now: Date,
    status: MemoryItem["status"],
    supersedesId?: string | null,
  ): MemoryItem {
    return {
      id: `mem_${randomUUID()}`,
      tenantId: candidate.tenantId,
      scopeId: candidate.scopeId,
      namespace: candidate.namespace,
      memoryType: candidate.memoryType,
      slotKey: candidate.slotKey,
      valueText: candidate.valueText,
      valueJson: null,
      source: candidate.source,
      confidence: candidate.confidence,
      importance: candidate.importance,
      weight: candidate.weight,
      isPinned: candidate.isPinned,
      status,
      supersedesId: supersedesId ?? null,
      conflictCount: status === "CONFLICTED" ? 1 : 0,
      firstObservedAt: now,
      lastObservedAt: now,
      lastAccessedAt: now,
      expiresAt: candidate.ttlDays == null ? null : addDays(now, candidate.ttlDays),
      ttlDays: candidate.ttlDays,
      metadata: candidate.metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  private createConflict(
    candidate: MemoryCandidate,
    existingMemoryId: string,
    newMemoryId: string,
    winningMemoryId: string | null,
    resolution: ConflictResolution,
    now: Date,
    status: Conflict["status"],
  ): Conflict {
    return {
      id: `conflict_${randomUUID()}`,
      tenantId: candidate.tenantId,
      scopeId: candidate.scopeId,
      namespace: candidate.namespace,
      slotKey: candidate.slotKey,
      existingMemoryId,
      newMemoryId,
      winningMemoryId,
      reason: `Conflicting value observed for slot ${candidate.slotKey}`,
      status,
      resolution,
      metadata: candidate.metadata,
      resolvedAt: status === "RESOLVED" ? now : null,
      createdAt: now,
      updatedAt: now,
    };
  }

  private chooseConflictWinner(
    existing: MemoryItem,
    candidate: MemoryCandidate,
    now: Date,
    slotPolicy: SlotPolicy,
  ): ConflictResolution {
    if (candidate.overrideSignal) {
      if (candidate.source === "user_confirmed" || candidate.source === "tool_verified") {
        return "candidate";
      }
      if (slotPolicy.isHighRisk) return "needs_user";
    }

    const existingPriority = SOURCE_PRIORITY[existing.source] ?? 1;
    const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 1;
    if (slotPolicy.isHighRisk && existingPriority === candidatePriority) {
      return "needs_user";
    }
    if (candidatePriority > existingPriority) return "candidate";
    if (existingPriority > candidatePriority) return "existing";

    const existingScore = this.computeMemoryRetrievalScore(existing, now, 0.6);
    const candidateScore = this.candidateStrength(candidate);
    const delta = candidateScore - existingScore;
    if (delta > 0.08) return "candidate";
    if (delta < -0.08) return "existing";
    return "needs_user";
  }

  private candidateStrength(candidate: MemoryCandidate): number {
    const sourceScore = clamp01((SOURCE_PRIORITY[candidate.source] ?? 1) / 4);
    return (
      0.34 * clamp01(candidate.importance) +
      0.24 * clamp01(candidate.confidence) +
      0.16 * clamp01(candidate.weight) +
      0.12 * sourceScore +
      0.08 * (candidate.overrideSignal ? 1 : 0) +
      (candidate.isPinned ? 0.12 : 0)
    );
  }

  private isSameMemoryValue(existing: MemoryItem, candidate: MemoryCandidate): boolean {
    const existingCanonical = typeof existing.metadata?.canonicalValue === "string"
      ? existing.metadata.canonicalValue.trim().toLowerCase()
      : null;
    const candidateCanonical = candidate.canonicalValue?.trim().toLowerCase() ?? null;
    if (existingCanonical && candidateCanonical) {
      return existingCanonical === candidateCanonical;
    }
    return normalizeText(existing.valueText) === normalizeText(candidate.valueText);
  }

  private async createEpisodeIfNeeded(scope: ScopeRef, messages: UIMessage[], now: Date): Promise<number> {
    const sourceText = messages
      .map((message) => `${message.role}: ${messageToText(message)}`)
      .join("\n");
    const sourceTokenEstimate = TokenCounter.estimateTokens(sourceText);
    const hasUser = messages.some((message) => message.role === "user");
    const hasAssistantOrTool = messages.some(
      (message) =>
        message.role === "assistant" ||
        Boolean((message.parts as Array<any> | undefined)?.some((part) => typeof part?.type === "string" && part.type.startsWith("tool-"))),
    );

    if (!hasUser || !hasAssistantOrTool || sourceTokenEstimate < EPISODE_SUMMARY_MIN_TOKENS) {
      return 0;
    }

    const sourceHash = createHash("sha256").update(normalizeText(sourceText)).digest("hex");
    const existing = await this.store.getEpisodeBySourceHash(scope, sourceHash);
    if (existing) return 0;

    const summary =
      this.preset.summarizeEpisode?.(messages) ??
      this.summarizeEpisode(messages, sourceTokenEstimate);
    if (!summary.summaryText.trim()) return 0;

    await this.store.saveEpisode({
      id: `episode_${randomUUID()}`,
      ...scope,
      sourceHash,
      sourceMessageCount: messages.length,
      sourceTokenEstimate,
      summaryText: summary.summaryText,
      summaryJson: summary.summaryJson,
      quality: summary.quality,
      tokenSavedEstimate: Math.max(0, sourceTokenEstimate - TokenCounter.estimateTokens(summary.summaryText)),
      createdAt: now,
      updatedAt: now,
    });
    return 1;
  }

  private summarizeEpisode(
    messages: UIMessage[],
    sourceTokenEstimate: number,
  ): { summaryText: string; summaryJson: Record<string, unknown>; quality: number } {
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const openQuestions = messages
      .filter((message) => message.role === "user")
      .map((message) => messageToText(message))
      .filter((text) => /[?？]/.test(text))
      .slice(-3);
    const summaryText = [
      latestUser ? `User intent: ${messageToText(latestUser).slice(0, 400)}` : "",
      latestAssistant ? `Assistant outcome: ${messageToText(latestAssistant).slice(0, 400)}` : "",
      openQuestions.length > 0 ? `Open questions: ${openQuestions.join(" | ").slice(0, 600)}` : "",
    ]
      .filter(Boolean)
      .join(" || ")
      .slice(0, 4_000);

    return {
      summaryText,
      summaryJson: {
        latestUser: latestUser ? messageToText(latestUser).slice(0, 400) : null,
        latestAssistant: latestAssistant ? messageToText(latestAssistant).slice(0, 400) : null,
        openQuestions,
        sourceTokenEstimate,
      },
      quality: clamp01(summaryText.length / 600),
    };
  }

  private async expireMemories(scope: ScopeRef, now: Date): Promise<void> {
    const expirable = await this.store.listExpirableMemoryItems(scope, now);
    if (expirable.length === 0) return;
    await this.store.bulkUpdateMemoryItems(
      expirable.map((item) => ({
        ...item,
        status: "EXPIRED" as const,
        updatedAt: now,
      })),
    );
  }

  private async autoPruneMemories(scope: ScopeRef, now: Date): Promise<number> {
    const activeCount = await this.store.countActiveMemoryItems(scope);
    if (activeCount <= MAX_ACTIVE_MEMORIES) return 0;

    const active = await this.store.listActiveMemoryItems(scope, { limit: activeCount });
    const ranked = active
      .map((item) => ({
        item,
        score: this.computeMemoryRetrievalScore(item, now, 0.35),
      }))
      .sort((left, right) => {
        if (left.item.isPinned !== right.item.isPinned) return left.item.isPinned ? -1 : 1;
        return right.score - left.score;
      });

    const keepIds = new Set(ranked.slice(0, MAX_ACTIVE_MEMORIES).map((entry) => entry.item.id));
    const toDrop = ranked
      .filter((entry) => !keepIds.has(entry.item.id) && !entry.item.isPinned)
      .map((entry) => ({
        ...entry.item,
        status: "DROPPED" as const,
        updatedAt: now,
      }));

    if (toDrop.length > 0) {
      await this.store.bulkUpdateMemoryItems(toDrop);
    }
    return toDrop.length;
  }
}
