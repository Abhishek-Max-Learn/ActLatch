import type { Condition, Decision, PolicyConfig, Rule } from "./config.js";

export interface Verdict {
  decision: Decision;
  reason: string;
  rule?: number; // index of the matching rule, if any
}

export type Args = Record<string, unknown>;

export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Values in an argument as a list: arrays as-is, strings split on commas/semicolons. */
export function listValues(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  return [String(v)];
}

export function emailDomain(addr: string): string | undefined {
  const m = /@([^\s>]+)>?\s*$/.exec(addr.trim());
  return m?.[1]?.toLowerCase();
}

export function externalAddresses(values: string[], internalDomains: readonly string[]): string[] {
  const internal = internalDomains.map((d) => d.toLowerCase());
  return values.filter((a) => {
    const d = emailDomain(a);
    return !d || !internal.includes(d);
  });
}

function conditionHolds(cond: Condition, args: Args, policy: PolicyConfig): boolean {
  if (cond.count) {
    const n = listValues(args[cond.count.arg]).length;
    if (cond.count.gt !== undefined && !(n > cond.count.gt)) return false;
    if (cond.count.lte !== undefined && !(n <= cond.count.lte)) return false;
  }
  if (cond.externalRecipients) {
    const domains = cond.externalRecipients.internalDomains ?? policy.internalDomains;
    if (externalAddresses(listValues(args[cond.externalRecipients.arg]), domains).length === 0) return false;
  }
  if (cond.matches) {
    const v = args[cond.matches.arg];
    if (typeof v !== "string" || !new RegExp(cond.matches.pattern, "i").test(v)) return false;
  }
  return true;
}

function ruleMatches(rule: Rule, tool: string, args: Args, policy: PolicyConfig): boolean {
  return globMatch(rule.tool, tool) && (!rule.if || conditionHolds(rule.if, args, policy));
}

/** First matching rule wins; otherwise the policy default (deny unless configured). */
export function evaluate(policy: PolicyConfig, tool: string, args: Args): Verdict {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i]!;
    if (ruleMatches(rule, tool, args, policy)) {
      return { decision: rule.decision, reason: rule.reason ?? `matched rule #${i + 1} (${rule.tool})`, rule: i };
    }
  }
  return { decision: policy.default, reason: `no rule matched; default is ${policy.default}` };
}

const STRICTNESS: Record<Decision, number> = { allow: 0, approve: 1, deny: 2 };

/** Combine two verdicts, keeping the stricter. Used so later checks can only tighten. */
export function stricter(a: Verdict, b: Verdict): Verdict {
  return STRICTNESS[b.decision] > STRICTNESS[a.decision] ? b : a;
}

/**
 * Taint check: once the session has read untrusted content, protected tools
 * need approval even if the policy would allow them. This can only tighten a
 * verdict, never loosen it, so injected text cannot grant permissions.
 */
export function applyTaint(policy: PolicyConfig, tool: string, verdict: Verdict, tainted: string[]): Verdict {
  if (tainted.length === 0) return verdict;
  if (!policy.protectAfterUntrusted.some((p) => globMatch(p, tool))) return verdict;
  return stricter(verdict, {
    decision: "approve",
    reason: `session has read untrusted content from ${tainted.join(", ")}; ${tool} needs a human`,
  });
}
