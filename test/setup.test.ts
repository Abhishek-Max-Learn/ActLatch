import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { decide } from "../src/registry.js";
import {
  answersToRules,
  basicQuestions,
  chatApiDrafter,
  checkDraft,
  parseAccess,
  parseLimit,
  pickDrafter,
  runSetup,
  toSetupTool,
  type Draft,
} from "../src/setup.js";

const refundTool: Tool = {
  name: "refund_order",
  description: "Refund money for an order.",
  inputSchema: { type: "object", properties: { order_id: { type: "string" }, amount: { type: "number" } } },
};
const listTool: Tool = { name: "list_tickets", description: "List tickets.", inputSchema: { type: "object" } };
const replyTool: Tool = {
  name: "reply_ticket",
  inputSchema: { type: "object", properties: { message: { type: "string" }, cc: { type: "array" } } },
};
const refund = toSetupTool("helpdesk", refundTool);

describe("setup questions", () => {
  it("asks about access and numeric limits from the tool's fields", () => {
    const qs = basicQuestions("support-bot", refund);
    expect(qs.map((q) => [q.kind, q.field])).toEqual([
      ["access", undefined],
      ["deny_above", "amount"],
      ["approve_above", "amount"],
    ]);
    expect(qs[0]!.suggested).toBe("ask"); // refunds move money
    expect(basicQuestions("a", toSetupTool("helpdesk", listTool))[0]!.suggested).toBe("yes");
  });

  it("reads yes / ask / no in English and Hinglish", () => {
    expect(["yes", "Haan", "y"].map(parseAccess)).toEqual(["yes", "yes", "yes"]);
    expect(["ask", "poochke", "approve"].map(parseAccess)).toEqual(["ask", "ask", "ask"]);
    expect(["no", "nahi", "never"].map(parseAccess)).toEqual(["no", "no", "no"]);
    expect(parseAccess("maybe")).toBeUndefined();
    expect([parseLimit(""), parseLimit("$500"), parseLimit("1,000"), parseLimit("lots")]).toEqual([undefined, 500, 1000, "invalid"]);
  });

  it("turns answers into rules that enforce what was said", () => {
    const qs = basicQuestions("support-bot", refund);
    const rules = answersToRules(refund.id, [
      { q: qs[0]!, answer: "yes" },
      { q: qs[1]!, answer: "500" },
      { q: qs[2]!, answer: "50" },
    ]);
    const cfg = parseConfig({ upstreams: {}, agents: { "support-bot": { tools: rules } } });
    const d = (amount: number) => decide(cfg, "support-bot", refund.id, { amount }).decision;
    expect([d(20), d(120), d(900)]).toEqual(["allow", "approve", "deny"]);
  });

  it("'no' leaves the tool out, 'ask' approves every use but keeps hard limits", () => {
    const qs = basicQuestions("a", refund);
    expect(answersToRules(refund.id, [{ q: qs[0]!, answer: "no" }])).toEqual([]);
    const rules = answersToRules(refund.id, [
      { q: qs[0]!, answer: "ask" },
      { q: qs[1]!, answer: "500" },
    ]);
    expect(rules.map((r) => r.decision)).toEqual(["deny", "approve"]);
  });

  it("blocks listed words in text fields, matched literally", () => {
    const tool = toSetupTool("helpdesk", replyTool);
    const rules = answersToRules(tool.id, [
      { q: { kind: "access", text: "", suggested: "yes" }, answer: "yes" },
      { q: { kind: "block_words", field: "message", text: "", suggested: "" }, answer: "password, card no." },
    ]);
    const cfg = parseConfig({ upstreams: {}, agents: { a: { tools: rules } } });
    expect(decide(cfg, "a", tool.id, { message: "your PASSWORD is" }).decision).toBe("deny");
    expect(decide(cfg, "a", tool.id, { message: "card nos" }).decision).toBe("allow"); // "." is not a wildcard
    expect(decide(cfg, "a", tool.id, { message: "hello" }).decision).toBe("allow");
  });
});

