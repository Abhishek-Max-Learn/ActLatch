#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebApprover } from "./approval.js";
import { AuditLog, verifyAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { Gateway, connectUpstreams } from "./gateway.js";

const USAGE = `usage:
  actlatch start [--config actlatch.yaml]   run the gateway as an MCP server on stdio
  actlatch verify-audit <file.jsonl>        check the audit log's hash chain`;

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "start") {
    const i = rest.indexOf("--config");
    const config = loadConfig(i >= 0 ? rest[i + 1]! : "actlatch.yaml");
    const approver = new WebApprover(config.approval);
    await approver.start();
    const gateway = new Gateway(config, await connectUpstreams(config), approver, new AuditLog(config.audit.path));
    await gateway.createServer().connect(new StdioServerTransport());
    process.stderr.write(`[actlatch] gateway ready; audit log at ${config.audit.path}\n`);
    return -1; // keep running
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
