import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { actionHash, type AuditLog } from "./audit.js";
import type { Config, Upstream } from "./config.js";
import type { Approver } from "./approval.js";
import { applyTaint, globMatch, type Args, type Facts } from "./policy.js";
import { buildPreview, factLines, humanize } from "./preview.js";
import { toolProfile, type ToolProfile } from "./tools.js";
import { canSee, decide, identityProblem, type Discovered, type Identity } from "./registry.js";
import { createRequire } from "node:module";

// One version number for everything: the one in package.json (works from src/ and dist/).
const { version: VERSION } = createRequire(import.meta.url)("../package.json") as { version: string };

export interface ConnectedUpstream {
  name: string;
  trust: Upstream["trust"];
  client: Client;
}

// MCP tool names allow [A-Za-z0-9_-], so "mail.send_email" is exposed as "mail__send_email".
const SEP = "__";

export class Gateway {
  /** Upstream servers whose output this session has read. Only ever grows. */
  private readonly tainted = new Set<string>();
  /** Registered agent this gateway serves, if the registry is in use. */
  readonly agent?: string;
  /** Why the caller is not accepted (unregistered, wrong key). Every call is then blocked. */
  readonly identityError?: string;

  constructor(
    private readonly config: Config,
    private readonly upstreams: Map<string, ConnectedUpstream>,
    private readonly approver: Approver,
    private readonly audit: AuditLog,
    identity: Identity = {},
  ) {
    this.agent = identity.agent;
    this.identityError = identityProblem(config, identity);
  }

  get taintedBy(): string[] {
    return [...this.tainted];
  }

  async listTools(): Promise<Tool[]> {
    const out: Tool[] = [];
    if (this.identityError) return out;
    for (const up of this.upstreams.values()) {
      const { tools } = await up.client.listTools();
      for (const t of tools) {
        if (!canSee(this.config, this.agent, `${up.name}.${t.name}`)) continue;
        out.push({ ...t, name: `${up.name}${SEP}${t.name}`, description: `[via Act-Latch] ${t.description ?? ""}`.trim() });
      }
    }
    return out;
  }

