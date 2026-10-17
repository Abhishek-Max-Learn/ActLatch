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
import { applyTaint, evaluate, type Args } from "./policy.js";
import { buildPreview } from "./preview.js";

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

  constructor(
    private readonly config: Config,
    private readonly upstreams: Map<string, ConnectedUpstream>,
    private readonly approver: Approver,
    private readonly audit: AuditLog,
  ) {}

  get taintedBy(): string[] {
    return [...this.tainted];
  }

  async listTools(): Promise<Tool[]> {
    const out: Tool[] = [];
    for (const up of this.upstreams.values()) {
      const { tools } = await up.client.listTools();
      for (const t of tools) {
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
    this.audit.write({ event: "call", tool, actionHash: hash, args });

    const up = this.upstreams.get(server);
    if (!up) return this.block(tool, hash, `unknown tool ${exposedName}`);

    const policyVerdict = evaluate(this.config.policy, tool, args);
    const verdict = applyTaint(this.config.policy, tool, policyVerdict, this.taintedBy);
    this.audit.write({
      event: "decision",
      tool,
      actionHash: hash,
      decision: verdict.decision,
      reason: verdict.reason,
      policyDecision: policyVerdict.decision,
      taintedBy: this.taintedBy,
    });

    if (verdict.decision === "deny") return this.block(tool, hash, verdict.reason);

    if (verdict.decision === "approve") {
      const preview = buildPreview(tool, args, this.config.policy.internalDomains);
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

/** Spawn each configured upstream. Credentials go only into the upstream's env. */
export async function connectUpstreams(config: Config): Promise<Map<string, ConnectedUpstream>> {
  const map = new Map<string, ConnectedUpstream>();
  for (const [name, up] of Object.entries(config.upstreams)) {
    const transport = new StdioClientTransport({
      command: up.command,
      args: [...up.args],
      env: { ...getDefaultEnvironment(), ...up.env },
      cwd: up.cwd,
      stderr: "inherit",
    });
    const client = new Client({ name: "actlatch", version: "0.1.0" });
    await client.connect(transport);
    map.set(name, { name, trust: up.trust, client });
  }
  return map;
}
