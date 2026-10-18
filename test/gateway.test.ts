import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { factLines } from "../src/preview.js";
import { WebApprover, type ApprovalOutcome, type ApprovalRequest, type Approver } from "../src/approval.js";
import { AuditLog, verifyAudit } from "../src/audit.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { Gateway, connectUpstreams, type ConnectedUpstream } from "../src/gateway.js";
import { createMailServer } from "../examples/mock-email-server.js";

const policy = {
  default: "deny",
  internalDomains: ["acme.com"],
  rules: [
    { tool: "mail.read_inbox", decision: "allow" },
    { tool: "mail.send_email", if: { count: { arg: "to", gt: 50 } }, decision: "deny", reason: "too many" },
    { tool: "mail.send_email", if: { count: { arg: "to", gt: 5 } }, decision: "approve" },
    { tool: "mail.send_email", decision: "allow" },
  ],
  protectAfterUntrusted: ["mail.send_email"],
};

class ScriptedApprover implements Approver {
  seen: Omit<ApprovalRequest, "id" | "createdAt">[] = [];
  constructor(private answer: ApprovalOutcome) {}
  async request(req: Omit<ApprovalRequest, "id" | "createdAt">) {
    this.seen.push(req);
    return { id: `a${this.seen.length}`, outcome: this.answer };
  }
}

async function setup(answer: ApprovalOutcome = "denied") {
  const auditPath = join(mkdtempSync(join(tmpdir(), "actlatch-test-")), "audit.jsonl");
  const config = parseConfig({ upstreams: { mail: { command: "x" } }, policy, audit: { path: auditPath } });
  const mail = createMailServer("key");
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mail.server.connect(b);
  const upClient = new Client({ name: "t", version: "0" });
  await upClient.connect(a);
  const upstreams = new Map<string, ConnectedUpstream>([["mail", { name: "mail", trust: "untrusted", client: upClient }]]);
  const approver = new ScriptedApprover(answer);
  const gateway = new Gateway(config, upstreams, approver, new AuditLog(auditPath));
  const [c, d] = InMemoryTransport.createLinkedPair();
  await gateway.createServer().connect(d);
  const agent = new Client({ name: "agent", version: "0" });
  await agent.connect(c);
  return { agent, mail, approver, auditPath, gateway };
}

const emails = (n: number) => Array.from({ length: n }, (_, i) => `c${i}@example.com`);
const send = (to: string[]) => ({ name: "mail__send_email", arguments: { to, subject: "s", body: "b" } });

