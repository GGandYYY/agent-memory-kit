import { createHash } from "node:crypto";
import { pruneMessages, type UIMessage } from "ai";
import type {
  CompactState,
  PrepareStepCompactionConfig,
  ScopeRef,
  SessionState,
} from "../types";
import type { SessionStateStore } from "../stores/interfaces";
import { TokenCounter } from "../utils/token-counter";
import { RelayCompactor } from "../compaction/relay-compactor";

const DEFAULT_CONFIG: Required<PrepareStepCompactionConfig> = {
  tokenSoftRatio: 0.32,
  tokenHardRatio: 0.45,
  tokenEmergencyRatio: 0.6,
  messageCountCompactThreshold: 18,
  largeToolResultChars: 4_000,
  minStepsBetweenCompaction: 2,
  periodicInterval: 4,
  hardMessageWindow: 14,
  emergencyMessageWindow: 10,
};

export async function rehydrateSessionMessages(input: {
  store: SessionStateStore;
  scope: ScopeRef;
  sessionId: string;
  incomingMessages: any[];
  incrementalThreshold?: number;
}): Promise<{ effectiveMessages: any[]; sessionState: SessionState | null }> {
  const sessionState = await input.store.getSessionState(input.scope, input.sessionId);
  const storedWorkingMessages = Array.isArray(sessionState?.workingMessages)
    ? (sessionState.workingMessages as any[])
    : [];
  if (storedWorkingMessages.length === 0) {
    return { effectiveMessages: input.incomingMessages, sessionState };
  }

  const threshold = input.incrementalThreshold ?? 2;
  if (input.incomingMessages.length > threshold) {
    return { effectiveMessages: input.incomingMessages, sessionState };
  }

  const storedFingerprints = sessionState?.messageFingerprintsTail?.length
    ? sessionState.messageFingerprintsTail
    : storedWorkingMessages.map((message) => messageFingerprint(message));
  const incomingFingerprints = input.incomingMessages.map((message) => messageFingerprint(message));
  const tailWindow = new Set(storedFingerprints.slice(-Math.max(threshold + 2, 6)));
  const storedSet = new Set(storedFingerprints);

  const hasNonTailDuplicate = incomingFingerprints.some((fingerprint) => storedSet.has(fingerprint) && !tailWindow.has(fingerprint));
  if (hasNonTailDuplicate) {
    return { effectiveMessages: input.incomingMessages, sessionState };
  }

  const overlap = longestSuffixPrefixOverlap(storedFingerprints, incomingFingerprints);
  if (overlap === 0 && incomingFingerprints.some((fingerprint) => storedSet.has(fingerprint))) {
    return { effectiveMessages: input.incomingMessages, sessionState };
  }
  const appendOnly = overlap > 0 || incomingFingerprints.every((fingerprint) => !storedSet.has(fingerprint) || tailWindow.has(fingerprint));
  if (!appendOnly) {
    return { effectiveMessages: input.incomingMessages, sessionState };
  }

  return {
    effectiveMessages: [...storedWorkingMessages, ...input.incomingMessages.slice(overlap)],
    sessionState,
  };
}

export async function persistSessionWorkingState(input: {
  store: SessionStateStore;
  scope: ScopeRef;
  sessionId: string;
  messages: any[];
  compactionCount?: number;
  phase?: string | null;
  hardMessageWindow?: number;
}): Promise<void> {
  const compactedMessages = pruneMessages({
    messages: input.messages as any[],
    reasoning: "before-last-message",
    toolCalls: "before-last-2-messages",
    emptyMessages: "remove",
  }).slice(-(input.hardMessageWindow ?? DEFAULT_CONFIG.hardMessageWindow));

  const existing = await input.store.getSessionState(input.scope, input.sessionId);
  const now = new Date();
  await input.store.upsertSessionState(
    {
      id: `${input.scope.tenantId}:${input.scope.scopeId}:${input.scope.namespace}:${input.sessionId}`,
      tenantId: input.scope.tenantId,
      scopeId: input.scope.scopeId,
      namespace: input.scope.namespace,
      sessionId: input.sessionId,
      workingMessages: compactedMessages as Array<Record<string, unknown>>,
      messageFingerprintsTail: compactedMessages.map((message) => messageFingerprint(message)),
      lastMessageCount: compactedMessages.length,
      lastCompactionCount: input.compactionCount ?? 0,
      phase: input.phase ?? null,
      metadata: existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    },
    { preserveCreatedAt: true },
  );
}

