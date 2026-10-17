import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return "{" + entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v)).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Hash of the exact action. Approvals are bound to this, so changing any argument voids them. */
export function actionHash(tool: string, args: unknown): string {
  return sha256(canonicalJson({ tool, args }));
}

export interface AuditEvent {
  event: "call" | "decision" | "approval" | "forwarded" | "blocked" | "error" | "untrusted_output" | "lookup";
  tool?: string;
  actionHash?: string;
  [k: string]: unknown;
}

export interface AuditEntry extends AuditEvent {
  seq: number;
  ts: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

/**
 * Append-only JSON Lines log. Each entry carries the hash of the previous one,
 * so editing or deleting a line breaks the chain and `verifyAudit` reports it.
 */
export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;

  constructor(private readonly path: string, private readonly now = () => new Date()) {
    if (existsSync(path)) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) {
        const entry = JSON.parse(last) as AuditEntry;
        this.seq = entry.seq;
        this.prevHash = entry.hash;
      }
    }
  }

  write(ev: AuditEvent): AuditEntry {
    const body = { ...ev, seq: this.seq + 1, ts: this.now().toISOString(), prevHash: this.prevHash };
    const entry: AuditEntry = { ...body, hash: sha256(canonicalJson(body)) };
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    this.seq = entry.seq;
    this.prevHash = entry.hash;
    return entry;
  }
}

export function verifyAudit(path: string): { ok: true; entries: number } | { ok: false; line: number; problem: string } {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  let prev = GENESIS;
  for (let i = 0; i < lines.length; i++) {
    let entry: AuditEntry;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      return { ok: false, line: i + 1, problem: "not valid JSON" };
    }
    const { hash, ...body } = entry;
    if (body.prevHash !== prev) return { ok: false, line: i + 1, problem: "prevHash does not match previous entry" };
    if (sha256(canonicalJson(body)) !== hash) return { ok: false, line: i + 1, problem: "entry was modified" };
    if (body.seq !== i + 1) return { ok: false, line: i + 1, problem: "sequence gap" };
    prev = hash;
  }
  return { ok: true, entries: lines.length };
}
