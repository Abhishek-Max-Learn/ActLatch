#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { parse, stringify } from "yaml";
import { readAuditEntries, renderActivity, summarizeAudit } from "./activity.js";
import { WebApprover } from "./approval.js";
import { AuditLog, verifyAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { Gateway, connectUpstreams, discoverToolDetails } from "./gateway.js";
import { renderRegistry } from "./registry.js";
import { readAudit, renderReview, reviewRegistry } from "./review.js";
import { pickDrafter, runSetup } from "./setup.js";

const USAGE = `usage:
  actlatch start [--config actlatch.yaml] [--agent <name>]
                                            run the gateway as an MCP server on stdio for one agent
                                            (the agent's key, if it has one, comes from ACTLATCH_AGENT_KEY)
  actlatch registry [--config actlatch.yaml]
                                            show every agent, the tools it can use and what each allows
  actlatch review [--config actlatch.yaml] [--audit actlatch-audit.jsonl]
                                            point out risky setups: too much power, dangerous tool combinations,
                                            agents that can get another agent to do what they cannot
  actlatch setup --config servers.yaml [--out actlatch.yaml] [--no-ai]
                                            answer questions about your agents and tools; writes the registry
                                            (uses Claude to tailor questions when an Anthropic key is set)
  actlatch log [--config actlatch.yaml] [--file actlatch-audit.jsonl]
                                            every call agents made, in plain words: allowed, blocked, approved,
                                            denied or timed out, and why; also checks nobody edited the log
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
    approver.activity = () => summarizeAudit(readAuditEntries(config.audit.path));
    await approver.start();
    const identity = { agent: flag(rest, "--agent") ?? process.env.ACTLATCH_AGENT, key: process.env.ACTLATCH_AGENT_KEY };
    const gateway = new Gateway(config, await connectUpstreams(config), approver, new AuditLog(config.audit.path), identity);
    await gateway.createServer().connect(new StdioServerTransport());
    if (gateway.identityError) process.stderr.write(`[actlatch] WARNING: ${gateway.identityError}; every call will be blocked\n`);
    const who = gateway.agent && !gateway.identityError ? ` for agent "${gateway.agent}"` : "";
    process.stderr.write(`[actlatch] gateway ready${who}; audit log at ${config.audit.path}\n`);
    return -1; // keep running
  }
  if (cmd === "registry" || cmd === "review") {
    const config = loadConfig(flag(rest, "--config") ?? "actlatch.yaml");
    const details = await discoverToolDetails(config);
    const names = new Map([...details].map(([s, t]) => [s, t instanceof Error ? t : t.map((x) => x.name)] as const));
    if (cmd === "registry") console.log(renderRegistry(config, names) + "\n");
    const auditPath = flag(rest, "--audit");
    console.log(renderReview(reviewRegistry({ config, tools: details, audit: auditPath ? readAudit(auditPath) : undefined })));
    return 0;
  }
  if (cmd === "setup") {
    const path = flag(rest, "--config") ?? "actlatch.yaml";
    // Paths inside the config are relative to its folder, so by default save next to it.
    const out = flag(rest, "--out") ?? join(dirname(path), "actlatch.yaml");
    const raw = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const tools = await discoverToolDetails(loadConfig(path));
    const rl = createInterface({ input: process.stdin });
    // Queue lines so typed and piped answers both work.
    const lines: string[] = [];
    const waiting: ((l: string) => void)[] = [];
    rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
    rl.on("close", () => waiting.splice(0).forEach((w) => w("")));
    let closed = false;
    rl.on("close", () => (closed = true));
    const ask = (q: string) => {
      process.stdout.write(q + " ");
      if (lines.length) return Promise.resolve(lines.shift()!);
      if (closed) throw new Error("input ended before setup finished");
      return new Promise<string>((r) => waiting.push(r));
    };
    const env = rest.includes("--no-ai") ? { ...process.env, ACTLATCH_LLM: "off" } : process.env;
    const { drafter: draft, label } = pickDrafter(env, () => new Anthropic(), (m) =>
      console.log(`(AI help unavailable: ${m}. Using basic questions.)`),
    );
    console.log(`Questions: ${label}.`);
    try {
      const result = await runSetup({ raw, tools, ask: async (q) => ask(q), say: (l) => console.log(l), draft });
      if (!result) {
        console.log("Nothing saved.");
        return 1;
      }
      writeFileSync(out, stringify(result));
      console.log(`Saved to ${out}. See it any time with: actlatch registry --config ${out}`);
      return 0;
    } finally {
      rl.close();
    }
  }
  if (cmd === "log") {
    const path = flag(rest, "--file") ?? loadConfig(flag(rest, "--config") ?? "actlatch.yaml").audit.path;
    if (!existsSync(path)) {
      console.log(`No audit log at ${path} yet. It is created on the first call.`);
      return 0;
    }
    console.log(renderActivity(summarizeAudit(readAuditEntries(path))));
    const v = verifyAudit(path);
    console.log(v.ok ? `Log: ${path} (${v.entries} entries, nobody has edited it)` : `WARNING: the log was changed at line ${v.line}: ${v.problem}`);
    return v.ok ? 0 : 1;
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