export function createAISDKCompactionPrepareStep(input: {
  compactor: RelayCompactor;
  model: any;
  modelContextWindow: number;
  initialCompactionState?: CompactState;
  config?: PrepareStepCompactionConfig;
}) {
  const config = { ...DEFAULT_CONFIG, ...(input.config ?? {}) };
  const initialState: CompactState = input.initialCompactionState ?? {
    count: 0,
    lastCompactedStep: -100,
  };

  return async ({
    messages: stepMessages,
    steps,
    stepNumber,
    experimental_context,
  }: {
    messages: any[];
    steps?: any[];
    stepNumber: number;
    experimental_context?: { compaction?: CompactState };
  }) => {
    const compactionState = experimental_context?.compaction ?? initialState;
    const stepMessageTokenEstimate = TokenCounter.estimateTokens(JSON.stringify(stepMessages));
    const tokenRatio = stepMessageTokenEstimate / input.modelContextWindow;
    const compactReasons: string[] = [];

    if (tokenRatio >= config.tokenEmergencyRatio) {
      compactReasons.push("token-emergency");
    } else if (tokenRatio >= config.tokenHardRatio) {
      compactReasons.push("token-hard");
    } else if (tokenRatio >= config.tokenSoftRatio) {
      compactReasons.push("token-soft");
    }

    if (stepMessages.length > config.messageCountCompactThreshold) {
      compactReasons.push("message-count");
    }
    if (hasLargeToolResult(steps ?? [], config.largeToolResultChars)) {
      compactReasons.push("large-tool-result");
    }
    if (
      stepNumber > 0 &&
      stepNumber % config.periodicInterval === 0 &&
      stepMessages.length > config.messageCountCompactThreshold - 4
    ) {
      compactReasons.push("periodic");
    }
    if (compactReasons.length === 0) return {};

    const compactCooldownReached =
      stepNumber - (compactionState.lastCompactedStep ?? -100) >= config.minStepsBetweenCompaction;
    if (!compactCooldownReached) return {};

    const isTokenEmergency = tokenRatio >= config.tokenEmergencyRatio;
    const isTokenHard = tokenRatio >= config.tokenHardRatio;
    const targetWindow = isTokenEmergency
      ? config.emergencyMessageWindow
      : isTokenHard
        ? Math.min(config.hardMessageWindow, 22)
        : config.hardMessageWindow;

    const compactResult = await input.compactor.compact({
      stepMessages,
      stepNumber,
      model: input.model,
      modelContextWindow: input.modelContextWindow,
      targetWindow,
      isTokenHard,
      isTokenEmergency,
      compactReasons,
      compactionState,
    });
    if (!compactResult) return {};

    return {
      messages: compactResult.finalMessages,
      experimental_context: {
        compaction: compactResult.nextState,
      },
    };
  };
}

export async function processCompletedTurn(input: {
  messages: UIMessage[];
  assistantText?: string;
  engine: { processTurn(args: { tenantId: string; scopeId: string; namespace: string; messages: UIMessage[] }): Promise<any> };
  scope: ScopeRef;
}) {
  const memoryMessages = [...input.messages];
  if (input.assistantText && input.assistantText.trim().length > 0) {
    memoryMessages.push({
      id: `assistant-memory-${Date.now()}`,
      role: "assistant",
      parts: [{ type: "text", text: input.assistantText }] as any,
    });
  }
  return input.engine.processTurn({
    tenantId: input.scope.tenantId,
    scopeId: input.scope.scopeId,
    namespace: input.scope.namespace,
    messages: memoryMessages,
  });
}

function hasLargeToolResult(steps: any[], threshold: number): boolean {
  const lastStep = steps[steps.length - 1];
  if (!lastStep?.toolResults?.length) return false;
  return lastStep.toolResults.some((toolResult: any) => {
    const payload = toolResult?.result;
    if (typeof payload === "string") return payload.length > threshold;
    try {
      return JSON.stringify(payload).length > threshold;
    } catch {
      return false;
    }
  });
}

function longestSuffixPrefixOverlap(stored: string[], incoming: string[]): number {
  const max = Math.min(stored.length, incoming.length);
  for (let size = max; size > 0; size -= 1) {
    const suffix = stored.slice(-size);
    const prefix = incoming.slice(0, size);
    if (suffix.every((value, index) => value === prefix[index])) {
      return size;
    }
  }
  return 0;
}

function messageFingerprint(message: any): string {
  if (typeof message?.id === "string" && message.id.trim().length > 0) {
    return `id:${message.id}`;
  }
  const stable = stableJson({
    role: message?.role ?? null,
    content: message?.content ?? null,
    parts: message?.parts ?? null,
    toolName: message?.toolName ?? null,
    name: message?.name ?? null,
  });
  return createHash("sha256").update(stable).digest("hex");
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