describe("LLM-drafted questions", () => {
  const draft: Draft = {
    access_question: "Kya support-bot refund kar sakta hai?",
    access_suggested: "yes",
    questions: [
      { kind: "approve_above", field: "amount", text: "Kitne se upar insaan se poochna hai?", suggested: "50" },
      { kind: "deny_above", field: "nonexistent", text: "made up field", suggested: "1" },
      { kind: "block_words", field: "amount", text: "wrong type", suggested: "x" },
    ],
  };

  it("keeps only questions about real fields of the right type", () => {
    const qs = checkDraft("support-bot", refund, draft);
    expect(qs.map((q) => q.text)).toEqual(["Kya support-bot refund kar sakta hai?", "Kitne se upar insaan se poochna hai?"]);
  });

  it("works with any OpenAI-compatible API, and falls back to basic questions on failure", async () => {
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(draft) + "\n```" } }] }));
    }) as typeof fetch;
    const d = chatApiDrafter({ baseUrl: "http://llm.local/v1/", model: "m" }, undefined, ok);
    expect((await d("support-bot", "refunds", refund))[1]!.suggested).toBe("50");

    const errors: string[] = [];
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    const d2 = chatApiDrafter({ baseUrl: "http://llm.local/v1", model: "m" }, (m) => errors.push(m), bad);
    expect(await d2("a", "", refund)).toEqual(basicQuestions("a", refund));
    expect(errors).toEqual(["LLM API answered 500"]);
    expect(calls).toBe(1);
  });

  it("uses whatever LLM the app already has", () => {
    const claude = () => ({}) as never;
    expect(pickDrafter({}, claude).drafter).toBeUndefined();
    expect(pickDrafter({ OPENAI_API_KEY: "k" }, claude).label).toContain("OpenAI");
    expect(pickDrafter({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }, claude).label).toContain("Claude");
    expect(pickDrafter({ ACTLATCH_LLM_URL: "http://localhost:11434/v1", ACTLATCH_LLM_MODEL: "llama" }, claude).label).toContain("localhost");
    expect(pickDrafter({ ACTLATCH_LLM: "off", ANTHROPIC_API_KEY: "k" }, claude).drafter).toBeUndefined();
  });
});

describe("runSetup", () => {
  const script = (answers: string[]) => {
    const asked: string[] = [];
    return { asked, ask: async (q: string) => (asked.push(q), answers.shift() ?? "") };
  };
  const tools = new Map<string, Tool[] | Error>([
    ["helpdesk", [listTool, refundTool]],
    ["crm", new Error("down")],
  ]);
  const raw = { upstreams: { helpdesk: { command: "x", env: { KEY: "${HELPDESK_KEY}" } } } };

  it("builds the registry from answers and shows it before saving", async () => {
    const said: string[] = [];
    const { ask } = script(["support-bot", "Answers tickets", "", "yes", "500", "", "", "yes"]);
    const result = (await runSetup({ raw, tools, ask, say: (l) => said.push(l) })) as Record<string, any>;
    expect(result.upstreams.helpdesk.env.KEY).toBe("${HELPDESK_KEY}"); // secrets stay as references
    expect(result.agents["support-bot"].tools.map((r: { decision: string }) => r.decision)).toEqual(["allow", "deny", "allow"]);
    const shown = said.join("\n");
    expect(shown).toContain('could not reach server "crm"');
    expect(shown).toMatch(/helpdesk\.refund_order +blocked if "amount" is more than 500; otherwise allowed/);
  });

  it("re-asks unclear answers and saves nothing without a yes", async () => {
    const { ask, asked } = script(["bad name!", "bot", "", "maybe", "no", "no", "", "no"]);
    expect(await runSetup({ raw, tools, ask, say: () => {} })).toBeUndefined();
    expect(asked.some((q) => q.includes("Please answer yes, ask or no"))).toBe(true);
  });

  it("uses drafted questions when given a drafter", async () => {
    const { ask, asked } = script(["bot", "d", "", "", "", "yes"]);
    const draft = async () => [{ kind: "access" as const, text: "Custom question?", suggested: "yes" }];
    await runSetup({ raw, tools, ask, say: () => {}, draft });
    expect(asked.filter((q) => q.includes("Custom question?"))).toHaveLength(2);
  });
});
