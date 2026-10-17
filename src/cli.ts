#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebApprover } from "./approval.js";
import { AuditLog, verifyAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { Gateway, connectUpstreams, discoverTools } from "./gateway.js";
import { renderRegistry } from "./registry.js";

const USAGE = `usage:
  actlatch start [--config actlatch.yaml] [--agent <name>]
                                            run the gateway as an MCP server on stdio for one agent
                                            (the agent's key, if it has one, comes from ACTLATCH_AGENT_KEY)
  actlatch registry [--config actlatch.yaml]
                                            show every agent, the tools it can use and what each allows
  actlatch verify-audit <file.jsonl>        check the audit log's hash chain`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "start") {
    const config = loadConfig(flag(rest, "--config") ?? "actlatch.yaml");
    const approver = new WebApprover(config.approval);
    await approver.start();
    const identity = { agent: flag(rest, "--agent") ?? process.env.ACTLATCH_AGENT, key: process.env.ACTLATCH_AGENT_KEY };
    const gateway = new Gateway(config, await connectUpstreams(config), approver, new AuditLog(config.audit.path), identity);
    await gateway.createServer().connect(new StdioServerTransport());
    if (gateway.identityError) process.stderr.write(`[actlatch] WARNING: ${gateway.identityError}; every call will be blocked\n`);
    const who = gateway.agent && !gateway.identityError ? ` for agent "${gateway.agent}"` : "";
    process.stderr.write(`[actlatch] gateway ready${who}; audit log at ${config.audit.path}\n`);
    return -1; // keep running
  }
  if (cmd === "registry") {
    const config = loadConfig(flag(rest, "--config") ?? "actlatch.yaml");
    console.log(renderRegistry(config, await discoverTools(config)));
    return 0;
  }
  if (cmd === "verify-audit" && rest[0]) {
    const r = verifyAudit(rest[0]);
    if (r.ok) console.log(`ok: ${r.entries} entries, chain intact`);
    else console.log(`TAMPERED at line ${r.line}: ${r.problem}`);
    return r.ok ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => code >= 0 && process.exit(code),
  (err) => {
    console.error(`[actlatch] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  },
);
