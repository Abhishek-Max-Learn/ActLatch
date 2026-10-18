import type { Condition, Decision, Limit, PolicyConfig, Rule } from "./config.js";

export interface Verdict {
  decision: Decision;
  reason: string;
  rule?: number; // index of the matching rule, if any
}

export type Args = Record<string, unknown>;
/** Values the gateway looked up itself, by lookup name, e.g. { order: { price: 20 } }. */
export type Facts = Record<string, unknown>;

/** Read "order.price" out of the facts. Undefined when any step is missing. */
export function factValue(facts: Facts, path: string): unknown {
  let cur: unknown = facts;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object" || !Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" || (typeof v === "string" && v.trim() !== "") ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
}

/** A limit as a number; NaN when it names a fact that could not be found. */
export function limitValue(limit: Limit, facts: Facts): number {
  if (typeof limit === "number") return limit;
  return toNumber(factValue(facts, limit.fact)) + (limit.plus ?? 0);
}

export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
  return re.test(name);
}

function escapeRe(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Values in an argument as a list: arrays (nested ones too) and objects item by item,
 * strings split on commas, semicolons and new lines.
 */
export function listValues(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(listValues);
  if (typeof v === "string") return v.split(/[,;\r\n]/).map((s) => s.trim()).filter(Boolean);
  if (v === undefined || v === null) return [];
  if (typeof v === "object") return Object.values(v).flatMap(listValues);
  return [String(v)];
}

/**
 * Every email address in a piece of text, however they are separated
 * ("a@x.com b@y.com", "Ann <a@x.com>"). Split, not one big regex, so huge
 * input cannot make it slow.
 */
export function emailAddresses(text: string): string[] {
  return text.split(/[\s,;<>"'()[\]]+/).filter((t) => t.includes("@"));
}

export function emailDomain(addr: string): string | undefined {
  const last = emailAddresses(addr).at(-1);
  const domain = last?.slice(last.lastIndexOf("@") + 1).toLowerCase();
  return domain || undefined;
}

/** Values that hold no address at all, or any address outside the internal domains. */
export function externalAddresses(values: string[], internalDomains: readonly string[]): string[] {
  const internal = internalDomains.map((d) => d.toLowerCase());
  return values.filter((v) => {
    const found = emailAddresses(v);
    return found.length === 0 || found.some((a) => !internal.includes(a.slice(a.lastIndexOf("@") + 1).toLowerCase()));
  });
}

/** How many items an argument holds: listed items, or the addresses in it if there are more. */
export function countValues(v: unknown): number {
  const items = listValues(v);
  return Math.max(items.length, items.flatMap(emailAddresses).length);
}

function conditionHolds(rule: Rule, cond: Condition, args: Args, policy: PolicyConfig, facts: Facts): boolean {
  if (cond.count) {
    const n = countValues(args[cond.count.arg]);
    if (cond.count.gt !== undefined && !(n > cond.count.gt)) return false;
    if (cond.count.lte !== undefined && !(n <= cond.count.lte)) return false;
  }
  if (cond.externalRecipients) {
    const domains = cond.externalRecipients.internalDomains ?? policy.internalDomains;
    if (externalAddresses(listValues(args[cond.externalRecipients.arg]), domains).length === 0) return false;
  }
  if (cond.matches) {
    // A list or object is checked as its JSON text, so wrapping a word in [ ] cannot dodge a
    // deny or approve rule. An allow rule needs a plain string, so odd input never loosens it.
    const v = args[cond.matches.arg];
    const text = typeof v === "string" ? v : v === undefined || rule.decision === "allow" ? undefined : JSON.stringify(v);
    if (text === undefined || !new RegExp(cond.matches.pattern, "i").test(text)) return false;
  }
  if (cond.number) {
    // Unknown values are treated as over every limit, and an unknown limit as already
    // exceeded, so a missing value or a failed lookup can never slip under a limit.
    const raw = toNumber(args[cond.number.arg]);
    const n = Number.isNaN(raw) ? Infinity : raw;
    if (cond.number.gt !== undefined) {
      const gt = limitValue(cond.number.gt, facts);
      if (!Number.isNaN(gt) && !(n > gt)) return false;
    }
    if (cond.number.lte !== undefined) {
      const lte = limitValue(cond.number.lte, facts);
      if (Number.isNaN(lte) || !(n <= lte)) return false;
    }
  }
  return true;
}

function ruleMatches(rule: Rule, tool: string, args: Args, policy: PolicyConfig, facts: Facts): boolean {
  return globMatch(rule.tool, tool) && (!rule.if || conditionHolds(rule, rule.if, args, policy, facts));
}

/** First matching rule wins; otherwise the policy default (deny unless configured). */
export function evaluate(policy: PolicyConfig, tool: string, args: Args, facts: Facts = {}): Verdict {
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i]!;
    if (ruleMatches(rule, tool, args, policy, facts)) {
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
