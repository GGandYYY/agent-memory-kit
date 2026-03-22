import type { UIMessage } from "ai";

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[，。！？、]/g, " ")
    .replace(/[^\p{L}\p{N}\s:_.-]/gu, "");
}

export function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function messageToText(message: UIMessage): string {
  if (!message.parts || !Array.isArray(message.parts)) return "";
  const chunks: string[] = [];
  for (const part of message.parts as Array<any>) {
    if (part?.type === "text" && typeof part.text === "string") {
      chunks.push(part.text);
      continue;
    }
    if (part?.type?.startsWith("tool-")) {
      const toolName = part.toolName || part.name || "tool";
      let payload = "";
      if (part.args != null) {
        try {
          payload = JSON.stringify(part.args);
        } catch {
          payload = String(part.args);
        }
      }
      if (part.result != null) {
        try {
          payload = JSON.stringify(part.result);
        } catch {
          payload = String(part.result);
        }
      }
      chunks.push(`[${toolName}] ${payload}`.slice(0, 600));
    }
  }
  return chunks.join("\n").trim();
}

export function messagesToPlainText(messages: UIMessage[], maxPerMessageChars = 800): string {
  return messages
    .map((message) => `${message.role}: ${messageToText(message).slice(0, maxPerMessageChars)}`)
    .join("\n");
}

export function splitIntoSentences(text: string): string[] {
  return text
    .split(/[\n。！？!?]+/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 8);
}
