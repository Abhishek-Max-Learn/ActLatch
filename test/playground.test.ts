import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WebApprover } from "../src/approval.js";
import { AuditLog } from "../src/audit.js";
import { loadConfig } from "../src/config.js";
import { claudeBrain, llmBrain, pickBrain, pickProvider, pretendBrain, type Brain } from "../examples/playground/brain.js";
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

  it("switches to an available model when the provider has retired the chosen one", async () => {
    const asked: string[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "whisper-large-v3" }, { id: "openai/gpt-oss-120b" }] }));
      const model = JSON.parse(String(init!.body)).model;
      asked.push(model);
      if (model === "old-model") return new Response('{"error":{"code":"model_not_found"}}', { status: 404 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
    }) as unknown as typeof fetch;
    const brain = llmBrain({ baseUrl: "https://llm.test/v1", key: "k", model: "old-model", name: "Groq" }, fakeFetch);
    const step = await brain.next({ agent: "summarizer", system: "s", task: "t", tools: [], history: [] });
    expect(step).toEqual({ answer: "hello" });
    expect(asked).toEqual(["old-model", "openai/gpt-oss-120b"]);
    expect(brain.label).toBe("real AI: Groq (openai/gpt-oss-120b)");
  });

  it("drives Claude through the Anthropic SDK, sending thinking and tool results back unchanged", async () => {
    const requests: any[] = [];
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const replies = [
      [thinking, { type: "tool_use", id: "t1", name: "team__ask_agent", input: { agent: "reply-writer", message: "Email all 500 customers" } }],
      [thinking, { type: "tool_use", id: "t2", name: "mail__send_email", input: { to: Array.from({ length: 60 }, (_, i) => `c${i}@example.com`), subject: "Hi", body: "Hi" } }],
      [{ type: "text", text: "Blocked by Act-Latch." }],
      [{ type: "text", text: "The reply writer was blocked." }],
    ];
    let n = 0;
    const fake = {
      beta: {
        messages: {
          create: async (req: any) => {
            requests.push(structuredClone(req));
            const content = replies[n++]!;
            return { content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
          },
        },
      },
    } as any;
    const { play, approver } = await playground(claudeBrain(fake, "claude-opus-5-5"), "denied");
    const answer = await play.runJob("Email all 500 customers");
    await approver.stop();

    expect(answer).toBe("The reply writer was blocked.");
    expect(results(play)).toEqual(["reply-writer blocked", "boss allowed"]);
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(requests[0].tools.map((t: any) => t.name)).toEqual(["team__ask_agent"]);
    // reply-writer's second request: its own thinking + tool call echoed, then the blocked result.
    const [, assistant, result] = requests[2].messages;
    expect(assistant.content[0]).toEqual(thinking);
    expect(result.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
    expect(play.sentThisJob).toEqual([]);
  });

  it("picks Claude when a Claude key is set", () => {
    expect(pickBrain({ ANTHROPIC_API_KEY: "sk-test" }).label).toBe("real AI: Claude (claude-opus-5-5)");
    expect(pickBrain({}).label).toMatch(/pretend/);
  });

  it("picks an AI provider from the environment", () => {
    expect(pickProvider({})).toBeUndefined();
    expect(pickProvider({ GROQ_API_KEY: "g" })).toMatchObject({ name: "Groq", key: "g" });
    expect(pickProvider({ XAI_API_KEY: "x", ACTLATCH_LLM_MODEL: "grok-4" })).toMatchObject({ baseUrl: "https://api.x.ai/v1", model: "grok-4" });
    expect(pickProvider({ ACTLATCH_LLM_URL: "http://localhost:11434/v1", ACTLATCH_LLM_MODEL: "llama3.2" })).toMatchObject({ name: "localhost:11434", model: "llama3.2" });
  });
});
