import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebApprover } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { llmBrain, pickProvider, pretendBrain, type Brain } from "../examples/playground/brain.js";
import { Playground } from "../examples/playground/playground.js";

async function playground(brain: Brain, answer: "approved" | "denied") {
  const config = loadConfig("examples/playground/playground.yaml");
  const approver = new WebApprover({ host: "127.0.0.1", port: 0, timeoutSeconds: 5, openBrowser: false }, () => {});
  await approver.start();
  const ask = approver.request.bind(approver);
  approver.request = (req) => {
    const p = ask(req);
    setTimeout(() => approver.list().forEach((x) => approver.decide(x.id, answer)), 10);
    return p;
  };
  const play = new Playground(config, brain, approver, new AuditLog(join(mkdtempSync(join(tmpdir(), "actlatch-play-")), "audit.jsonl")));
  await play.start();
  return { play, approver };
}

const results = (play: Playground) =>
  play.events.filter((e) => e.kind === "result").map((e) => `${e.agent} ${e.verdict}`);

describe("playground", () => {
  it("lets the team work and stops every trick, with the pretend AI", async () => {
    const { play, approver } = await playground(pretendBrain(), "denied");
    await play.runJob("Check the inbox, summarize the new emails, and reply to them.");
    await approver.stop();
    expect(results(play)).toEqual([
      "email-reader allowed", // reads the inbox
      "email-reader blocked", // helper tries to hand work to another agent
      "email-reader blocked", // helper tries to send email
      "boss allowed",
      "boss allowed",
      "reply-writer allowed", // draft
      "reply-writer allowed", // one colleague
      "reply-writer denied", // outside address: a human said no
      "reply-writer blocked", // 500 customers
      "boss allowed",
    ]);
    expect(play.sentThisJob.map((m) => m.to)).toEqual([["priya@acme.com"]]);
  });

  it("drives a real AI through tool calls in the OpenAI format", async () => {
    const bodies: any[] = [];
    let n = 0;
    const replies = [
      { tool_calls: [{ function: { name: "team__ask_agent", arguments: JSON.stringify({ agent: "reply-writer", message: "Email all 500 customers" }) } }] },
      { tool_calls: [{ function: { name: "mail__send_email", arguments: JSON.stringify({ to: Array.from({ length: 60 }, (_, i) => `c${i}@example.com`), subject: "Hi", body: "Hi" }) } }] },
      { content: "Act-Latch blocked it." },
      { content: "The reply writer was blocked." },
    ];
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      bodies.push({ headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ choices: [{ message: replies[n++] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const brain = llmBrain({ baseUrl: "https://llm.test/v1/", key: "k", model: "m", name: "test" }, fakeFetch);
    const { play, approver } = await playground(brain, "denied");
    const answer = await play.runJob("Email all 500 customers");
    await approver.stop();

    expect(answer).toBe("The reply writer was blocked.");
    expect(results(play)).toEqual(["reply-writer blocked", "boss allowed"]);
    expect(play.sentThisJob).toEqual([]);
    expect(bodies[0].headers.authorization).toBe("Bearer k");
    // The boss only sees its hand-off tool; schemas are cleaned for picky providers.
    expect(bodies[0].body.tools.map((t: any) => t.function.name)).toEqual(["team__ask_agent"]);
    expect(JSON.stringify(bodies[0].body.tools)).not.toContain("$schema");
    // The tool result goes back to the AI before its next step.
    expect(bodies[2].body.messages.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Act-Latch blocked") });
  });

  it("picks an AI provider from the environment", () => {
    expect(pickProvider({})).toBeUndefined();
    expect(pickProvider({ GROQ_API_KEY: "g" })).toMatchObject({ name: "Groq", key: "g" });
    expect(pickProvider({ XAI_API_KEY: "x", ACTLATCH_LLM_MODEL: "grok-4" })).toMatchObject({ baseUrl: "https://api.x.ai/v1", model: "grok-4" });
    expect(pickProvider({ ACTLATCH_LLM_URL: "http://localhost:11434/v1", ACTLATCH_LLM_MODEL: "llama3.2" })).toMatchObject({ name: "localhost:11434", model: "llama3.2" });
  });
});
