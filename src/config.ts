import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export const Decision = z.enum(["allow", "deny", "approve"]);
export type Decision = z.infer<typeof Decision>;

const Condition = z
  .object({
    // Number of items in an argument (array length, or comma-separated string).
    count: z.object({ arg: z.string(), gt: z.number().optional(), lte: z.number().optional() }).optional(),
    // True when any email address in the argument is outside the listed domains.
    externalRecipients: z.object({ arg: z.string(), internalDomains: z.array(z.string()).optional() }).optional(),
    // Regex match against a string argument.
    matches: z.object({ arg: z.string(), pattern: z.string() }).optional(),
    // Numeric limit on an argument, e.g. a refund amount. Missing or non-numeric counts as over any limit.
    number: z.object({ arg: z.string(), gt: z.number().optional(), lte: z.number().optional() }).optional(),
  })
  .strict();
export type Condition = z.infer<typeof Condition>;

const Rule = z
  .object({
    tool: z.string(), // "server.tool", "*" globs allowed, e.g. "mail.*"
    if: Condition.optional(),
    decision: Decision,
    reason: z.string().optional(),
  })
  .strict();
export type Rule = z.infer<typeof Rule>;

const Upstream = z
  .object({
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    // Outputs from an untrusted server are treated as possibly attacker-controlled.
    trust: z.enum(["trusted", "untrusted"]).default("untrusted"),
  })
  .strict();
export type Upstream = z.infer<typeof Upstream>;

// One registered agent: who it is and which tools it may use, with what limits.
const Agent = z
  .object({
    description: z.string().optional(),
    // Optional shared secret. If set, the gateway must be started with ACTLATCH_AGENT_KEY equal to it,
    // so another program cannot simply claim to be this agent.
    key: z.string().optional(),
    // Same shape as policy rules; first match wins; anything not listed is denied.
    tools: z.array(Rule).default([]),
  })
  .strict();
export type Agent = z.infer<typeof Agent>;

export const ConfigSchema = z
  .object({
    upstreams: z.record(z.string().regex(/^[a-zA-Z0-9-]+$/), Upstream),
    policy: z
      .object({
        default: Decision.default("deny"),
        internalDomains: z.array(z.string()).default([]),
        rules: z.array(Rule).default([]),
        // Tools that must be approved once the session has seen untrusted content.
        protectAfterUntrusted: z.array(z.string()).default([]),
      })
      .strict()
      .default({ default: "deny", internalDomains: [], rules: [], protectAfterUntrusted: [] }),
    // Agent registry. When present, every caller must be a registered agent and
    // gets only the tools in its entry; policy.rules then act as extra guardrails.
    agents: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), Agent).optional(),
    approval: z
      .object({
        host: z.string().default("127.0.0.1"),
        port: z.number().int().default(4848),
        timeoutSeconds: z.number().positive().default(300),
      })
      .strict()
      .default({ host: "127.0.0.1", port: 4848, timeoutSeconds: 300 }),
    audit: z
      .object({ path: z.string().default("actlatch-audit.jsonl") })
      .strict()
      .default({ path: "actlatch-audit.jsonl" }),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export type PolicyConfig = Config["policy"];

/** Replace ${VAR} with values from the gateway's own environment. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`Config references \${${name}} but it is not set`);
    return v;
  });
}

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

/**
 * Parse and validate a config. The result is deeply frozen: policy is fixed at
 * startup and nothing an agent or a tool output says can change it later.
 */
export function parseConfig(raw: unknown, baseDir = process.cwd(), env = process.env): Config {
  const cfg = ConfigSchema.parse(raw);
  for (const up of Object.values(cfg.upstreams)) {
    for (const [k, v] of Object.entries(up.env)) up.env[k] = expandEnv(v, env);
    if (up.cwd) up.cwd = resolve(baseDir, up.cwd);
  }
  for (const agent of Object.values(cfg.agents ?? {})) {
    if (agent.key !== undefined) agent.key = expandEnv(agent.key, env);
  }
  cfg.audit.path = resolve(baseDir, cfg.audit.path);
  return deepFreeze(cfg);
}

export function loadConfig(path: string, env = process.env): Config {
  const abs = resolve(path);
  return parseConfig(parse(readFileSync(abs, "utf8")), dirname(abs), env);
}
