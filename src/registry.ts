import { timingSafeEqual } from "node:crypto";
import type { Condition, Config, Decision, Limit, Rule } from "./config.js";
import { evaluate, globMatch, stricter, type Args, type Facts, type Verdict } from "./policy.js";
import { isAgentTool, toolProfile } from "./tools.js";

/** Who is calling, as established when the gateway started. */
export interface Identity {
  agent?: string;
  key?: string;
}

/**
 * Check a caller against the agent registry. Returns a problem description,
 * or undefined when the caller may proceed. With no registry configured,
 * everyone is accepted and gets the global policy.
 */
export function identityProblem(config: Config, id: Identity): string | undefined {
  if (!config.agents) return undefined;
  if (!id.agent) return "no agent name given; start the gateway with --agent <name> (or ACTLATCH_AGENT)";
  const entry = Object.hasOwn(config.agents, id.agent) ? config.agents[id.agent] : undefined;
  if (!entry) return `agent "${id.agent}" is not registered`;
  if (entry.key !== undefined) {
    const want = Buffer.from(entry.key);
    const got = Buffer.from(id.key ?? "");
    if (want.length !== got.length || !timingSafeEqual(want, got)) return `agent "${id.agent}" key does not match`;
  }
  return undefined;
}

/**
 * Decide one call for one agent. The agent's own tool list decides first
 * (unlisted means deny); global policy rules that match can only tighten it.
 */
export function decide(config: Config, agent: string | undefined, tool: string, args: Args, facts: Facts = {}): Verdict {
  if (!config.agents) return evaluate(config.policy, tool, args, facts);
  const entry = agent && Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
  if (!entry) return { decision: "deny", reason: agent ? `agent "${agent}" is not registered` : "unknown agent" };

  const own = evaluate({ ...config.policy, default: "deny", rules: entry.tools }, tool, args, facts);
  const verdict = own.rule === undefined ? { decision: "deny" as const, reason: `${tool} is not in ${agent}'s tool list` } : own;
  const guard = evaluate({ ...config.policy, default: "allow" }, tool, args, facts);
  const guarded = guard.rule === undefined ? verdict : stricter(verdict, guard);
  return stricter(guarded, agentTalk(config, agent!, entry.talksTo, tool, args));
}

/**
 * Agent-to-agent messages: by default a human approves each one, so one agent
 * cannot quietly get another to use tools it was not given. Pairs listed in
 * `talksTo` go through without asking, so normal app flows keep working.
 * This can only tighten a decision.
 */
function agentTalk(config: Config, agent: string, talksTo: readonly string[], tool: string, args: Args): Verdict {
  const ok: Verdict = { decision: "allow", reason: "not an agent-to-agent message" };
  const { agentArg } = toolProfile(config, tool, undefined, args);
  if (!agentArg) {
    // Looks like an agent-to-agent tool but no target can be found: a human decides.
    return isAgentTool(config, tool)
      ? { decision: "approve", reason: `${agent} wants to pass work to another agent via ${tool}; a human approves agent-to-agent messages` }
      : ok;
  }
  const target = String(args[agentArg] ?? "");
  if (!target || !Object.hasOwn(config.agents ?? {}, target)) {
    return { decision: "deny", reason: `${agent} tried to message "${target || "(no agent named)"}", which is not a registered agent` };
  }
  if (target === agent || talksTo.includes(target)) return ok;
  return { decision: "approve", reason: `${agent} wants to pass work to ${target}; a human approves agent-to-agent messages` };
}

/** Whether the agent should even see a tool: some entry could let the call through. */
export function canSee(config: Config, agent: string | undefined, tool: string): boolean {
  if (!config.agents) return true;
  const entry = agent && Object.hasOwn(config.agents, agent) ? config.agents[agent] : undefined;
  return !!entry && entry.tools.some((r) => r.decision !== "deny" && globMatch(r.tool, tool));
}

// ---- Plain-language view of the registry ----

const WORDS: Record<Decision, string> = { allow: "allowed", approve: "needs approval", deny: "blocked" };

export function describeCondition(c: Condition): string {
  const parts: string[] = [];
  const lim = (l: Limit) => (typeof l === "number" ? String(l) : l.plus ? `${l.fact} + ${l.plus}` : l.fact);
  const range = (what: string, gt?: Limit, lte?: Limit) => {
    if (gt !== undefined) parts.push(`${what} is more than ${lim(gt)}`);
    if (lte !== undefined) parts.push(`${what} is at most ${lim(lte)}`);
  };
  if (c.count) range(`number of items in "${c.count.arg}"`, c.count.gt, c.count.lte);
  if (c.number) range(`"${c.number.arg}"`, c.number.gt, c.number.lte);
  if (c.externalRecipients) parts.push(`"${c.externalRecipients.arg}" includes an outside address`);
  if (c.matches) parts.push(`"${c.matches.arg}" matches /${c.matches.pattern}/`);
  return parts.join(" and ");
}

