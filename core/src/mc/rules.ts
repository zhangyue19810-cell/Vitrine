import { currentOs, type OsInfo } from "../util/os";
import type { FeatureFlags, OsRule, Rule } from "./types";

export interface RuleContext {
  os: OsInfo;
  features: FeatureFlags;
}

export function defaultRuleContext(features: FeatureFlags = {}): RuleContext {
  return { os: currentOs(), features };
}

function archMatches(wanted: string, actual: OsInfo["arch"]): boolean {
  const key = wanted.toLowerCase();
  if (key === "x86") return actual === "x86";
  if (key === "x64" || key === "amd64" || key === "x86_64") return actual === "x64";
  if (key === "arm64" || key === "aarch64") return actual === "arm64";
  return key === actual;
}

export function osMatches(rule: OsRule | undefined, os: OsInfo): boolean {
  if (!rule) return true;
  if (rule.name && rule.name !== os.name) return false;
  if (rule.arch && !archMatches(rule.arch, os.arch)) return false;
  if (rule.version) {
    try {
      if (!new RegExp(rule.version).test(os.version)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function featuresMatch(wanted: Record<string, boolean> | undefined, actual: FeatureFlags): boolean {
  if (!wanted) return true;
  return Object.entries(wanted).every(([key, value]) => Boolean(actual[key]) === value);
}

/**
 * Mojang's rule semantics: no rules → allowed; otherwise start disallowed and let every rule that applies
 * overwrite the verdict, so the last matching rule wins.
 */
export function rulesAllow(rules: Rule[] | undefined, context: RuleContext): boolean {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    if (!osMatches(rule.os, context.os) || !featuresMatch(rule.features, context.features)) continue;
    allowed = rule.action === "allow";
  }
  return allowed;
}
