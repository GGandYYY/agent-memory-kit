import type { ClassifierResult, MemoryPreset } from "../types";
import { genericPreset } from "./generic";
import { normalizeText } from "../utils/text";

const slotPolicies = {
  ...genericPreset.slotPolicies,
  "infra.cloud_provider": { cardinality: "single" as const, ttlDays: 365 },
  "data.database": { cardinality: "single" as const, ttlDays: 365 },
  "identity.provider": { cardinality: "single" as const, ttlDays: 365, isHighRisk: true },
  "access.mfa": { cardinality: "single" as const, ttlDays: 180, isHighRisk: true },
  "code.repository": { cardinality: "multi" as const, ttlDays: 365 },
  "monitoring.stack": { cardinality: "multi" as const, ttlDays: 180 },
  "incident.process": { cardinality: "multi" as const, ttlDays: 180 },
};

function classifyPlatformSentence(sentence: string): ClassifierResult | null {
  const normalized = normalizeText(sentence);
  if (!normalized) return null;

  if (/\b(aws|amazon web services)\b/.test(normalized)) {
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue: "aws",
    };
  }

  if (/\b(gcp|google cloud)\b/.test(normalized)) {
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue: "gcp",
    };
  }

  if (/\bazure\b/.test(normalized)) {
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue: "azure",
    };
  }

  if (/\bpostgres(ql)?\b/.test(normalized)) {
    return {
      slotKey: "data.database",
      memoryType: "FACT",
      confidence: 0.84,
      importance: 0.76,
      weight: 0.72,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue: "postgresql",
    };
  }

  if (/\b(okta|auth0|entra|azure ad|google workspace)\b/.test(normalized)) {
    const canonicalValue =
      /\bokta\b/.test(normalized) ? "okta" :
      /\bauth0\b/.test(normalized) ? "auth0" :
      /google workspace/.test(normalized) ? "google_workspace" :
      "azure_ad";
    return {
      slotKey: "identity.provider",
      memoryType: "FACT",
      confidence: 0.84,
      importance: 0.82,
      weight: 0.8,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue,
    };
  }

  if (/(mfa|multi-factor|two-factor|2fa)/i.test(normalized)) {
    return {
      slotKey: "access.mfa",
      memoryType: "CONSTRAINT",
      confidence: 0.86,
      importance: 0.9,
      weight: 0.86,
      isPinned: true,
      ttlDays: 180,
      overrideSignal: /(disable|disabled|关闭|禁用|replace|改成)/i.test(normalized),
      canonicalValue: /(enabled|enable|开启|启用)/i.test(normalized) ? "enabled" : "disabled",
    };
  }

  if (/\b(github|gitlab|bitbucket)\b/.test(normalized)) {
    const canonicalValue =
      /\bgithub\b/.test(normalized) ? "github" :
      /\bgitlab\b/.test(normalized) ? "gitlab" :
      "bitbucket";
    return {
      slotKey: "code.repository",
      memoryType: "FACT",
      confidence: 0.72,
      importance: 0.68,
      weight: 0.65,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: false,
      canonicalValue,
    };
  }

  return genericPreset.classifySentence(sentence);
}

export const platformPreset: MemoryPreset = {
  name: "platform",
  slotPolicies,
  classifySentence: classifyPlatformSentence,
};
