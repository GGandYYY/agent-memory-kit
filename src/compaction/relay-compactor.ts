import { generateText, pruneMessages } from "ai";
import type { CompactInput, CompactResult } from "../types";
import { TokenCounter } from "../utils/token-counter";

const RELAY_SUMMARY_PREFIX = "[Context Relay Summary";
const REQUIRED_SUMMARY_HEADERS = [
  "[Task]",
  "[Decisions]",
  "[Constraints]",
  "[Open Questions]",
  "[Key Evidence]",
  "[Next Actions]",
];

type IndexedMessage = {
  index: number;
  message: any;
  text: string;
  priority: number;
  protected: boolean;
};

export class RelayCompactor {
  async compact(input: CompactInput): Promise<CompactResult | null> {
    const {
      stepMessages,
      stepNumber,
      model,
      modelContextWindow,
      targetWindow,
      isTokenHard,
      isTokenEmergency,
      compactReasons,
      compactionState,
    } = input;

    const originalTokenEstimate = TokenCounter.estimateTokens(JSON.stringify(stepMessages));
    const prunedMessages = pruneMessages({
      messages: stepMessages as any[],
      reasoning: isTokenHard ? "all" : "before-last-message",
      toolCalls: isTokenEmergency ? "before-last-message" : "before-last-2-messages",
      emptyMessages: "remove",
    }) as any[];

    const sanitizedMessages = prunedMessages.filter((message) => !this.isRelaySummaryMessage(message));
    if (sanitizedMessages.length === 0) return null;

    const protectedIndexes = this.collectProtectedIndexes(sanitizedMessages);
    const retainedIndexes = this.selectBaseRetainedIndexes(sanitizedMessages, protectedIndexes, targetWindow);
    const historyMessages = sanitizedMessages.filter((_, index) => !retainedIndexes.has(index));
    const retainedEntries = sanitizedMessages
      .map((message, index) => ({ message, index }))
      .filter((entry) => retainedIndexes.has(entry.index));
    const retainedMessages = retainedEntries.map((entry) => entry.message);
    const historyText = this.messagesToCompactText(historyMessages, {
      maxChars: 18_000,
      maxLines: 220,
    });
    const historyTokens = TokenCounter.estimateTokens(historyText);

    let summaryText = "";
    let usedFallbackSummary = false;
    const previousSummary = (compactionState.relaySummary ?? "").trim();
    const shouldBuildSummary = historyMessages.length > 0 || previousSummary.length > 0;
    if (shouldBuildSummary) {
      summaryText = await this.buildRelaySummaryWithLLM(model, previousSummary, historyText);
      if (!summaryText || !this.hasRequiredSections(summaryText)) {
        summaryText = this.buildRelaySummaryFallback(sanitizedMessages, historyMessages, previousSummary);
        usedFallbackSummary = true;
      }
      summaryText = this.clampTextToTokens(summaryText, 900);
    }

    const relayVersion = (compactionState.relaySummaryVersion ?? 0) + (summaryText ? 1 : 0);
    const relayMessage = summaryText
      ? {
          role: "assistant",
          content: `${RELAY_SUMMARY_PREFIX} v${relayVersion}]\n${summaryText}`,
        }
      : null;

    const retainedIndexed = retainedEntries.map(({ message, index: originalIndex }) => {
      return {
        index: originalIndex,
        message,
        text: this.messageToCompactText(message),
        priority: this.messagePriority(message, originalIndex, sanitizedMessages.length, protectedIndexes),
        protected: protectedIndexes.has(originalIndex),
      } satisfies IndexedMessage;
    });

    let finalMessages: any[] = relayMessage ? [relayMessage, ...retainedMessages] : [...retainedMessages];
    const postCompactTokenCap = Math.floor(
      modelContextWindow * (isTokenEmergency ? 0.72 : isTokenHard ? 0.8 : 0.86),
    );
    finalMessages = this.fitMessagesWithinTokenCap(finalMessages, retainedIndexed, postCompactTokenCap);

    const finalTokenEstimate = TokenCounter.estimateTokens(JSON.stringify(finalMessages));
    if (
      finalMessages.length === 0 ||
      finalMessages.length >= stepMessages.length ||
      finalTokenEstimate >= originalTokenEstimate
    ) {
      return null;
    }

    return {
      finalMessages,
      nextState: {
        count: (compactionState.count ?? 0) + 1,
        lastCompactedStep: stepNumber,
        lastReason: [...compactReasons, summaryText ? "relay-summary" : "window-trim"].join("+"),
        relaySummary: summaryText || compactionState.relaySummary,
        relaySummaryVersion: summaryText ? relayVersion : compactionState.relaySummaryVersion,
        lastCompactedMessageCount: finalMessages.length,
      },
      summaryGenerated: Boolean(summaryText),
      usedFallbackSummary,
      summaryTokens: summaryText ? TokenCounter.estimateTokens(summaryText) : 0,
      historyTokens,
      retainedMessageCount: retainedMessages.length,
    };
  }

