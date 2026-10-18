import { emailDomain, externalAddresses, listValues, type Args } from "./policy.js";

export interface Preview {
  tool: string;
  summary: string[]; // plain-language "blast radius" lines
  args: Args;
  /** One plain sentence for the approval card, e.g. "support-bot wants to refund order". */
  headline?: string;
  /** What the agent filled in, with readable labels. */
  details?: Line[];
  /** Real values Act-Latch looked up itself, to compare against what the agent says. */
  facts?: Line[];
  /** What kind of action this is, e.g. "Changes existing data". */
  effect?: string;
}

export interface Line {
  label: string;
  value: string;
}

/** "refund_order" / "refundOrder" -> "refund order". */
export function humanize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
}

const label = (name: string) => {
  const h = humanize(name);
  return h.charAt(0).toUpperCase() + h.slice(1);
};

function show(v: unknown): string | undefined {
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 297) + "..." : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
    const shown = items.slice(0, 5).join(", ");
    return `${v.length} item${v.length === 1 ? "" : "s"}${v.length ? `: ${shown}${v.length > 5 ? ", ..." : ""}` : ""}`;
  }
  if (v && typeof v === "object") {
    const text = JSON.stringify(v);
    return text.length > 300 ? text.slice(0, 297) + "..." : text;
  }
  return undefined;
}

/** Readable lines for the agent's arguments. */
export function detailLines(args: Args): Line[] {
  return Object.entries(args).flatMap(([k, v]) => {
    const value = show(v);
    return value === undefined ? [] : [{ label: label(k), value }];
  });
}

/** Readable lines for looked-up facts: { order: { price: 140 } } -> "Order price: 140". */
export function factLines(facts: Record<string, unknown>): Line[] {
  return Object.entries(facts).flatMap(([name, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.entries(value).flatMap(([k, v]) => {
        const text = show(v);
        const key = humanize(k).startsWith(humanize(name)) ? k : `${name} ${k}`; // "order_id", not "order order id"
        return text === undefined ? [] : [{ label: label(key), value: text }];
      });
    }
    const text = show(value);
    return text === undefined ? [] : [{ label: label(name), value: text }];
  });
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
  return { tool, summary, args, details: detailLines(args) };
}
