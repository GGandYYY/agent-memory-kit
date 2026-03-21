import type { UIMessage } from "ai";

export type MemoryType = "FACT" | "CONSTRAINT" | "DECISION" | "PREFERENCE" | "QUESTION";
export type MemorySource = "user_confirmed" | "tool_verified" | "assistant_inferred" | "system";
export type MemoryStatus = "ACTIVE" | "SUPERSEDED" | "EXPIRED" | "DROPPED";
export type MemoryIntent = "FACT" | "DECISION" | "QUESTION" | "TASK" | "NOTE";
export type SlotCardinality = "single" | "multi";
export type ConflictStatus = "OPEN" | "RESOLVED";
export type ConflictResolution =
  | "existing"
  | "candidate"
  | "needs_user"
  | "merged"
  | "superseded";

export interface ScopeRef {
  tenantId: string;
  scopeId: string;
  namespace: string;
}

export interface SlotPolicy {
  cardinality: SlotCardinality;
  ttlDays?: number | null;
  isPinned?: boolean;
  isHighRisk?: boolean;
  aliases?: string[];
}

export interface ClassifierResult {
  slotKey: string;
  memoryType: MemoryType;
  confidence: number;
  importance: number;
  weight: number;
  isPinned: boolean;
  ttlDays: number | null;
  overrideSignal: boolean;
  canonicalValue?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryCandidate extends ScopeRef {
  slotKey: string;
  memoryType: MemoryType;
  valueText: string;
  source: MemorySource;
  confidence: number;
  importance: number;
  weight: number;
  isPinned: boolean;
  ttlDays: number | null;
  hasOpenConflict: boolean;
  overrideSignal: boolean;
  intent: MemoryIntent;
  canonicalValue?: string | null;
  metadata?: Record<string, unknown>;
}

export interface MemoryItem extends ScopeRef {
  id: string;
  memoryType: MemoryType;
  slotKey: string;
  valueText: string;
  valueJson?: Record<string, unknown> | null;
  source: MemorySource;
  confidence: number;
  importance: number;
  weight: number;
  isPinned: boolean;
  status: MemoryStatus;
  supersedesId?: string | null;
  conflictCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  lastAccessedAt: Date;
  expiresAt?: Date | null;
  ttlDays?: number | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Episode extends ScopeRef {
  id: string;
  sourceHash: string;
  sourceMessageCount: number;
  sourceTokenEstimate: number;
  summaryText: string;
  summaryJson?: Record<string, unknown>;
  quality: number;
  tokenSavedEstimate: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Conflict extends ScopeRef {
  id: string;
  slotKey: string;
  existingMemoryId?: string | null;
  newMemoryId?: string | null;
  winningMemoryId?: string | null;
  reason: string;
  status: ConflictStatus;
  resolution?: ConflictResolution | null;
  metadata?: Record<string, unknown>;
  resolvedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionState extends ScopeRef {
  id: string;
  sessionId: string;
  workingMessages: Array<Record<string, unknown>>;
  lastMessageCount: number;
  lastCompactionCount: number;
  phase?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface BuildContextInput extends ScopeRef {
  modelId: string;
  systemPrompt: string;
  modelMessages: Array<any>;
}

export interface BuildContextResult {
  memoryPrompt: string;
  selectedMemoryCount: number;
  selectedEpisodeCount: number;
  openConflictCount: number;
  memoryTokenBudget: number;
  memoryTokensUsed: number;
  retrievalQueryTokenCount: number;
  selectedRelevantMemoryCount: number;
  selectedRelevantEpisodeCount: number;
  avgSelectedMemoryRelevance: number;
  avgSelectedEpisodeRelevance: number;
}

export interface ProcessTurnInput extends ScopeRef {
  messages: UIMessage[];
  now?: Date;
}

export interface ProcessTurnResult {
  created: number;
  updated: number;
  dropped: number;
  conflicts: number;
  openConflicts: number;
  episodesCreated: number;
  autoPruned: number;
  admitted: number;
  filteredOut: number;
}

export interface QueryContext {
  queryText: string;
  tokens: string[];
  expandedTokens: string[];
  slotHints: Set<string>;
}

export interface CompactState {
  count: number;
  lastCompactedStep: number;
  lastReason?: string;
  relaySummary?: string;
  relaySummaryVersion?: number;
  lastCompactedMessageCount?: number;
}

export interface CompactInput {
  stepMessages: Array<any>;
  stepNumber: number;
  model?: any;
  modelContextWindow: number;
  targetWindow: number;
  isTokenHard: boolean;
  isTokenEmergency: boolean;
  compactReasons: string[];
  compactionState: CompactState;
}

export interface CompactResult {
  finalMessages: Array<any>;
  nextState: CompactState;
  summaryGenerated: boolean;
  usedFallbackSummary: boolean;
  summaryTokens: number;
  historyTokens: number;
  retainedMessageCount: number;
}

export interface MemoryPreset {
  name: string;
  slotPolicies: Record<string, SlotPolicy>;
  classifySentence: (sentence: string) => ClassifierResult | null;
  summarizeEpisode?: (messages: UIMessage[]) => {
    summaryText: string;
    summaryJson?: Record<string, unknown>;
    quality: number;
  };
}

export interface PrepareStepCompactionConfig {
  tokenSoftRatio?: number;
  tokenHardRatio?: number;
  tokenEmergencyRatio?: number;
  messageCountCompactThreshold?: number;
  largeToolResultChars?: number;
  minStepsBetweenCompaction?: number;
  periodicInterval?: number;
  hardMessageWindow?: number;
  emergencyMessageWindow?: number;
}
