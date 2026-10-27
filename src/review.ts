import { existsSync, readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Config, Rule } from "./config.js";
import { globMatch } from "./policy.js";
import { isAgentTool, toolProfile, type ToolProfile } from "./tools.js";

/**
 * Review the registry for risky setups that no single rule shows: more power
 * than an agent needs, combinations of tools that are dangerous together, and
 * agents that can get another agent to do what they cannot. Advice only: it
 * changes nothing, the admin decides.
 */

export type Level = "high" | "medium" | "low";
export interface Finding {
  level: Level;
  agent: string;
  text: string;
}

/** How freely an agent can use a tool: on its own (sometimes or always), only with approval, or not at all. */
type Use = "free" | "approval" | "none";

function use(rules: readonly Rule[], tool: string): Use {
  const matching = rules.filter((r) => globMatch(r.tool, tool));
  if (matching.some((r) => r.decision === "allow")) return "free";
  if (matching.some((r) => r.decision === "approve")) return "approval";
  return "none";
}

const list = (xs: string[]) => xs.join(", ");

export interface ReviewInput {
  config: Config;
  tools: Map<string, Tool[] | Error>;
  /** Audit log entries; when given, permissions never used are reported. */
  audit?: { event: string; agent?: string; tool?: string }[];
}

export function reviewRegistry({ config, tools, audit }: ReviewInput): Finding[] {
  const out: Finding[] = [];
  if (!config.agents) return out;
  const profiles = new Map<string, ToolProfile>();
  for (const [server, ts] of tools) {
    if (ts instanceof Error) continue;
    for (const t of ts) profiles.set(`${server}.${t.name}`, toolProfile(config, `${server}.${t.name}`, t));
  }
  const untrusted = (id: string) => config.upstreams[id.split(".")[0] ?? ""]?.trust === "untrusted";
  const ids = [...profiles.keys()];
  const usesOf = (rules: readonly Rule[]) => new Map(ids.map((id) => [id, use(rules, id)] as const));

  for (const [name, agent] of Object.entries(config.agents)) {
    const uses = usesOf(agent.tools);
    const has = (u: Use) => ids.filter((id) => uses.get(id) === u);
    const usable = ids.filter((id) => uses.get(id) !== "none");
    const free = has("free");

    // 1. Deleting on its own.
    const deletes = free.filter((id) => profiles.get(id)!.access === "delete");
    if (deletes.length) {
      out.push({ level: "high", agent: name, text: `can delete on its own (${list(deletes)}). Consider "needs approval" or removing it.` });
    }

    // 2. Reading private or untrusted data and sending things out: a leak path.
    const readsPrivate = usable.filter((id) => profiles.get(id)!.access === "read" && (profiles.get(id)!.sensitive || untrusted(id)));
    const sendsOut = free.filter((id) => profiles.get(id)!.external);
    if (readsPrivate.length && sendsOut.length) {
      out.push({
        level: "high",
        agent: name,
        text:
          `can read private or outside data (${list(readsPrivate)}) and send things out on its own (${list(sendsOut)}). ` +
          `Together these could leak data; consider making the sending tool need approval.`,
      });
    }

    // 3. Getting another agent to do what this one cannot.
    for (const other of agent.talksTo) {
      const target = Object.hasOwn(config.agents, other) ? config.agents[other] : undefined;
      if (!target) {
        out.push({ level: "medium", agent: name, text: `may talk to "${other}", which is not a registered agent.` });
        continue;
      }
      const theirs = usesOf(target.tools);
      const extra = ids.filter((id) => theirs.get(id) !== "none" && uses.get(id) === "none");
      if (extra.length) {
        const risky = extra.some((id) => profiles.get(id)!.access === "delete" || profiles.get(id)!.external);
        out.push({
          level: risky ? "high" : "medium",
          agent: name,
          text: `can message ${other} without approval, and ${other} can use tools ${name} cannot (${list(extra)}). ${name} could get them done through ${other}.`,
        });
      }
    }

    // 3b. A helper given a hand-off tool: it stays hidden and blocked, so say so.
    if (!agent.orchestrator) {
      const handoff = usable.filter((id) => isAgentTool(config, id));
      if (handoff.length) {
        out.push({
          level: "low",
          agent: name,
          text: `has ${list(handoff)} in its list, but only an orchestrator may pass work to other agents, so it stays blocked. Remove it, or mark ${name} as the orchestrator.`,
        });
      }
    }

    // 4. Blanket access.
    const blanket = agent.tools.filter((r) => r.decision === "allow" && !r.if && r.tool.includes("*")).map((r) => r.tool);
    if (blanket.length) out.push({ level: "medium", agent: name, text: `has blanket access (${list(blanket)}). List only the tools it needs.` });

    // 5. Changing records with no limit.
    const unlimited = ids.filter(
      (id) =>
        profiles.get(id)!.access === "update" &&
        agent.tools.some((r) => globMatch(r.tool, id) && r.decision === "allow" && !r.if) &&
        !agent.tools.some((r) => globMatch(r.tool, id) && r.if),
    );
    if (unlimited.length) out.push({ level: "low", agent: name, text: `can change records with no limit (${list(unlimited)}).` });

    // 6. Least privilege: permissions never used.
    if (audit) {
      const called = new Set(audit.filter((e) => e.event === "call" && e.agent === name).map((e) => e.tool));
      if (called.size === 0) out.push({ level: "low", agent: name, text: "has no recorded activity yet, so unused permissions cannot be checked." });
      else {
        const unused = usable.filter((id) => !called.has(id));
        if (unused.length) out.push({ level: "low", agent: name, text: `never used ${list(unused)}. If it does not need them, remove them.` });
      }
    }
  }
  return out;
}

export function readAudit(path: string): { event: string; agent?: string; tool?: string }[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const ORDER: Level[] = ["high", "medium", "low"];

export function renderReview(findings: Finding[]): string {
  if (findings.length === 0) return "Review: no problems found.";
  const sorted = [...findings].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
  const counts = ORDER.map((l) => `${findings.filter((f) => f.level === l).length} ${l}`).join(", ");
  return [`Review (${counts}):`, ...sorted.map((f) => `  ${f.level.toUpperCase().padEnd(6)} ${f.agent} ${f.text}`)].join("\n");
}
