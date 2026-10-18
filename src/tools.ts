import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AccessType, Config } from "./config.js";
import { globMatch, type Args } from "./policy.js";

/**
 * What a tool does, in terms that matter for security: does it read, write,
 * update or delete; does it return private data; does it send things outside;
 * does it pass work to another agent. Set in `toolInfo`, otherwise guessed from
 * the tool's name, description and the hints MCP servers may publish.
 */
export interface ToolProfile {
  access: AccessType;
  sensitive: boolean;
  external: boolean;
  /** Argument naming the agent this tool messages, when it is an agent-to-agent tool. */
  agentArg?: string;
  /** Which facts were guessed rather than set by the admin. */
  guessed: ("access" | "sensitive" | "external" | "agentCall")[];
}

const verbs = (...v: string[]) => new RegExp(`\\b(${v.join("|")})(s|es|d|ed|ing)?\\b`);
const WORDS: [AccessType, RegExp][] = [
  ["delete", verbs("delete", "remove", "drop", "destroy", "purge", "erase", "kill", "terminate", "revoke", "wipe")],
  ["update", verbs("update", "edit", "modify", "set", "patch", "change", "rename", "move", "refund", "transfer", "approve", "cancel", "reset", "grant", "assign")],
  ["write", verbs("create", "add", "insert", "send", "post", "write", "upload", "publish", "reply", "submit", "execute", "run", "invite", "pay", "ask", "delegate", "message")],
  ["read", verbs("get", "list", "read", "search", "find", "view", "fetch", "query", "describe", "lookup", "show", "count", "check", "download", "export", "summarize", "summarise")],
];
const SENSITIVE = /customer|user|account|payment|card|bank|invoice|order|salary|payroll|patient|medical|record|personal|contact|address|email_list|database|sql|secret|password|credential/;
const EXTERNAL = /send|email|mail|sms|post|publish|tweet|upload|webhook|http|share|reply|notify|message|slack|whatsapp/;
const AGENT_TOOL = /agent|delegate|handoff|hand_off|assign_to/;
const AGENT_ARGS = ["agent", "agent_name", "agent_id", "to_agent", "target_agent", "recipient_agent", "assignee"];

/** Turn "deleteCustomer" / "delete-customer" into "delete customer" so word checks work. */
function words(s: string): string {
  return s.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
}

export function guessAccess(name: string, description = "", hints?: Tool["annotations"]): AccessType {
  if (hints?.destructiveHint === true && !hints.readOnlyHint) return "delete";
  if (hints?.readOnlyHint === true) return "read";
  const n = words(name);
  for (const [type, re] of WORDS) if (re.test(n)) return type;
  const d = words(description);
  for (const [type, re] of WORDS) if (re.test(d)) return type;
  return "write"; // unknown: assume it changes something
}

/** The tool's profile. `tool` (from discovery) and `args` (from a call) improve guesses when given. */
export function toolProfile(config: Config, id: string, tool?: Tool, args?: Args): ToolProfile {
  const info = Object.entries(config.toolInfo)
    .filter(([pattern]) => globMatch(pattern, id))
    .reduce((acc, [, v]) => ({ ...acc, ...v }), {} as Config["toolInfo"][string]);
  const name = id.slice(id.indexOf(".") + 1);
  const text = words(`${name} ${tool?.description ?? ""}`);
  const guessed: ToolProfile["guessed"] = [];

  const access = info.access ?? (guessed.push("access"), guessAccess(name, tool?.description, tool?.annotations));
  const sensitive = info.sensitive ?? (guessed.push("sensitive"), SENSITIVE.test(text));
  const external = info.external ?? (guessed.push("external"), access !== "read" && EXTERNAL.test(text));

  let agentArg = info.agentCall?.arg;
  // Guessed only for tools that act (not reads such as get_agent_status), so lookups never need approval.
  if (!agentArg && access !== "read" && AGENT_TOOL.test(words(name))) {
    const fields = Object.keys((tool?.inputSchema?.properties as object | undefined) ?? args ?? {});
    agentArg = AGENT_ARGS.find((a) => fields.includes(a));
    if (agentArg) guessed.push("agentCall");
  }
  return { access, sensitive, external, ...(agentArg ? { agentArg } : {}), guessed };
}

/** Whether a tool passes work to other agents (set in toolInfo, or guessed from its name). */
export function isAgentTool(config: Config, id: string): boolean {
  const set = Object.entries(config.toolInfo).some(([p, v]) => v.agentCall && globMatch(p, id));
  const name = id.slice(id.indexOf(".") + 1);
  return set || (guessAccess(name) !== "read" && AGENT_TOOL.test(words(name)));
}
