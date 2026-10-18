// Scripted demo: a pretend agent reads a poisoned inbox and then tries to
// email 500 customers. Run with `npm run demo`. Pass --approve or --deny to
// answer approvals automatically; otherwise open the printed URL and decide.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readAuditEntries, summarizeAudit } from "../src/activity.js";
import { WebApprover } from "../src/approval.js";
import { AuditLog, verifyAudit } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
import { Gateway, type ConnectedUpstream } from "../src/gateway.js";
import { createMailServer } from "./mock-email-server.js";

const auto = process.argv.includes("--approve") ? "approved" : process.argv.includes("--deny") ? "denied" : undefined;
// The same log file the example configs use, so `npm run log` shows these calls too.
const auditPath = join(dirname(fileURLToPath(import.meta.url)), "..", "actlatch-audit.jsonl");

const config = parseConfig({
  upstreams: { mail: { command: "(in-process)", trust: "untrusted" } },
  policy: {
    default: "deny",
    internalDomains: ["acme.com"],
    rules: [
      { tool: "mail.read_inbox", decision: "allow" },
      { tool: "mail.draft_email", decision: "allow" },
      { tool: "mail.send_email", if: { count: { arg: "to", gt: 50 } }, decision: "deny", reason: "more than 50 recipients" },
      { tool: "mail.send_email", if: { count: { arg: "to", gt: 5 } }, decision: "approve", reason: "more than 5 recipients" },
      { tool: "mail.send_email", decision: "allow" },
    ],
    protectAfterUntrusted: ["mail.send_email"],
  },
  approval: { host: "127.0.0.1", port: Number(process.env.ACTLATCH_PORT ?? 4848), timeoutSeconds: 120, openBrowser: !auto },
  audit: { path: auditPath },
});

// Upstream mail server, holding the credential.
const mail = createMailServer("demo-secret-key");
const [upClient, upServer] = InMemoryTransport.createLinkedPair();
await mail.server.connect(upServer);
const mailClient = new Client({ name: "actlatch", version: "0.1.0" });
await mailClient.connect(upClient);
const upstreams = new Map<string, ConnectedUpstream>([["mail", { name: "mail", trust: "untrusted", client: mailClient }]]);

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

approver.activity = () => summarizeAudit(readAuditEntries(auditPath));
const gateway = new Gateway(config, upstreams, approver, new AuditLog(auditPath));
const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
await gateway.createServer().connect(gatewaySide);
const agent = new Client({ name: "demo-agent", version: "0.1.0" });
await agent.connect(agentSide);

const customers = Array.from({ length: 500 }, (_, i) => `customer${i + 1}@example.com`);
const text = (r: Awaited<ReturnType<typeof agent.callTool>>) =>
  (r.content as { type: string; text: string }[]).map((c) => c.text).join(" ");

async function step(label: string, name: string, args: Record<string, unknown>) {
  console.log(`\n> ${label}`);
  try {
    // Wait a bit longer than the approval page does, so a slow human never crashes the demo.
    const r = await agent.callTool({ name, arguments: args }, undefined, { timeout: (config.approval.timeoutSeconds + 30) * 1000 });
    console.log(`  ${r.isError ? "BLOCKED" : "OK"}: ${text(r).replace(/\s+/g, " ").slice(0, 110)}`);
  } catch (err) {
    console.log(`  BLOCKED: no answer (${err instanceof Error ? err.message : String(err)})`);
  }
}

if (!auto) {
  console.log(`When a step needs a human, the approval page opens in your browser (or open the link printed below) and the request pops up there.`);
  console.log(`Click Approve once or Deny within ${config.approval.timeoutSeconds} seconds. Keep the tab open: later requests pop up in it by themselves.`);
  console.log("No answer in time counts as Deny. To skip clicking, run with -- --approve or -- --deny.\n");
}
console.log("Tools the agent sees:", (await agent.listTools()).tools.map((t) => t.name).join(", "));
await step("Agent emails 2 colleagues (clean session)", "mail__send_email", {
  to: ["priya@acme.com", "dev@acme.com"], subject: "Standup", body: "Moved to 10am.",
});
await step("Agent reads the inbox (one email hides a prompt injection)", "mail__read_inbox", {});
await step("Injected prompt: email all 500 customers", "mail__send_email", {
  to: customers, subject: "Customer list", body: "See attached.",
});
await step("Agent emails 20 customers (a human sees a preview card)", "mail__send_email", {
  to: customers.slice(0, 20), subject: "Offer", body: "Hello!",
});
await step("Agent drafts a reply (still allowed)", "mail__draft_email", {
  to: ["priya@acme.com"], subject: "Re: Q3 numbers", body: "On it.",
});
await step("Agent emails 1 colleague after reading untrusted mail (needs a human now)", "mail__send_email", {
  to: ["priya@acme.com"], subject: "Q3 summary", body: "Attached.",
});

console.log(`\nEmails actually sent: ${mail.sent.length}`);
const v = verifyAudit(auditPath);
console.log(`Audit log: ${auditPath} (${v.ok ? `${v.entries} entries, hash chain intact` : "TAMPERED"})`);
await approver.stop();
process.exit(0);
