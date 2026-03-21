import type { ClassifierResult, MemoryPreset } from "../types";
import { clamp01, normalizeText } from "../utils/text";

const genericSlotPolicies = {
  "general.fact": { cardinality: "multi" as const, ttlDays: 120 },
  "general.decision": { cardinality: "multi" as const, ttlDays: 365 },
  "general.constraint": { cardinality: "multi" as const, ttlDays: null, isPinned: true },
  "general.preference": { cardinality: "multi" as const, ttlDays: 180 },
  "general.question": { cardinality: "multi" as const, ttlDays: 45 },
};

function classify(sentence: string): ClassifierResult | null {
  const normalized = normalizeText(sentence);
  if (!normalized || normalized.length < 8) return null;

  const isQuestion =
    /[?？]$/.test(sentence.trim()) ||
    /(what|which|how|why|difference|compare|是否|吗|么|怎么|如何|有什么|区别)/i.test(normalized);
  if (isQuestion) {
    return {
      slotKey: "general.question",
      memoryType: "QUESTION",
      confidence: 0.62,
      importance: 0.52,
      weight: 0.46,
      isPinned: false,
      ttlDays: 45,
      overrideSignal: false,
    };
  }

  if (/(must|required|never|cannot|禁止|必须|不能|不得)/i.test(normalized)) {
    return {
      slotKey: "general.constraint",
      memoryType: "CONSTRAINT",
      confidence: 0.88,
      importance: 0.84,
      weight: 0.8,
      isPinned: true,
      ttlDays: null,
      overrideSignal: /(instead|replace|override|改成|改为)/i.test(normalized),
    };
  }

  if (/(decide|decision|chosen|we will|agreed|plan is|决定|计划|采用|改成)/i.test(normalized)) {
    return {
      slotKey: "general.decision",
      memoryType: "DECISION",
      confidence: 0.78,
      importance: 0.72,
      weight: 0.68,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|switch|改成|改为)/i.test(normalized),
    };
  }

  if (/(prefer|would like|最好|倾向于|偏向)/i.test(normalized)) {
    return {
      slotKey: "general.preference",
      memoryType: "PREFERENCE",
      confidence: 0.72,
      importance: 0.55,
      weight: 0.5,
      isPinned: false,
      ttlDays: 180,
      overrideSignal: false,
    };
  }

  const score = clamp01(0.45 + Math.min(normalized.length, 160) / 300);
  return {
    slotKey: "general.fact",
    memoryType: "FACT",
    confidence: score,
    importance: 0.5,
    weight: 0.48,
    isPinned: false,
    ttlDays: 120,
    overrideSignal: false,
  };
}

export const genericPreset: MemoryPreset = {
  name: "generic",
  slotPolicies: genericSlotPolicies,
  classifySentence: classify,
};
