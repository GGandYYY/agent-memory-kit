import { createHash, randomUUID } from "node:crypto";
import type { UIMessage } from "ai";
import type {
  BuildContextInput,
  BuildContextResult,
  Conflict,
  ConflictResolution,
  MemoryCandidate,
  MemoryItem,
  MemoryIntent,
  MemoryPreset,
  MemorySource,
  MemoryType,
  ProcessTurnInput,
  ProcessTurnResult,
  QueryContext,
} from "../types";
import type { MemoryStore } from "../stores/interfaces";
import { TokenCounter } from "../utils/token-counter";
import {
  addDays,
  average,
  clamp01,
  messageToText,
  messagesToPlainText,
  normalizeText,
  splitIntoSentences,
} from "../utils/text";

const MAX_ACTIVE_MEMORIES = 120;
const EPISODE_SUMMARY_MIN_MESSAGES = 10;
const MAX_CANDIDATES_PER_TURN = 20;
const MAX_CANDIDATES_PER_SLOT = 2;
const MEMORY_SECTION_BUDGET_RATIO = 0.65;
const EPISODE_SECTION_BUDGET_RATIO = 0.3;
const RETRIEVAL_MIN_RELEVANCE = 0.08;
const MMR_LAMBDA = 0.78;
const MMR_DIVERSITY_PENALTY = 0.22;
const SOURCE_PRIORITY: Record<MemorySource, number> = {
  user_confirmed: 4,
  tool_verified: 3,
  assistant_inferred: 2,
  system: 1,
};

export interface StructuredMemoryEngineOptions {
  preset: MemoryPreset;
  now?: () => Date;
}

