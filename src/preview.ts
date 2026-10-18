import { emailDomain, externalAddresses, listValues, type Args } from "./policy.js";

export interface Preview {
  tool: string;
  summary: string[]; // plain-language "blast radius" lines
  args: Args;
}

const RECIPIENT_ARGS = ["to", "cc", "bcc", "recipients"];

/** Build a human-readable preview of what a tool call would do. */
export function buildPreview(tool: string, args: Args, internalDomains: readonly string[]): Preview {
  const summary: string[] = [];
  const recipients = RECIPIENT_ARGS.flatMap((k) => listValues(args[k]));
  if (recipients.length > 0) {
    const external = externalAddresses(recipients, internalDomains);
    const domains = new Set(external.map((a) => emailDomain(a) ?? "unknown"));
    summary.push(`Goes to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`);
    if (internalDomains.length > 0) {
      summary.push(
        external.length === 0
          ? "All recipients are internal."
          : `${external.length} outside your organisation (${[...domains].slice(0, 5).join(", ")}${domains.size > 5 ? ", ..." : ""}).`,
      );
    }
  }
  for (const [k, v] of Object.entries(args)) {
    if (RECIPIENT_ARGS.includes(k)) continue;
    if (typeof v === "string") {
      const short = v.length > 120 ? v.slice(0, 117) + "..." : v;
      summary.push(`${k}: ${JSON.stringify(short)}`);
    } else if (typeof v === "number" || typeof v === "boolean") {
      summary.push(`${k}: ${v}`);
    } else if (Array.isArray(v)) {
      summary.push(`${k}: ${v.length} item(s)`);
    }
  }
  if (/send|delete|remove|transfer|pay|publish|post/i.test(tool)) {
    summary.push("This action is likely not reversible once it runs.");
  }
  return { tool, summary, args };
}
