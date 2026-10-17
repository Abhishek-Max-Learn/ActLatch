import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalOutcome, ApprovalRequest, Approver } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { loadConfig, parseConfig } from "../src/config.js";
import { Gateway, discoverTools, type ConnectedUpstream } from "../src/gateway.js";
import { canSee, decide, describeAccess, identityProblem, renderRegistry } from "../src/registry.js";
import { createHelpdeskServer } from "../examples/helpdesk-server.js";

const raw = {
  upstreams: { helpdesk: { command: "x" } },
  agents: {
    "support-bot": {
      description: "Answers tickets",
      tools: [
        { tool: "helpdesk.list_tickets", decision: "allow" },
        { tool: "helpdesk.reply_ticket", decision: "allow" },
        { tool: "helpdesk.refund_order", if: { number: { arg: "amount", gt: 500 } }, decision: "deny", reason: "over 500" },
        { tool: "helpdesk.refund_order", if: { number: { arg: "amount", gt: 50 } }, decision: "approve" },
        { tool: "helpdesk.refund_order", decision: "allow" },
      ],
    },
    "report-bot": { tools: [{ tool: "helpdesk.list_*", decision: "allow" }] },
    "locked-bot": { key: "${LOCKED_KEY}", tools: [{ tool: "helpdesk.*", decision: "allow" }] },
  },
  policy: {
    rules: [{ tool: "helpdesk.reply_ticket", if: { matches: { arg: "message", pattern: "password" } }, decision: "deny", reason: "secret" }],
  },
};
const config = parseConfig(raw, "/", { LOCKED_KEY: "s3cret" });

describe("registry decisions", () => {
  it("gives each agent only the tools in its entry", () => {
    expect(decide(config, "support-bot", "helpdesk.reply_ticket", {}).decision).toBe("allow");
    expect(decide(config, "report-bot", "helpdesk.list_tickets", {}).decision).toBe("allow");
    const v = decide(config, "report-bot", "helpdesk.reply_ticket", {});
    expect(v).toMatchObject({ decision: "deny", reason: "helpdesk.reply_ticket is not in report-bot's tool list" });
    expect(decide(config, "support-bot", "helpdesk.delete_customer", {}).decision).toBe("deny");
  });

  it("denies unregistered or missing agents", () => {
    expect(decide(config, "intern-bot", "helpdesk.list_tickets", {}).decision).toBe("deny");
    expect(decide(config, undefined, "helpdesk.list_tickets", {}).decision).toBe("deny");
    expect(decide(config, "__proto__", "helpdesk.list_tickets", {}).decision).toBe("deny");
  });

  it("applies per-tool limits", () => {
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: 18 }).decision).toBe("allow");
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: 120 }).decision).toBe("approve");
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: 5000 }).decision).toBe("deny");
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: "5000" }).decision).toBe("deny");
  });

  it("treats a missing or garbled amount as over the limit", () => {
    expect(decide(config, "support-bot", "helpdesk.refund_order", {}).decision).toBe("deny");
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: "lots" }).decision).toBe("deny");
    expect(decide(config, "support-bot", "helpdesk.refund_order", { amount: [1] }).decision).toBe("deny");
  });

  it("global rules can only tighten an agent's entry", () => {
    expect(decide(config, "support-bot", "helpdesk.reply_ticket", { message: "your password is x" })).toMatchObject({
      decision: "deny",
      reason: "secret",
    });
    const loose = parseConfig({ ...raw, policy: { rules: [{ tool: "*", decision: "allow" }] } }, "/", { LOCKED_KEY: "k" });
    expect(decide(loose, "report-bot", "helpdesk.delete_customer", {}).decision).toBe("deny");
  });

  it("checks agent identity and keys", () => {
    expect(identityProblem(config, { agent: "support-bot" })).toBeUndefined();
    expect(identityProblem(config, {})).toMatch(/no agent name/);
    expect(identityProblem(config, { agent: "intern-bot" })).toMatch(/not registered/);
    expect(identityProblem(config, { agent: "locked-bot" })).toMatch(/key does not match/);
    expect(identityProblem(config, { agent: "locked-bot", key: "wrong!" })).toMatch(/key does not match/);
    expect(identityProblem(config, { agent: "locked-bot", key: "s3cret" })).toBeUndefined();
  });

  it("leaves configs without a registry working as before", () => {
    const plain = parseConfig({ upstreams: {}, policy: { rules: [{ tool: "a.b", decision: "allow" }] } });
    expect(identityProblem(plain, {})).toBeUndefined();
    expect(decide(plain, undefined, "a.b", {}).decision).toBe("allow");
    expect(canSee(plain, undefined, "x.y")).toBe(true);
  });

  it("is frozen after load", () => {
    expect(() => (config.agents!["report-bot"]!.tools as unknown[]).push({ tool: "*", decision: "allow" })).toThrow();
  });
});

