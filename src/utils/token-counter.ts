const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;

const MODEL_WINDOWS: Record<string, number> = {
  "google:gemini-2.5-pro": 1_048_576,
  "google:gemini-2.5-flash": 1_048_576,
  "google:gemini-3-flash-preview": 1_048_576,
  "openai:gpt-4o": 128_000,
  "openai:gpt-4o-mini": 128_000,
  "anthropic:claude-3-5-sonnet-20241022": 200_000,
  "anthropic:claude-4-sonnet-20250514": 200_000,
};

export class TokenCounter {
  private static readonly CHARS_PER_TOKEN = 4;

  static estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  static getModelContextWindow(modelId: string): number {
    return MODEL_WINDOWS[modelId] ?? DEFAULT_MODEL_CONTEXT_WINDOW;
  }

  static calculateConversationBudget(input: {
    modelId: string;
    reservedForSystem: number;
    reservedForMessages: number;
    reservedForOutput?: number;
    safetyMargin?: number;
  }): number {
    const contextWindow = this.getModelContextWindow(input.modelId);
    const totalReserved =
      input.reservedForSystem +
      input.reservedForMessages +
      (input.reservedForOutput ?? 4_000) +
      (input.safetyMargin ?? 3_000);
    return Math.max(0, contextWindow - totalReserved);
  }
}