  private async buildRelaySummaryWithLLM(model: any, previousSummary: string, historyText: string): Promise<string> {
    if (!model || (!previousSummary && !historyText)) return "";
    try {
      const result = await generateText({
        model,
        system: [
          "You compress long chat history into a relay summary for an AI copilot.",
          "Preserve factual continuity only. Do not invent details.",
          "Output using EXACT section headers:",
          ...REQUIRED_SUMMARY_HEADERS,
          "Use short bullet points under each section.",
        ].join(" "),
        prompt: [
          "Update the relay summary using the previous summary and the compacted history chunk.",
          "",
          previousSummary ? `Previous summary:\n${previousSummary}` : "Previous summary:\n(none)",
          "",
          historyText ? `History chunk:\n${historyText}` : "History chunk:\n(none)",
        ].join("\n"),
        temperature: 0,
        maxOutputTokens: 700,
      });
      return (result.text ?? "").trim();
    } catch {
      return "";
    }
  }

  private hasRequiredSections(summaryText: string): boolean {
    return REQUIRED_SUMMARY_HEADERS.every((header) => summaryText.includes(header));
  }

  private buildRelaySummaryFallback(
    stepMessages: any[],
    historyMessages: any[],
    previousSummary: string,
  ): string {
    const latestUserText = this.extractLatestRoleText(stepMessages, "user");
    const historyText = this.messagesToCompactText(historyMessages, {
      maxChars: 5_000,
      maxLines: 120,
    });
    const sentences = historyText
      .split(/[\n。！？!?]/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 10);
    const pickBy = (regex: RegExp, limit: number) =>
      Array.from(new Set(sentences.filter((line) => regex.test(line)))).slice(0, limit);

    const decisions = pickBy(/(decide|decision|will|plan|agreed|choose|采用|决定|计划|将会)/i, 4);
    const constraints = pickBy(/(must|required|never|cannot|should not|必须|不得|不能|一定)/i, 4);
    const questions = pickBy(/(\?|？|unclear|pending|unknown|待确认|未确认|待定)/i, 4);
    const evidence = pickBy(/(tool|result|error|evidence|claim|scan|ticket|日志|证据|错误|结论)/i, 4);
    const nextActions = pickBy(/(next|follow-up|action|todo|then|下一步|后续|待办)/i, 4);

    const lines: string[] = [
      "[Task]",
      `- ${latestUserText || "Continue the current task with continuity."}`,
      "[Decisions]",
      ...(decisions.length > 0 ? decisions.map((line) => `- ${line}`) : ["- No explicit decisions captured."]),
      "[Constraints]",
      ...(constraints.length > 0 ? constraints.map((line) => `- ${line}`) : ["- No hard constraints captured."]),
      "[Open Questions]",
      ...(questions.length > 0 ? questions.map((line) => `- ${line}`) : ["- No unresolved questions captured."]),
      "[Key Evidence]",
      ...(evidence.length > 0 ? evidence.map((line) => `- ${line}`) : ["- No key evidence captured."]),
      "[Next Actions]",
      ...(nextActions.length > 0 ? nextActions.map((line) => `- ${line}`) : ["- Continue with the current plan and verify assumptions."]),
    ];
    if (previousSummary.trim()) {
      lines.push("[Previous Summary Carryover]");
      lines.push(...previousSummary.split("\n").slice(0, 12).map((line) => `- ${line.trim()}`));
    }
    return lines.join("\n");
  }

