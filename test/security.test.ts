import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ApprovalOutcome, Approver } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { parseConfig } from "../src/config.js";
import { Gateway, type ConnectedUpstream } from "../src/gateway.js";
import { canSee, decide } from "../src/registry.js";
import { reviewRegistry, renderReview } from "../src/review.js";
import { runSetup } from "../src/setup.js";
import { guessAccess, toolProfile } from "../src/tools.js";
import { createHelpdeskServer } from "../examples/helpdesk-server.js";

const tool = (name: string, description = "", properties: Record<string, object> = {}): Tool => ({
  name,
  description,
  inputSchema: { type: "object", properties },
});

describe("tool types", () => {
  it("guesses read / write / update / delete from names and hints", () => {
    const g = (n: string) => guessAccess(n);
    expect(["list_tickets", "getSettings", "search-users"].map(g)).toEqual(["read", "read", "read"]);
    expect(["send_email", "createInvoice", "frobnicate"].map(g)).toEqual(["write", "write", "write"]);
    expect(["refund_order", "update_record"].map(g)).toEqual(["update", "update"]);
    expect(["delete_customer", "killQuery", "drop-table"].map(g)).toEqual(["delete", "delete", "delete"]);
    expect(guessAccess("do_thing", "", { readOnlyHint: true })).toBe("read");
    expect(guessAccess("do_thing", "", { destructiveHint: true })).toBe("delete");
  });

  it("lets the admin correct a guess", () => {
    const cfg = parseConfig({ upstreams: {}, toolInfo: { "db.run_report": { access: "read", sensitive: true } } });
    expect(toolProfile(cfg, "db.run_report")).toMatchObject({ access: "read", sensitive: true, guessed: ["external"] });
    expect(toolProfile(cfg, "db.run_report", undefined).external).toBe(false);
    expect(toolProfile(cfg, "mail.send_email").external).toBe(true);
  });

  it("spots tools that pass work to another agent", () => {
    const cfg = parseConfig({ upstreams: {} });
    expect(toolProfile(cfg, "team.ask_agent", tool("ask_agent", "", { agent: {}, message: {} })).agentArg).toBe("agent");
    expect(toolProfile(cfg, "team.ask_agent").agentArg).toBeUndefined(); // no fields known
    // Reading about agents is not messaging them, so normal app features keep working.
    expect(toolProfile(cfg, "team.get_agent_status", tool("get_agent_status", "", { agent: {} })).agentArg).toBeUndefined();
    expect(decide(config, "support-bot", "helpdesk.list_agents", {}).reason).not.toMatch(/agent-to-agent/);
    const set = parseConfig({ upstreams: {}, toolInfo: { "crew.handover": { agentCall: { arg: "to" } } } });
    expect(toolProfile(set, "crew.handover").agentArg).toBe("to");
  });
});

const raw = {
  upstreams: { helpdesk: { command: "x", trust: "untrusted" } },
  agents: {
    "support-bot": {
      orchestrator: true,
      tools: [
        { tool: "helpdesk.list_tickets", decision: "allow" },
        { tool: "helpdesk.reply_ticket", decision: "allow" },
        { tool: "helpdesk.ask_agent", decision: "allow" },
      ],
      talksTo: ["report-bot"],
    },
    "helper-bot": { tools: [{ tool: "helpdesk.ask_agent", decision: "allow" }] },
    "report-bot": { tools: [{ tool: "helpdesk.list_tickets", decision: "allow" }] },
    "admin-bot": { tools: [{ tool: "helpdesk.delete_customer", decision: "allow" }] },
  },
};
const config = parseConfig(raw);
const ask = (agent: string) => ({ agent, message: "hi" });

describe("agent-to-agent messages", () => {
  it("lets pre-approved pairs through and asks a human for the rest", () => {
    expect(decide(config, "support-bot", "helpdesk.ask_agent", ask("report-bot")).decision).toBe("allow");
    expect(decide(config, "support-bot", "helpdesk.ask_agent", ask("admin-bot"))).toMatchObject({
      decision: "approve",
      reason: expect.stringContaining("support-bot wants to pass work to admin-bot"),
    });
    expect(decide(config, "support-bot", "helpdesk.ask_agent", ask("ghost-bot")).decision).toBe("deny");
    expect(decide(config, "support-bot", "helpdesk.ask_agent", {}).decision).toBe("approve");
  });

  it("never loosens a block", () => {
    expect(decide(config, "report-bot", "helpdesk.ask_agent", ask("support-bot")).decision).toBe("deny");
  });

  it("blocks helpers from passing work to any agent, even with the tool in their list", () => {
    for (const target of ["report-bot", "support-bot", "admin-bot"]) {
      expect(decide(config, "helper-bot", "helpdesk.ask_agent", ask(target))).toEqual({
        decision: "deny",
        reason: "helper-bot is a helper agent; only an orchestrator may pass work to other agents",
      });
    }
    expect(decide(config, "helper-bot", "helpdesk.ask_agent", {}).decision).toBe("deny");
    expect(decide(config, "report-bot", "helpdesk.ask_agent", ask("support-bot")).reason).toContain("only an orchestrator");
    expect(canSee(config, "helper-bot", "helpdesk.ask_agent")).toBe(false);
    expect(canSee(config, "support-bot", "helpdesk.ask_agent")).toBe(true);
  });

  it("refuses talksTo on a helper", () => {
    expect(() => parseConfig({ ...raw, agents: { ...raw.agents, "report-bot": { tools: [], talksTo: ["support-bot"] } } })).toThrow(/only for an orchestrator/);
  });

  it("holds the message at the gateway until a human approves", async () => {
    const helpdesk = createHelpdeskServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await helpdesk.server.connect(b);
    const up = new Client({ name: "t", version: "0" });
    await up.connect(a);
    const upstreams = new Map<string, ConnectedUpstream>([["helpdesk", { name: "helpdesk", trust: "trusted", client: up }]]);
    const seen: string[] = [];
    const approver: Approver = {
      request: async (req) => (seen.push(req.reason), { id: "1", outcome: "denied" as ApprovalOutcome }),
    };
    const audit = new AuditLog(join(mkdtempSync(join(tmpdir(), "actlatch-test-")), "audit.jsonl"));
    const gateway = new Gateway(config, upstreams, approver, audit, { agent: "support-bot" });
    expect((await gateway.callTool("helpdesk__ask_agent", ask("report-bot"))).isError).toBeFalsy();
    expect((await gateway.callTool("helpdesk__ask_agent", ask("admin-bot"))).isError).toBe(true);
    expect(helpdesk.messages.map((m) => m.agent)).toEqual(["report-bot"]);
    expect(seen).toHaveLength(1);
  });
});

