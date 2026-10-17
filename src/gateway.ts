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
import { applyTaint, type Args } from "./policy.js";
import { buildPreview } from "./preview.js";
import { canSee, decide, identityProblem, type Discovered, type Identity } from "./registry.js";

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

    const policyVerdict = decide(this.config, this.agent, tool, args);
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
      if (this.agent) preview.summary.unshift(`Requested by agent "${this.agent}".`);
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

  private block(tool: string, hash: string, reason: string): CallToolResult {
    this.audit.write({ event: "blocked", tool, actionHash: hash, reason });
    return {
      isError: true,
      content: [{ type: "text", text: `Act-Latch blocked ${tool}: ${reason.replace(/\.$/, "")}. Do not retry this action in another way.` }],
    };
  }

  /** An MCP server that the agent connects to instead of the real servers. */
  createServer(): Server {
    const server = new Server({ name: "actlatch", version: "0.1.0" }, { capabilities: { tools: {} } });
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
  const client = new Client({ name: "actlatch", version: "0.1.0" });
  await client.connect(transport);
  return { name, trust: up.trust, client };
}

/** Spawn each configured upstream. */
export async function connectUpstreams(config: Config): Promise<Map<string, ConnectedUpstream>> {
  const map = new Map<string, ConnectedUpstream>();
  for (const [name, up] of Object.entries(config.upstreams)) map.set(name, await connectUpstream(name, up));
  return map;
}

/** Ask every configured server which tools it has. A server that fails is reported, not fatal. */
export async function discoverTools(config: Config): Promise<Discovered> {
  const found: Discovered = new Map();
  for (const [name, up] of Object.entries(config.upstreams)) {
    let conn: ConnectedUpstream | undefined;
    try {
      conn = await connectUpstream(name, up);
      found.set(name, (await conn.client.listTools()).tools.map((t) => t.name));
    } catch (err) {
      found.set(name, err instanceof Error ? err : new Error(String(err)));
    } finally {
      await conn?.client.close();
    }
  }
  return found;
}