  private collectProtectedIndexes(messages: any[]): Set<number> {
    const indexes = new Set<number>();
    const latestUserIndex = this.findLatestIndex(messages, (message) => message?.role === "user");
    if (latestUserIndex >= 0) indexes.add(latestUserIndex);

    const lastToolIndex = this.findLatestIndex(messages, (message) => this.isToolRelatedMessage(message));
    if (lastToolIndex >= 0) {
      indexes.add(lastToolIndex);
      if (lastToolIndex > 0) indexes.add(lastToolIndex - 1);
    }

    const lastFailureIndex = this.findLatestIndex(messages, (message) =>
      /(error|failed|failure|exception|timeout|traceback|stack trace)/i.test(this.messageToCompactText(message)),
    );
    if (lastFailureIndex >= 0) {
      indexes.add(lastFailureIndex);
      if (lastFailureIndex > 0) indexes.add(lastFailureIndex - 1);
    }

    return indexes;
  }

  private selectBaseRetainedIndexes(messages: any[], protectedIndexes: Set<number>, targetWindow: number): Set<number> {
    const cappedTargetWindow = Math.max(8, targetWindow);
    const retained = new Set<number>(protectedIndexes);
    for (let index = Math.max(0, messages.length - (cappedTargetWindow - 1)); index < messages.length; index += 1) {
      retained.add(index);
    }
    return retained;
  }

  private fitMessagesWithinTokenCap(messages: any[], retainedIndexed: IndexedMessage[], tokenCap: number): any[] {
    if (messages.length <= 1 || tokenCap <= 0) return messages;

    const finalMessages = [...messages];
    const removable = [...retainedIndexed];
    while (finalMessages.length > 1) {
      const estimate = TokenCounter.estimateTokens(JSON.stringify(finalMessages));
      if (estimate <= tokenCap) break;
      const nextDrop = this.pickDropCandidate(removable);
      if (!nextDrop) break;
      const finalIndex = finalMessages.findIndex((message) => message === nextDrop.message);
      if (finalIndex <= 0) {
        removable.splice(removable.indexOf(nextDrop), 1);
        continue;
      }
      finalMessages.splice(finalIndex, 1);
      removable.splice(removable.indexOf(nextDrop), 1);
    }
    return finalMessages;
  }

  private pickDropCandidate(messages: IndexedMessage[]): IndexedMessage | null {
    const candidates = messages.filter((entry) => !entry.protected);
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => {
      if (left.priority !== right.priority) return left.priority - right.priority;
      return left.index - right.index;
    });
    return candidates[0] ?? null;
  }

  private messagePriority(message: any, index: number, total: number, protectedIndexes: Set<number>): number {
    if (protectedIndexes.has(index)) return 100;
    if (index >= total - 4) return 60;
    if (this.isToolRelatedMessage(message)) return 50;
    if (/(error|failed|failure|exception|timeout|traceback|stack trace)/i.test(this.messageToCompactText(message))) {
      return 55;
    }
    return 10;
  }

  private isToolRelatedMessage(message: any): boolean {
    if (message?.role === "tool") return true;
    if (Array.isArray(message?.content)) {
      return message.content.some((part: any) => typeof part?.type === "string" && part.type.startsWith("tool-"));
    }
    return false;
  }

  private findLatestIndex(messages: any[], predicate: (message: any) => boolean): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (predicate(messages[index])) return index;
    }
    return -1;
  }

  private messagesToCompactText(messages: any[], options: { maxChars: number; maxLines: number }): string {
    const lines: string[] = [];
    for (const message of messages) {
      lines.push(this.messageToCompactText(message).slice(0, options.maxChars));
      if (lines.length >= options.maxLines) break;
    }
    return lines.join("\n").slice(0, options.maxChars);
  }

  private messageToCompactText(message: any): string {
    const text =
      typeof message?.content === "string"
        ? message.content
        : JSON.stringify(message?.content ?? "");
    return `${message?.role ?? "unknown"}: ${String(text)}`;
  }

  private extractLatestRoleText(messages: any[], role: string): string {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== role) continue;
      if (typeof message?.content === "string") return message.content;
      if (Array.isArray(message?.content)) {
        return message.content
          .filter((part: any) => part?.type === "text")
          .map((part: any) => String(part.text ?? ""))
          .join("\n");
      }
      return String(message?.content ?? "");
    }
    return "";
  }

  private clampTextToTokens(text: string, maxTokens: number): string {
    let compact = text;
    while (compact.length > 80 && TokenCounter.estimateTokens(compact) > maxTokens) {
      compact = compact.slice(0, Math.floor(compact.length * 0.85));
    }
    return compact;
  }

  private isRelaySummaryMessage(message: any): boolean {
    return typeof message?.content === "string" && message.content.startsWith(RELAY_SUMMARY_PREFIX);
  }
}