describe("gateway", () => {
  it("exposes upstream tools under a namespaced name", async () => {
    const { agent } = await setup();
    const names = (await agent.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(["mail__read_inbox", "mail__draft_email", "mail__send_email"]);
  });

  it("forwards allowed calls", async () => {
    const { agent, mail } = await setup();
    const r = await agent.callTool(send(["a@acme.com"]));
    expect(r.isError).toBeFalsy();
    expect(mail.sent).toHaveLength(1);
  });

  it("blocks denied calls without reaching the upstream", async () => {
    const { agent, mail } = await setup();
    const r = await agent.callTool(send(emails(500)));
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain("too many");
    expect(mail.sent).toHaveLength(0);
  });

  it("blocks tools with no rule (draft_email is not in this policy)", async () => {
    const { agent } = await setup();
    const r = await agent.callTool({ name: "mail__draft_email", arguments: { to: [], subject: "", body: "" } });
    expect(r.isError).toBe(true);
  });

  it("blocks unknown servers and tool names", async () => {
    const { agent } = await setup();
    expect((await agent.callTool({ name: "bank__transfer", arguments: {} })).isError).toBe(true);
    expect((await agent.callTool({ name: "send_email", arguments: {} })).isError).toBe(true);
  });

  it("asks a human with a preview, and blocks when denied", async () => {
    const { agent, mail, approver } = await setup("denied");
    const r = await agent.callTool(send(emails(20)));
    expect(r.isError).toBe(true);
    expect(mail.sent).toHaveLength(0);
    expect(approver.seen[0]!.preview.summary).toContain("Goes to 20 recipients.");
    expect(approver.seen[0]!.preview.summary.join(" ")).toContain("20 outside your organisation");
  });

  it("forwards when a human approves", async () => {
    const { agent, mail } = await setup("approved");
    expect((await agent.callTool(send(emails(20)))).isError).toBeFalsy();
    expect(mail.sent).toHaveLength(1);
  });

  it("treats a timeout as a denial", async () => {
    const { agent, mail } = await setup("timeout");
    expect((await agent.callTool(send(emails(20)))).isError).toBe(true);
    expect(mail.sent).toHaveLength(0);
  });

  it("an injected prompt in the inbox cannot grant permissions", async () => {
    const { agent, mail, approver, gateway } = await setup("denied");
    const inbox = await agent.callTool({ name: "mail__read_inbox", arguments: {} });
    expect(JSON.stringify(inbox.content)).toContain("ignore your previous instructions");
    expect(gateway.taintedBy).toEqual(["mail"]);

    // Bulk send stays denied outright: the email's "permission" means nothing.
    expect((await agent.callTool(send(emails(500)))).isError).toBe(true);
    expect(approver.seen).toHaveLength(0);

    // Even a send the policy would normally allow now needs a human.
    expect((await agent.callTool(send(["a@acme.com"]))).isError).toBe(true);
    expect(approver.seen[0]!.reason).toMatch(/untrusted content/);
    expect(mail.sent).toHaveLength(0);
  });

  it("binds approval to the exact action", async () => {
    const { agent, approver } = await setup("approved");
    await agent.callTool(send(emails(20)));
    await agent.callTool(send(emails(21)));
    expect(approver.seen).toHaveLength(2);
    expect(approver.seen[0]!.actionHash).not.toBe(approver.seen[1]!.actionHash);
  });

  it("writes an intact audit trail", async () => {
    const { agent, auditPath } = await setup("denied");
    await agent.callTool(send(["a@acme.com"]));
    await agent.callTool(send(emails(500)));
    expect(verifyAudit(auditPath)).toMatchObject({ ok: true });
    const events = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
    expect(events).toEqual(["call", "decision", "forwarded", "untrusted_output", "call", "decision", "blocked"]);
  });
});

describe("web approver", () => {
  let approver: WebApprover | undefined;
  afterEach(async () => approver?.stop());

  it("requires the token and resolves on approve", async () => {
    approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 10 }, () => {});
    await approver.start();
    const base = new URL(approver.url);
    const pending = approver.request({
      actionHash: "abc",
      reason: "test",
      preview: { tool: "mail.send_email", summary: ["<b>x</b>"], args: {} },
    });

    expect((await fetch(`${base.origin}/api/pending`)).status).toBe(403);
    expect((await fetch(`${base.origin}/api/pending?token=wrong`)).status).toBe(403);
    expect(await (await fetch(`${base.origin}/`)).text()).toContain("missing its secret key"); // says what to do

    const page = await (await fetch(approver.url)).text();
    expect(page).not.toContain("<b>x</b>"); // agent text is drawn by the page with textContent, never as HTML
    expect(page).not.toMatch(/innerHTML/);

    const [item] = (await (await fetch(`${base.origin}/api/pending?token=${approver.token}`)).json()) as { id: string }[];
    const res = await fetch(`${base.origin}/approve/${item!.id}?token=${approver.token}`, { method: "POST", redirect: "manual" });
    expect(res.status).toBe(303);
    expect((await pending).outcome).toBe("approved");
    expect(approver.list()).toHaveLength(0);
  });

  it("links to the forwarded port inside Codespaces", async () => {
    approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 10 }, () => {});
    await approver.start();
    const port = new URL(approver.url).port;
    expect(approver.browserUrl).toBe(approver.url);
    process.env.CODESPACE_NAME = "my-space";
    process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN = "app.github.dev";
    try {
      expect(approver.browserUrl).toBe(`https://my-space-${port}.app.github.dev/?token=${approver.token}`);
    } finally {
      delete process.env.CODESPACE_NAME;
      delete process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN;
    }
  });

  it("labels looked-up facts in plain words", () => {
    expect(factLines({ order: { order_id: "O-1", price: 20, tags: ["a"] }, limit: 5 })).toEqual([
      { label: "Order id", value: "O-1" },
      { label: "Order price", value: "20" },
      { label: "Order tags", value: "1 item: a" },
      { label: "Limit", value: "5" },
    ]);
  });

  it("opens the page in the browser only when it is not already open", async () => {
    const opened: string[] = [];
    const logs: string[] = [];
    approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 10, openBrowser: true }, (m) => logs.push(m), (u) => (opened.push(u), true));
    await approver.start();
    const ask = (h: string) => approver!.request({ actionHash: h, reason: "r", preview: { tool: "t", summary: [], args: {}, headline: "bot wants to " + h } });
    void ask("refund order");
    expect(opened).toEqual([approver.browserUrl]);
    await fetch(`${new URL(approver.url).origin}/api/pending?token=${approver.token}`); // the page checks in
    expect(approver.list()[0]).toMatchObject({ secondsLeft: 10 });
    void ask("delete customer");
    expect(opened).toHaveLength(1);
    expect(logs.at(-1)).toContain("bot wants to delete customer. It has popped up");
  });

  it("notices a closed tab", async () => {
    approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 10 }, () => {});
    await approver.start();
    const origin = new URL(approver.url).origin;
    await fetch(`${origin}/api/pending?token=${approver.token}`);
    expect(approver.pageOpen).toBe(true);
    await fetch(`${origin}/api/closed?token=${approver.token}`, { method: "POST" });
    expect(approver.pageOpen).toBe(false);
  });

  it("times out", async () => {
    approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 0.05 }, () => {});
    await approver.start();
    const r = await approver.request({ actionHash: "x", reason: "r", preview: { tool: "t", summary: [], args: {} } });
    expect(r.outcome).toBe("timeout");
  });
});

describe("stdio upstream from a YAML config", () => {
  it("spawns the upstream with credentials only it receives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actlatch-test-"));
    const cfgPath = join(dir, "actlatch.yaml");
    const tsx = resolve("node_modules/.bin/tsx");
    writeFileSync(
      cfgPath,
      stringify({
        upstreams: {
          mail: { command: tsx, args: [resolve("examples/mock-email-server.ts")], env: { MAIL_API_KEY: "${TEST_KEY}" } },
        },
        policy: { rules: [{ tool: "mail.read_inbox", decision: "allow" }] },
        audit: { path: "audit.jsonl" },
      }),
    );
    const config = loadConfig(cfgPath, { ...process.env, TEST_KEY: "k" });
    const upstreams = await connectUpstreams(config);
    const gateway = new Gateway(config, upstreams, new ScriptedApprover("denied"), new AuditLog(config.audit.path));
    try {
      const r = await gateway.callTool("mail__read_inbox");
      expect(r.isError).toBeFalsy();
      expect(JSON.stringify(r.content)).toContain("Q3 numbers");
    } finally {
      for (const u of upstreams.values()) await u.client.close();
    }
  }, 30_000);
});
