import { generateText, pruneMessages } from "ai";
import type { CompactInput, CompactResult } from "../types";
import { TokenCounter } from "../utils/token-counter";

const RELAY_SUMMARY_PREFIX = "[Context Relay Summary";

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

    const prunedMessages = pruneMessages({
      messages: stepMessages as any[],
      reasoning: isTokenHard ? "all" : "before-last-message",
      toolCalls: isTokenEmergency ? "before-last-message" : "before-last-2-messages",
      emptyMessages: "remove",
    }) as any[];

    const sanitizedMessages = prunedMessages.filter((message) => !this.isRelaySummaryMessage(message));
    if (sanitizedMessages.length === 0) return null;

    const cappedTargetWindow = Math.max(8, targetWindow);
    const recentWindowSize = Math.max(6, cappedTargetWindow - 1);
    const recentWindow = sanitizedMessages.slice(-recentWindowSize);
    const historyMessages = sanitizedMessages.slice(0, Math.max(0, sanitizedMessages.length - recentWindow.length));
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
      if (!summaryText) {
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

    let finalMessages: any[] = relayMessage ? [relayMessage, ...recentWindow] : [...recentWindow];
    if (finalMessages.length > cappedTargetWindow) {
      finalMessages = finalMessages.slice(-cappedTargetWindow);
      if (relayMessage && !this.isRelaySummaryMessage(finalMessages[0])) {
        finalMessages = [relayMessage, ...finalMessages.slice(-(cappedTargetWindow - 1))];
      }
    }

    const postCompactTokenCap = Math.floor(
      modelContextWindow * (isTokenEmergency ? 0.72 : isTokenHard ? 0.8 : 0.86),
    );
    finalMessages = this.fitMessagesWithinTokenCap(finalMessages, postCompactTokenCap);
    if (finalMessages.length === 0 || finalMessages.length >= stepMessages.length) return null;

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
      retainedMessageCount: recentWindow.length,
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
          "[Task]",
          "[Decisions]",
          "[Constraints]",
          "[Open Questions]",
          "[Key Evidence]",
          "[Next Actions]",
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

  private messagesToCompactText(messages: any[], options: { maxChars: number; maxLines: number }): string {
    const lines: string[] = [];
    for (const message of messages) {
      const text =
        typeof message?.content === "string"
          ? message.content
          : JSON.stringify(message?.content ?? "");
      lines.push(`${message?.role ?? "unknown"}: ${String(text).slice(0, options.maxChars)}`);
      if (lines.length >= options.maxLines) break;
    }
    return lines.join("\n").slice(0, options.maxChars);
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

  private fitMessagesWithinTokenCap(messages: any[], tokenCap: number): any[] {
    if (messages.length <= 1 || tokenCap <= 0) return messages;
    const finalMessages = [...messages];
    while (finalMessages.length > 1) {
      const estimate = TokenCounter.estimateTokens(JSON.stringify(finalMessages));
      if (estimate <= tokenCap) break;
      finalMessages.splice(1, 1);
    }
    return finalMessages;
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
