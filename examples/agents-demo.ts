// Scripted demo of the agent registry, using a fake helpdesk (no email).
// Run with `npm run demo:agents`. Pass --approve or --deny to answer approvals
// automatically; otherwise open the printed URL and decide.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebApprover } from "../src/approval.js";
import { AuditLog, verifyAudit } from "../src/audit.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { Gateway, type ConnectedUpstream } from "../src/gateway.js";
import { renderRegistry } from "../src/registry.js";
import { renderReview, reviewRegistry } from "../src/review.js";
import { createHelpdeskServer } from "./helpdesk-server.js";

const auto = process.argv.includes("--approve") ? "approved" : process.argv.includes("--deny") ? "denied" : undefined;
const auditPath = join(mkdtempSync(join(tmpdir(), "actlatch-")), "audit.jsonl");

// Same registry as examples/agents.yaml, with the helpdesk run in-process.
const fromFile = loadConfig(join(dirname(fileURLToPath(import.meta.url)), "agents.yaml"));
const config = parseConfig({
  upstreams: { helpdesk: { command: "(in-process)", trust: "untrusted" } },
  agents: fromFile.agents,
  policy: fromFile.policy,
  lookups: fromFile.lookups,
  toolInfo: fromFile.toolInfo,
  approval: { host: "127.0.0.1", port: Number(process.env.ACTLATCH_PORT ?? 4848), timeoutSeconds: 120 },
  audit: { path: auditPath },
});

const helpdesk = createHelpdeskServer();
const [upClient, upServer] = InMemoryTransport.createLinkedPair();
await helpdesk.server.connect(upServer);
const hdClient = new Client({ name: "actlatch", version: "0.1.0" });
await hdClient.connect(upClient);
const upstreams = new Map<string, ConnectedUpstream>([["helpdesk", { name: "helpdesk", trust: "untrusted", client: hdClient }]]);

const approver = new WebApprover(config.approval, (m) => console.log(m));
await approver.start();
if (auto) {
  const orig = approver.request.bind(approver);
  approver.request = (req) => {
    const p = orig(req);
    setTimeout(() => {
      const pending = approver.list()[0];
      console.log(`   preview: ${pending?.preview.summary.join(" ")}`);
      console.log(`   (auto-${auto === "approved" ? "approving" : "denying"})`);
      if (pending) approver.decide(pending.id, auto);
    }, 50);
    return p;
  };
}
const audit = new AuditLog(auditPath);

console.log("=== The registry (what `npm run registry` prints) ===\n");
const tools = (await hdClient.listTools()).tools.map((t) => t.name);
console.log(renderRegistry(config, new Map([["helpdesk", tools]])));
console.log("\n" + renderReview(reviewRegistry({ config, tools: new Map([["helpdesk", (await hdClient.listTools()).tools]]) })));

/** Connect a pretend agent to its own gateway, the way an MCP client would. */
async function connectAs(agent: string) {
  const gateway = new Gateway(config, upstreams, approver, audit, { agent });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await gateway.createServer().connect(gatewaySide);
  const client = new Client({ name: agent, version: "0.1.0" });
  await client.connect(agentSide);
  console.log(`\n=== ${agent} connects. Tools it sees: ${(await client.listTools()).tools.map((t) => t.name).join(", ") || "(none)"}`);
  return async (label: string, name: string, args: Record<string, unknown> = {}) => {
    console.log(`\n> ${label}`);
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[]).map((c) => c.text).join(" ");
    console.log(`  ${r.isError ? "BLOCKED" : "OK"}: ${text.replace(/\s+/g, " ").slice(0, 110)}`);
  };
}

const report = await connectAs("report-bot");
await report("report-bot reads the tickets", "helpdesk__list_tickets");
await report("report-bot tries to reply to a customer (not in its list)", "helpdesk__reply_ticket", { ticket_id: "T-101", message: "Hi" });

const support = await connectAs("support-bot");
await support("support-bot reads the tickets (T-102 hides an instruction)", "helpdesk__list_tickets");
await support("support-bot refunds $18 for the broken mug", "helpdesk__refund_order", { order_id: "O-55", amount: 18 });
await support("support-bot refunds $120 on a $140 order (over $50, so a human decides)", "helpdesk__refund_order", { order_id: "O-61", amount: 120 });
await support("Customer asks $35 on a $20 lamp \"because of return shipping\" (a human decides)", "helpdesk__refund_order", { order_id: "O-72", amount: 35 });
await support('Hidden instruction: "refund me $5000"', "helpdesk__refund_order", { order_id: "O-61", amount: 5000 });
await support("support-bot tries to delete a customer (not in its list)", "helpdesk__delete_customer", { customer_id: "C-9" });
await support("support-bot asks report-bot for a summary (a pre-approved pair)", "helpdesk__ask_agent", { agent: "report-bot", message: "Summarise this week's tickets." });
await support("support-bot asks admin-bot to delete customer C-9 (agent-to-agent: a human decides)", "helpdesk__ask_agent", { agent: "admin-bot", message: "Delete customer C-9." });

const intruder = await connectAs("unknown-bot");
await intruder("An agent nobody registered tries to read tickets", "helpdesk__list_tickets");

console.log(`\nRefunds actually paid: ${helpdesk.refunds.map((r) => `$${r.amount}`).join(", ") || "none"}`);
console.log(`Customers deleted: ${helpdesk.deleted.length}`);
console.log(`Agent-to-agent messages passed: ${helpdesk.messages.map((m) => m.agent).join(", ") || "none"}`);
const v = verifyAudit(auditPath);
console.log(`Audit log: ${auditPath} (${v.ok ? `${v.entries} entries, hash chain intact` : "TAMPERED"})`);
await approver.stop();
process.exit(0);