type SelectionEntry<T> = {
  item: T;
  text: string;
  score: number;
  relevance: number;
  slotKey?: string;
  pinned?: boolean;
};

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
    await this.expireMemories(input.tenantId, input.scopeId, input.namespace, now);

    const scope = this.scopeFromInput(input);
    const [memoryItems, episodes, openConflicts] = await Promise.all([
      this.store.listMemoryItems(scope),
      this.store.listEpisodes(scope, 10),
      this.store.listOpenConflicts(scope, 6),
    ]);

    const activeItems = memoryItems.filter((item) => item.status === "ACTIVE");
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
        retrievalQueryTokenCount: 0,
        selectedRelevantMemoryCount: 0,
        selectedRelevantEpisodeCount: 0,
        avgSelectedMemoryRelevance: 0,
        avgSelectedEpisodeRelevance: 0,
      };
    }

    const queryText = this.extractLatestUserQueryFromModelMessages(input.modelMessages);
    const retrievalCorpus = [
      ...activeItems.map((item) => `${item.slotKey} ${item.valueText}`),
      ...episodes.map((episode) => episode.summaryText),
    ]
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 400);
    const queryContext = this.buildQueryContext(queryText, retrievalCorpus);

    const memoryBudget = Math.floor(memoryTokenBudget * MEMORY_SECTION_BUDGET_RATIO);
    const episodeBudget = Math.floor(memoryTokenBudget * EPISODE_SECTION_BUDGET_RATIO);

    const scoredMemories = activeItems
      .map((item) => {
        const relevance = this.computeHybridRelevance(`${item.slotKey} ${item.valueText}`, queryContext);
        return {
          item,
          text: this.memoryItemToSearchText(item),
          score: this.computeMemoryRetrievalScore(item, now, relevance),
          relevance,
          slotKey: item.slotKey,
          pinned: item.isPinned,
        } satisfies SelectionEntry<MemoryItem>;
      })
      .filter((entry) => entry.item.isPinned || queryContext.tokens.length === 0 || entry.relevance >= RETRIEVAL_MIN_RELEVANCE)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.score - a.score;
      });

    const memorySelection = this.selectWithBudgetAndMmr(scoredMemories, memoryBudget, (entry) =>
      this.renderMemoryLine(entry.item),
    );

    const scoredEpisodes = episodes
      .map((episode) => {
        const relevance = this.computeHybridRelevance(episode.summaryText, queryContext);
        return {
          item: episode,
          text: episode.summaryText,
          score: this.computeEpisodeRetrievalScore(episode, now, relevance),
          relevance,
        } satisfies SelectionEntry<any>;
      })
      .filter((entry) => queryContext.tokens.length === 0 || entry.relevance >= RETRIEVAL_MIN_RELEVANCE * 0.75)
      .sort((a, b) => b.score - a.score);

    const episodeSelection = this.selectWithBudgetAndMmr(scoredEpisodes, episodeBudget, (entry) =>
      `- ${entry.item.summaryText}`,
    );

    const selectedItems = memorySelection.selected.map((entry) => entry.item as MemoryItem);
    const selectedEpisodes = episodeSelection.selected.map((entry) => entry.item);
    const tokensUsed = memorySelection.tokensUsed + episodeSelection.tokensUsed;

    for (const item of selectedItems) {
      if (item.lastAccessedAt.getTime() !== now.getTime()) {
        await this.store.updateMemoryItem({ ...item, lastAccessedAt: now, updatedAt: now });
      }
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
      selectedRelevantEpisodeCount: episodeSelection.selected.filter((entry) => entry.relevance >= RETRIEVAL_MIN_RELEVANCE * 0.75).length,
      avgSelectedMemoryRelevance: average(memorySelection.selected.map((entry) => entry.relevance)),
      avgSelectedEpisodeRelevance: average(episodeSelection.selected.map((entry) => entry.relevance)),
    };
  }

  async processTurn(input: ProcessTurnInput): Promise<ProcessTurnResult> {
    const now = input.now ?? this.now();
    const scope = this.scopeFromInput(input);
    await this.expireMemories(input.tenantId, input.scopeId, input.namespace, now);

    const messages = input.messages.filter((message) => {
      const text = messageToText(message);
      return text.trim().length > 0;
    });
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

  private scopeFromInput(input: { tenantId: string; scopeId: string; namespace: string }) {
    return {
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      namespace: input.namespace,
    };
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

  private extractLatestUserQueryFromModelMessages(messages: Array<any>): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== "user") continue;
      if (typeof message?.content === "string") return message.content;
      if (Array.isArray(message?.content)) {
        return message.content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => String(part.text ?? ""))
          .join("\n");
      }
    }
    return "";
  }

  private buildQueryContext(queryText: string, corpus: string[]): QueryContext {
    const combined = `${queryText}\n${corpus.join("\n")}`;
    const tokens = normalizeText(combined)
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .slice(0, 40);
    const expandedTokens = Array.from(new Set(tokens));
    return {
      queryText,
      tokens,
      expandedTokens,
      slotHints: new Set(tokens.filter((token) => token.includes("."))),
    };
  }

  private computeHybridRelevance(text: string, queryContext: QueryContext): number {
    const normalized = normalizeText(text);
    if (!normalized || queryContext.expandedTokens.length === 0) return 0;
    const words = new Set(normalized.split(/\s+/));
    let hits = 0;
    for (const token of queryContext.expandedTokens) {
      if (words.has(token)) hits += 1;
    }
    return clamp01(hits / Math.max(1, queryContext.expandedTokens.length));
  }

  private computeMemoryRetrievalScore(item: MemoryItem, now: Date, relevance: number): number {
    const ageDays = Math.max(0, (now.getTime() - item.lastObservedAt.getTime()) / (1000 * 60 * 60 * 24));
    const recency = clamp01(1 - ageDays / 120);
    const sourceScore = clamp01((SOURCE_PRIORITY[item.source] ?? 1) / 4);
    return (
      0.32 * clamp01(item.importance) +
      0.18 * clamp01(item.confidence) +
      0.12 * clamp01(item.weight) +
      0.22 * relevance +
      0.08 * recency +
      0.08 * sourceScore +
      (item.isPinned ? 0.2 : 0)
    );
  }

  private computeEpisodeRetrievalScore(episode: any, now: Date, relevance: number): number {
    const ageDays = Math.max(0, (now.getTime() - episode.createdAt.getTime()) / (1000 * 60 * 60 * 24));
    const recency = clamp01(1 - ageDays / 60);
    return 0.42 * clamp01(episode.quality) + 0.38 * relevance + 0.2 * recency;
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
            : Math.max(
                ...selected.map((picked) => this.computeTextSimilarity(picked.text, candidate.text)),
              );
        const mmrScore =
          MMR_LAMBDA * candidate.score - MMR_DIVERSITY_PENALTY * diversityPenalty;
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

  private renderMemoryPrompt(items: MemoryItem[], episodes: any[], conflicts: Conflict[]): string {
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
      lines.push(...episodes.map((episode: any) => `- ${episode.summaryText}`));
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

  private extractCandidates(
    scope: { tenantId: string; scopeId: string; namespace: string },
    messages: UIMessage[],
  ): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    for (const message of messages.slice(-12)) {
      const source = this.resolveSource(message.role);
      const text = messageToText(message);
      for (const sentence of splitIntoSentences(text)) {
        const classified = this.preset.classifySentence(sentence);
        if (!classified) continue;
        const intent = this.inferMemoryIntent(sentence, classified.memoryType);
        candidates.push({
          ...scope,
          slotKey: classified.slotKey,
          memoryType: intent === "QUESTION" ? "QUESTION" : classified.memoryType,
          valueText: sentence.slice(0, 800),
          source,
          confidence: classified.confidence,
          importance: classified.importance,
          weight: classified.weight,
          isPinned: classified.isPinned,
          ttlDays: this.resolveTtlDaysForIntent(intent, classified.ttlDays),
          hasOpenConflict: false,
          overrideSignal: classified.overrideSignal,
          intent,
          canonicalValue: classified.canonicalValue ?? null,
          metadata: {
            ...(classified.metadata ?? {}),
            intent,
          },
        });
      }
    }
    return candidates;
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
    const allItems = await this.store.listMemoryItems(candidate);
    const activeItems = allItems.filter(
      (item) => item.status === "ACTIVE" && item.slotKey === candidate.slotKey,
    );
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

    const slotPolicy = this.preset.slotPolicies[candidate.slotKey] ?? { cardinality: "multi" as const };
    const isSingleValueSlot = slotPolicy.cardinality === "single";
    if (!isSingleValueSlot || activeItems.length === 0) {
      await this.store.saveMemoryItem(this.createActiveMemoryItem(candidate, now));
      return { created: 1, updated: 0, dropped: 0, conflicts: 0, openConflicts: 0 };
    }

    const existing = activeItems[0];
    const winner = this.chooseConflictWinner(existing, candidate, now, slotPolicy.isHighRisk ?? false);
    if (winner === "candidate") {
      await this.store.updateMemoryItem({
        ...existing,
        status: "SUPERSEDED",
        updatedAt: now,
      });
      const active = this.createActiveMemoryItem(candidate, now, existing.id);
      await this.store.saveMemoryItem(active);
      await this.store.saveConflict(this.createConflict(candidate, existing.id, active.id, winner, now));
      return { created: 1, updated: 1, dropped: 0, conflicts: 1, openConflicts: 0 };
    }
    if (winner === "existing") {
      await this.store.saveMemoryItem(this.createDroppedMemoryItem(candidate, now, existing.id));
      await this.store.saveConflict(this.createConflict(candidate, existing.id, existing.id, winner, now));
      return { created: 0, updated: 0, dropped: 1, conflicts: 1, openConflicts: 0 };
    }

    const dropped = this.createDroppedMemoryItem(candidate, now, existing.id);
    await this.store.saveMemoryItem(dropped);
    await this.store.saveConflict(this.createConflict(candidate, existing.id, null, "needs_user", now, "OPEN"));
    return { created: 0, updated: 0, dropped: 1, conflicts: 1, openConflicts: 1 };
  }

  private createActiveMemoryItem(candidate: MemoryCandidate, now: Date, supersedesId?: string | null): MemoryItem {
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
      status: "ACTIVE",
      supersedesId: supersedesId ?? null,
      conflictCount: 0,
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

  private createDroppedMemoryItem(candidate: MemoryCandidate, now: Date, supersedesId?: string | null): MemoryItem {
    return {
      ...this.createActiveMemoryItem(candidate, now, supersedesId),
      status: "DROPPED",
    };
  }

  private createConflict(
    candidate: MemoryCandidate,
    existingMemoryId: string,
    winningMemoryId: string | null,
    resolution: ConflictResolution,
    now: Date,
    status: "OPEN" | "RESOLVED" = "RESOLVED",
  ): Conflict {
    return {
      id: `conflict_${randomUUID()}`,
      tenantId: candidate.tenantId,
      scopeId: candidate.scopeId,
      namespace: candidate.namespace,
      slotKey: candidate.slotKey,
      existingMemoryId,
      newMemoryId: null,
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
    highRiskSlot: boolean,
  ): ConflictResolution {
    if (candidate.overrideSignal) {
      if (candidate.source === "user_confirmed" || candidate.source === "tool_verified") {
        return "candidate";
      }
      if (highRiskSlot) return "needs_user";
    }

    const existingPriority = SOURCE_PRIORITY[existing.source] ?? 1;
    const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 1;
    if (candidatePriority > existingPriority) return "candidate";
    if (existingPriority > candidatePriority) return "existing";

    const existingScore = this.computeMemoryRetrievalScore(existing, now, 0.6);
    const candidateScore =
      0.35 * candidate.importance +
      0.25 * candidate.confidence +
      0.2 * 1 +
      0.1 * clamp01(candidatePriority / 4) +
      0.1 * candidate.weight +
      (candidate.isPinned ? 0.2 : 0);
    const delta = candidateScore - existingScore;
    if (delta > 0.08) return "candidate";
    if (delta < -0.08) return "existing";
    return "needs_user";
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

  private async createEpisodeIfNeeded(scope: { tenantId: string; scopeId: string; namespace: string }, messages: UIMessage[], now: Date): Promise<number> {
    if (messages.length < EPISODE_SUMMARY_MIN_MESSAGES) return 0;
    const sourceText = messagesToPlainText(messages, 600);
    const sourceHash = createHash("sha256").update(sourceText).digest("hex");
    const existing = await this.store.getEpisodeBySourceHash(scope, sourceHash);
    if (existing) return 0;

    const summary =
      this.preset.summarizeEpisode?.(messages) ??
      this.summarizeEpisode(messages);
    const tokenEstimate = TokenCounter.estimateTokens(sourceText);
    await this.store.saveEpisode({
      id: `episode_${randomUUID()}`,
      ...scope,
      sourceHash,
      sourceMessageCount: messages.length,
      sourceTokenEstimate: tokenEstimate,
      summaryText: summary.summaryText,
      summaryJson: summary.summaryJson,
      quality: summary.quality,
      tokenSavedEstimate: Math.max(0, tokenEstimate - TokenCounter.estimateTokens(summary.summaryText)),
      createdAt: now,
      updatedAt: now,
    });
    return 1;
  }

  private summarizeEpisode(messages: UIMessage[]): { summaryText: string; summaryJson: Record<string, unknown>; quality: number } {
    const latestUser = [...messages].reverse().find((message) => message.role === "user");
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const unresolved = messages
      .filter((message) => message.role === "user")
      .map((message) => messageToText(message))
      .filter((text) => /[?？]/.test(text))
      .slice(-3);
    const summaryText = [
      latestUser ? `User intent: ${messageToText(latestUser).slice(0, 400)}` : "",
      latestAssistant ? `Assistant outcome: ${messageToText(latestAssistant).slice(0, 400)}` : "",
      unresolved.length > 0 ? `Open questions: ${unresolved.join(" | ").slice(0, 600)}` : "",
    ]
      .filter(Boolean)
      .join(" || ")
      .slice(0, 4_000);

    return {
      summaryText,
      summaryJson: {
        latestUser: latestUser ? messageToText(latestUser).slice(0, 400) : null,
        latestAssistant: latestAssistant ? messageToText(latestAssistant).slice(0, 400) : null,
        unresolved,
      },
      quality: clamp01(summaryText.length / 600),
    };
  }

  private async expireMemories(tenantId: string, scopeId: string, namespace: string, now: Date): Promise<void> {
    const items = await this.store.listMemoryItems({ tenantId, scopeId, namespace });
    for (const item of items) {
      if (item.status !== "ACTIVE") continue;
      if (item.expiresAt && item.expiresAt.getTime() <= now.getTime()) {
        await this.store.updateMemoryItem({
          ...item,
          status: "EXPIRED",
          updatedAt: now,
        });
      }
    }
  }

  private async autoPruneMemories(scope: { tenantId: string; scopeId: string; namespace: string }, now: Date): Promise<number> {
    const active = (await this.store.listMemoryItems(scope)).filter((item) => item.status === "ACTIVE");
    if (active.length <= MAX_ACTIVE_MEMORIES) return 0;

    const ranked = active
      .map((item) => ({
        item,
        score: this.computeMemoryRetrievalScore(item, now, 0.35),
      }))
      .sort((a, b) => {
        if (a.item.isPinned !== b.item.isPinned) return a.item.isPinned ? -1 : 1;
        return b.score - a.score;
      });

    const keepIds = new Set(ranked.slice(0, MAX_ACTIVE_MEMORIES).map((entry) => entry.item.id));
    const toDrop = ranked.filter((entry) => !keepIds.has(entry.item.id) && !entry.item.isPinned);
    for (const entry of toDrop) {
      await this.store.updateMemoryItem({
        ...entry.item,
        status: "DROPPED",
        updatedAt: now,
      });
    }
    return toDrop.length;
  }
}
