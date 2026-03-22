import type { ClassifierResult, MemoryPreset } from "../types";
import { genericPreset } from "./generic";
import { normalizeText } from "../utils/text";

const slotPolicies = {
  ...genericPreset.slotPolicies,
  "infra.cloud_provider": { cardinality: "single" as const, ttlDays: 365, aliases: ["cloud", "cloud provider", "hosting"] },
  "data.database": { cardinality: "single" as const, ttlDays: 365, aliases: ["database", "db", "persistence"] },
  "identity.provider": { cardinality: "single" as const, ttlDays: 365, isHighRisk: true, aliases: ["identity", "identity provider", "sso", "auth"] },
  "access.mfa": { cardinality: "single" as const, ttlDays: 180, isHighRisk: true, aliases: ["mfa", "2fa", "two factor", "multi factor"] },
  "code.repository": { cardinality: "multi" as const, ttlDays: 365, aliases: ["repository", "repo", "source control"] },
  "monitoring.stack": { cardinality: "multi" as const, ttlDays: 180, aliases: ["monitoring", "observability", "metrics"] },
  "incident.process": { cardinality: "multi" as const, ttlDays: 180, aliases: ["incident", "incident process", "response process"] },
};

function pickLastMatch(
  normalized: string,
  patterns: Array<{ canonicalValue: string; regex: RegExp }>,
): string | null {
  let winner: { canonicalValue: string; index: number } | null = null;
  for (const option of patterns) {
    const match = normalized.match(option.regex);
    if (!match || typeof match.index !== "number") continue;
    if (!winner || match.index >= winner.index) {
      winner = {
        canonicalValue: option.canonicalValue,
        index: match.index,
      };
    }
  }
  return winner?.canonicalValue ?? null;
}

function classifyPlatformSentence(sentence: string): ClassifierResult | null {
  const normalized = normalizeText(sentence);
  if (!normalized) return null;

  if (/\b(aws|amazon web services)\b/.test(normalized)) {
    const canonicalValue =
      pickLastMatch(normalized, [
        { canonicalValue: "aws", regex: /\b(aws|amazon web services)\b/ },
        { canonicalValue: "gcp", regex: /\b(gcp|google cloud)\b/ },
        { canonicalValue: "azure", regex: /\bazure\b/ },
      ]) ?? "aws";
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue,
    };
  }

  if (/\b(gcp|google cloud)\b/.test(normalized)) {
    const canonicalValue =
      pickLastMatch(normalized, [
        { canonicalValue: "aws", regex: /\b(aws|amazon web services)\b/ },
        { canonicalValue: "gcp", regex: /\b(gcp|google cloud)\b/ },
        { canonicalValue: "azure", regex: /\bazure\b/ },
      ]) ?? "gcp";
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue,
    };
  }

  if (/\bazure\b/.test(normalized)) {
    const canonicalValue =
      pickLastMatch(normalized, [
        { canonicalValue: "aws", regex: /\b(aws|amazon web services)\b/ },
        { canonicalValue: "gcp", regex: /\b(gcp|google cloud)\b/ },
        { canonicalValue: "azure", regex: /\bazure\b/ },
      ]) ?? "azure";
    return {
      slotKey: "infra.cloud_provider",
      memoryType: "FACT",
      confidence: 0.9,
      importance: 0.9,
      weight: 0.88,
      isPinned: false,
      ttlDays: 365,
      overrideSignal: /(instead|replace|migrate|改成|改为)/i.test(normalized),
      canonicalValue,
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
      pickLastMatch(normalized, [
        { canonicalValue: "okta", regex: /\bokta\b/ },
        { canonicalValue: "auth0", regex: /\bauth0\b/ },
        { canonicalValue: "google_workspace", regex: /\bgoogle workspace\b/ },
        { canonicalValue: "azure_ad", regex: /\b(entra|azure ad)\b/ },
      ]) ?? "azure_ad";
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
      pickLastMatch(normalized, [
        { canonicalValue: "github", regex: /\bgithub\b/ },
        { canonicalValue: "gitlab", regex: /\bgitlab\b/ },
        { canonicalValue: "bitbucket", regex: /\bbitbucket\b/ },
      ]) ?? "github";
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