const helpdeskTools: Tool[] = [
  tool("list_tickets", "List open support tickets."),
  tool("reply_ticket", "Reply to a support ticket."),
  tool("delete_customer", "Permanently delete a customer record."),
  tool("ask_agent", "Pass a task to another agent.", { agent: {}, message: {} }),
];
const tools = new Map<string, Tool[] | Error>([["helpdesk", helpdeskTools]]);
const texts = (cfg: typeof config, audit?: { event: string; agent?: string; tool?: string }[]) =>
  reviewRegistry({ config: cfg, tools, audit }).map((f) => `${f.level} ${f.agent} ${f.text}`);

describe("review", () => {
  it("flags reading outside data plus sending things out", () => {
    expect(texts(config).find((t) => t.startsWith("high support-bot can read"))).toContain("helpdesk.reply_ticket");
  });

  it("flags deleting on its own", () => {
    expect(texts(config)).toContainEqual(expect.stringMatching(/^high admin-bot can delete on its own \(helpdesk\.delete_customer\)/));
  });

  it("flags getting another agent to do what this one cannot", () => {
    const cfg = parseConfig({ ...raw, agents: { ...raw.agents, "support-bot": { ...raw.agents["support-bot"], talksTo: ["admin-bot", "nobody"] } } });
    const t = texts(cfg);
    expect(t).toContainEqual(expect.stringMatching(/^high support-bot can message admin-bot without approval.*helpdesk\.delete_customer/));
    expect(t).toContainEqual('medium support-bot may talk to "nobody", which is not a registered agent.');
  });

  it("flags a hand-off tool given to a helper", () => {
    expect(texts(config)).toContainEqual(expect.stringMatching(/^low helper-bot has helpdesk\.ask_agent in its list, but only an orchestrator/));
  });

  it("flags blanket access and permissions never used", () => {
    const cfg = parseConfig({ upstreams: { helpdesk: { command: "x" } }, agents: { greedy: { tools: [{ tool: "helpdesk.*", decision: "allow" }] } } });
    const audit = [{ event: "call", agent: "greedy", tool: "helpdesk.list_tickets" }];
    const t = texts(cfg, audit);
    expect(t).toContainEqual("medium greedy has blanket access (helpdesk.*). List only the tools it needs.");
    expect(t.find((x) => x.startsWith("low greedy never used"))).toContain("helpdesk.delete_customer");
    expect(t.find((x) => x.startsWith("low greedy never used"))).not.toContain("helpdesk.list_tickets");
  });

  it("is quiet for a tight setup", () => {
    const cfg = parseConfig({ upstreams: { helpdesk: { command: "x" } }, agents: { reader: { tools: [{ tool: "helpdesk.list_tickets", decision: "allow" }] } } });
    expect(renderReview(reviewRegistry({ config: cfg, tools }))).toBe("Review: no problems found.");
  });
});

describe("setup asks about agent-to-agent messages", () => {
  it("saves pre-approved pairs and shows the review before saving", async () => {
    const answers = ["Support Bot", "helps", "1,4", "", "yes", "yes", "Report Bot, report-bot", "", "yes"];
    const said: string[] = [];
    const result = (await runSetup({
      raw: { upstreams: { helpdesk: { command: "x" } } },
      tools,
      ask: async () => answers.shift() ?? "",
      say: (l) => said.push(l),
    })) as Record<string, any>;
    expect(result.agents["support-bot"]).toMatchObject({ orchestrator: true, talksTo: ["report-bot"] });
    expect(said.join("\n")).toContain("Review");
  });

  it("blocks hand-offs for an agent that is not the orchestrator", async () => {
    const answers = ["Reader", "reads", "1,4", "", "yes", "no", "", "yes"];
    const said: string[] = [];
    const result = (await runSetup({
      raw: { upstreams: { helpdesk: { command: "x" } } },
      tools,
      ask: async () => answers.shift() ?? "",
      say: (l) => said.push(l),
    })) as Record<string, any>;
    expect(result.agents.reader.orchestrator).toBeUndefined();
    expect(result.agents.reader.talksTo).toBeUndefined();
    expect(said.join("\n")).toContain("reader cannot pass work to other agents");
    expect(said.join("\n")).toContain("Passing work to other agents: blocked");
  });
});