describe("registry view", () => {
  it("describes access in plain words", () => {
    const tools = config.agents!["support-bot"]!.tools;
    expect(describeAccess(tools, "helpdesk.refund_order")).toBe(
      'blocked if "amount" is more than 500; needs approval if "amount" is more than 50; otherwise allowed',
    );
    expect(describeAccess(tools, "helpdesk.delete_customer")).toBe("blocked");
  });

  it("prints agent -> tools -> allowed actions", () => {
    const text = renderRegistry(
      config,
      new Map<string, string[] | Error>([
        ["helpdesk", ["list_tickets", "reply_ticket", "refund_order", "delete_customer"]],
        ["crm", new Error("spawn failed")],
      ]),
    );
    expect(text).toContain("AGENT support-bot - Answers tickets");
    expect(text).toContain("AGENT locked-bot [key required]");
    expect(text).toMatch(/helpdesk\.refund_order +blocked if "amount" is more than 500/);
    expect(text).toContain("could not reach server \"crm\"");
    expect(text).toContain("Anyone not registered above: blocked from every tool.");
  });

  it("flags entries that match no tool", () => {
    const typo = parseConfig({ upstreams: { helpdesk: { command: "x" } }, agents: { a: { tools: [{ tool: "helpdesk.refnd", decision: "allow" }] } } });
    const text = renderRegistry(typo, new Map([["helpdesk", ["refund"]]]));
    expect(text).toContain("Tools no agent can use: helpdesk.refund");
    expect(text).toContain("Entries that match no tool (typo?): a: helpdesk.refnd");
  });

  it("discovers tools from a real stdio server", async () => {
    const cfg = parseConfig({
      upstreams: {
        helpdesk: { command: resolve("node_modules/.bin/tsx"), args: [resolve("examples/helpdesk-server.ts")] },
        broken: { command: "/nonexistent/server" },
      },
    });
    const found = await discoverTools(cfg);
    expect(found.get("helpdesk")).toEqual(["list_tickets", "reply_ticket", "refund_order", "delete_customer"]);
    expect(found.get("broken")).toBeInstanceOf(Error);
  }, 30_000);

  it("loads the example registry", () => {
    const cfg = loadConfig("examples/agents.yaml");
    expect(Object.keys(cfg.agents!)).toEqual(["support-bot", "report-bot"]);
  });
});

class ScriptedApprover implements Approver {
  seen: Omit<ApprovalRequest, "id" | "createdAt">[] = [];
  constructor(private answer: ApprovalOutcome) {}
  async request(req: Omit<ApprovalRequest, "id" | "createdAt">) {
    this.seen.push(req);
    return { id: `a${this.seen.length}`, outcome: this.answer };
  }
}

async function connectAs(agent: string | undefined, answer: ApprovalOutcome = "denied", key?: string) {
  const helpdesk = createHelpdeskServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await helpdesk.server.connect(b);
  const upClient = new Client({ name: "t", version: "0" });
  await upClient.connect(a);
  const upstreams = new Map<string, ConnectedUpstream>([["helpdesk", { name: "helpdesk", trust: "trusted", client: upClient }]]);
  const approver = new ScriptedApprover(answer);
  const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), "actlatch-test-")), "audit.jsonl"));
  const gateway = new Gateway(config, upstreams, approver, audit, { agent, key });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await gateway.createServer().connect(d);
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(c);
  return { client, helpdesk, approver };
}

const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name);

describe("gateway with a registry", () => {
  it("shows each agent only its own tools", async () => {
    expect(await names((await connectAs("support-bot")).client)).toEqual([
      "helpdesk__list_tickets",
      "helpdesk__reply_ticket",
      "helpdesk__refund_order",
    ]);
    expect(await names((await connectAs("report-bot")).client)).toEqual(["helpdesk__list_tickets"]);
    expect(await names((await connectAs("intern-bot")).client)).toEqual([]);
  });

  it("enforces limits and asks a human with the agent named", async () => {
    const { client, helpdesk, approver } = await connectAs("support-bot", "denied");
    expect((await client.callTool({ name: "helpdesk__refund_order", arguments: { order_id: "O", amount: 18 } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "helpdesk__refund_order", arguments: { order_id: "O", amount: 120 } })).isError).toBe(true);
    expect((await client.callTool({ name: "helpdesk__refund_order", arguments: { order_id: "O", amount: 5000 } })).isError).toBe(true);
    expect(helpdesk.refunds).toEqual([{ order_id: "O", amount: 18 }]);
    expect(approver.seen).toHaveLength(1);
    expect(approver.seen[0]!.preview.summary).toContain('Requested by agent "support-bot".');
    expect(approver.seen[0]!.preview.summary).toContain("amount: 120");
  });

  it("blocks unlisted tools even if the agent knows their names", async () => {
    const { client, helpdesk } = await connectAs("support-bot");
    const r = await client.callTool({ name: "helpdesk__delete_customer", arguments: { customer_id: "C-9" } });
    expect(r.isError).toBe(true);
    expect(helpdesk.deleted).toHaveLength(0);
  });

  it("blocks every call from an unregistered agent or a wrong key", async () => {
    for (const [agent, key] of [["intern-bot", undefined], [undefined, undefined], ["locked-bot", "nope"]] as const) {
      const { client } = await connectAs(agent, "approved", key);
      const r = await client.callTool({ name: "helpdesk__list_tickets", arguments: {} });
      expect(r.isError).toBe(true);
    }
    const { client } = await connectAs("locked-bot", "approved", "s3cret");
    expect((await client.callTool({ name: "helpdesk__list_tickets", arguments: {} })).isError).toBeFalsy();
  });
});