  async callTool(exposedName: string, args: Args = {}): Promise<CallToolResult> {
    const idx = exposedName.indexOf(SEP);
    const server = idx > 0 ? exposedName.slice(0, idx) : "";
    const toolName = idx > 0 ? exposedName.slice(idx + SEP.length) : exposedName;
    const tool = `${server}.${toolName}`;
    const hash = actionHash(tool, args);
    this.audit.write({ event: "call", tool, actionHash: hash, agent: this.agent, args });

    if (this.identityError) return this.block(tool, hash, this.identityError);
    const up = this.upstreams.get(server);
    if (!up) return this.block(tool, hash, `unknown tool ${exposedName}`);

    const facts = await this.lookup(tool, args, hash);
    const policyVerdict = decide(this.config, this.agent, tool, args, facts);
    const verdict = applyTaint(this.config.policy, tool, policyVerdict, this.taintedBy);
    this.audit.write({
      event: "decision",
      tool,
      actionHash: hash,
      agent: this.agent,
      decision: verdict.decision,
      reason: verdict.reason,
      policyDecision: policyVerdict.decision,
      taintedBy: this.taintedBy,
    });

    if (verdict.decision === "deny") return this.block(tool, hash, verdict.reason);

    if (verdict.decision === "approve") {
      const preview = buildPreview(tool, args, this.config.policy.internalDomains);
      for (const [name, value] of Object.entries(facts)) {
        const text = JSON.stringify(value);
        preview.summary.push(`Real ${name} (looked up by Act-Latch): ${text.length > 160 ? text.slice(0, 157) + "..." : text}`);
      }
      if (this.agent) preview.summary.unshift(`Requested by agent "${this.agent}".`);
      const action = humanize(toolName);
      preview.headline = `${this.agent ?? "The agent"} wants to ${action}${server ? ` (in ${server})` : ""}`;
      preview.facts = factLines(facts);
      preview.effect = describeEffect(toolProfile(this.config, tool, undefined, args));
      const { id, outcome } = await this.approver.request({ actionHash: hash, reason: verdict.reason, preview });
      this.audit.write({ event: "approval", tool, actionHash: hash, approvalId: id, outcome });
      if (outcome !== "approved") {
        return this.block(tool, hash, outcome === "timeout" ? "approval timed out" : "a human denied this action");
      }
    }

    try {
      const result = (await up.client.callTool({ name: toolName, arguments: args })) as CallToolResult;
      this.audit.write({ event: "forwarded", tool, actionHash: hash, isError: result.isError ?? false });
      if (up.trust === "untrusted") {
        this.tainted.add(up.name);
        this.audit.write({ event: "untrusted_output", tool, actionHash: hash, server: up.name });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.write({ event: "error", tool, actionHash: hash, message });
      return { isError: true, content: [{ type: "text", text: `Act-Latch: upstream error: ${message}` }] };
    }
  }

  /**
   * Run the configured lookups for this tool: the gateway itself asks a trusted
   * tool for the real values (e.g. an order's price). A lookup that fails leaves
   * its fact missing, which rules treat as over any limit.
   */
  private async lookup(tool: string, args: Args, hash: string): Promise<Facts> {
    const facts: Facts = {};
    for (const lk of this.config.lookups) {
      if (!globMatch(lk.tool, tool)) continue;
      const dot = lk.call.indexOf(".");
      const up = this.upstreams.get(lk.call.slice(0, dot));
      const lookupArgs = Object.fromEntries(Object.entries(lk.args).map(([k, from]) => [k, args[from]]));
      try {
        if (dot <= 0 || !up) throw new Error(`no server for ${lk.call}`);
        const r = (await up.client.callTool({ name: lk.call.slice(dot + 1), arguments: lookupArgs })) as CallToolResult;
        if (r.isError) throw new Error("lookup tool returned an error");
        const first = r.content.find((c) => c.type === "text");
        facts[lk.as] = r.structuredContent ?? JSON.parse(first && first.type === "text" ? first.text : "");
        this.audit.write({ event: "lookup", tool, actionHash: hash, call: lk.call, as: lk.as, ok: true, value: facts[lk.as] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.audit.write({ event: "lookup", tool, actionHash: hash, call: lk.call, as: lk.as, ok: false, message });
      }
    }
    return facts;
  }

  private block(tool: string, hash: string, reason: string): CallToolResult {
    this.audit.write({ event: "blocked", tool, actionHash: hash, reason });
    return {
      isError: true,
      content: [{ type: "text", text: `Act-Latch blocked ${tool}: ${reason.replace(/\.$/, "")}. Do not retry this action in another way.` }],
    };
  }

  /** An MCP server that the agent connects to instead of the real servers. */
  createServer(): Server {
    const server = new Server({ name: "actlatch", version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      this.callTool(req.params.name, (req.params.arguments ?? {}) as Args),
    );
    return server;
  }
}

/** Spawn one upstream server. Credentials go only into its env. */
export async function connectUpstream(name: string, up: Upstream): Promise<ConnectedUpstream> {
  const transport = new StdioClientTransport({
    command: up.command,
    args: [...up.args],
    env: { ...getDefaultEnvironment(), ...up.env },
    cwd: up.cwd,
    stderr: "inherit",
  });
  const client = new Client({ name: "actlatch", version: VERSION });
  await client.connect(transport);
  return { name, trust: up.trust, client };
}

/** Spawn each configured upstream. */
export async function connectUpstreams(config: Config): Promise<Map<string, ConnectedUpstream>> {
  const map = new Map<string, ConnectedUpstream>();
  for (const [name, up] of Object.entries(config.upstreams)) map.set(name, await connectUpstream(name, up));
  return map;
}

/** Ask every configured server for its full tool list. A server that fails is reported, not fatal. */
export async function discoverToolDetails(config: Config): Promise<Map<string, Tool[] | Error>> {
  const found = new Map<string, Tool[] | Error>();
  for (const [name, up] of Object.entries(config.upstreams)) {
    let conn: ConnectedUpstream | undefined;
    try {
      conn = await connectUpstream(name, up);
      found.set(name, (await conn.client.listTools()).tools);
    } catch (err) {
      found.set(name, err instanceof Error ? err : new Error(String(err)));
    } finally {
      await conn?.client.close();
    }
  }
  return found;
}

/** Ask every configured server which tools it has, by name. */
export async function discoverTools(config: Config): Promise<Discovered> {
  const found: Discovered = new Map();
  for (const [name, tools] of await discoverToolDetails(config)) {
    found.set(name, tools instanceof Error ? tools : tools.map((t) => t.name));
  }
  return found;
}

const EFFECTS = {
  read: "Only reads data.",
  write: "Creates or sends something new.",
  update: "Changes existing data, such as money or records.",
  delete: "Deletes data. This usually cannot be undone.",
} as const;

/** One sentence on what kind of action a tool is, for the approval card. */
function describeEffect(p: ToolProfile): string {
  const parts: string[] = [EFFECTS[p.access]];
  if (p.external) parts.push("It can reach people or systems outside your app.");
  if (p.sensitive) parts.push("It touches private data.");
  if (p.agentArg) parts.push("It passes work to another agent.");
  return parts.join(" ");
}