/** What a list of rules lets a caller do with one tool, e.g. "blocked if ...; otherwise allowed". */
export function describeAccess(rules: readonly Rule[], tool: string, fallback: Decision = "deny"): string {
  const parts: string[] = [];
  for (const r of rules) {
    if (!globMatch(r.tool, tool)) continue;
    if (!r.if) {
      parts.push(parts.length ? `otherwise ${WORDS[r.decision]}` : WORDS[r.decision]);
      return parts.join("; ");
    }
    parts.push(`${WORDS[r.decision]} if ${describeCondition(r.if)}`);
  }
  if (parts.length === 0) return WORDS[fallback];
  parts.push(`otherwise ${WORDS[fallback]}`);
  return parts.join("; ");
}

/** Tools found on each connected server, or the error if it could not be reached. */
export type Discovered = Map<string, string[] | Error>;

function table(config: Config, rows: [string, string][], indent = "  "): string[] {
  const w = Math.max(4, ...rows.map(([a]) => a.length));
  const type = (id: string) => toolProfile(config, id).access.padEnd(6);
  return [
    `${indent}${"TOOL".padEnd(w)}  TYPE    WHAT IT MAY DO`,
    ...rows.map(([a, b]) => `${indent}${a.padEnd(w)}  ${type(a)}  ${b}`),
  ];
}

/** Render "agent -> tools -> allowed actions" as a plain text table. */
export function renderRegistry(config: Config, discovered: Discovered): string {
  const out: string[] = [];
  const allTools: string[] = [];
  for (const [server, tools] of discovered) {
    if (tools instanceof Error) out.push(`! could not reach server "${server}": ${tools.message}`);
    else allTools.push(...tools.map((t) => `${server}.${t}`));
  }
  const taintNote = (tool: string) =>
    config.policy.protectAfterUntrusted.some((p) => globMatch(p, tool)) ? "; needs approval after reading untrusted content" : "";
  const lookupNote = (tool: string) =>
    config.lookups
      .filter((l) => globMatch(l.tool, tool))
      .map((l) => `; checks real ${l.as} via ${l.call}`)
      .join("");
  const guardNote = (tool: string) => (config.policy.rules.some((r) => globMatch(r.tool, tool)) ? "; also checked by rules for everyone" : "");

  if (!config.agents) {
    out.push("No agents registered: every caller gets the same global policy.", "");
    out.push(...table(config, allTools.map((t) => [t, describeAccess(config.policy.rules, t, config.policy.default) + lookupNote(t) + taintNote(t)])));
    return out.join("\n");
  }

  const usable = new Set<string>();
  for (const [name, agent] of Object.entries(config.agents)) {
    out.push("", `AGENT ${name}${agent.description ? ` - ${agent.description}` : ""}${agent.key !== undefined ? " [key required]" : ""}`);
    const visible = allTools.filter((t) => canSee(config, name, t));
    visible.forEach((t) => usable.add(t));
    if (visible.length === 0) out.push("  (no tools)");
    else out.push(...table(config, visible.map((t) => [t, describeAccess(agent.tools, t) + lookupNote(t) + taintNote(t) + guardNote(t)])));
    const hidden = allTools.length - visible.length;
    if (hidden > 0) out.push(`  ...and ${hidden} other tool(s): blocked`);
    if (agent.talksTo.length || visible.some((t) => isAgentTool(config, t))) {
      out.push(
        agent.talksTo.length
          ? `  Messages to ${agent.talksTo.join(", ")}: allowed. Messages to other agents: need approval.`
          : "  Messages to other agents: need approval.",
      );
    }
  }

  out.push("", "Anyone not registered above: blocked from every tool.");
  const unused = allTools.filter((t) => !usable.has(t));
  if (unused.length) out.push(`Tools no agent can use: ${unused.join(", ")}`);
  const reachable = [...discovered].filter(([, t]) => !(t instanceof Error)).map(([s]) => s);
  const stale: string[] = [];
  for (const [name, agent] of Object.entries(config.agents)) {
    for (const r of agent.tools) {
      const server = r.tool.split(".")[0] ?? "";
      if (reachable.includes(server) && !allTools.some((t) => globMatch(r.tool, t))) stale.push(`${name}: ${r.tool}`);
    }
  }
  if (stale.length) out.push(`Entries that match no tool (typo?): ${stale.join(", ")}`);
  return out.join("\n").replace(/^\n/, "");
}
