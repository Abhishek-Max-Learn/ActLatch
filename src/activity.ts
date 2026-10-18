import { existsSync, readFileSync } from "node:fs";
import type { AuditEntry } from "./audit.js";
import { humanize } from "./preview.js";

export type Result = "allowed" | "approved" | "blocked" | "denied" | "timed out" | "failed" | "waiting";

/** One agent call, in plain words, as the audit log recorded it. */
export interface Activity {
  time: string;
  agent?: string;
  tool: string;
  /** e.g. "refund order (helpdesk)" */
  action: string;
  result: Result;
  reason?: string;
  args?: unknown;
}

const WORDS: Record<Result, string> = {
  allowed: "Allowed",
  approved: "Approved by a person",
  blocked: "Blocked",
  denied: "Denied by a person",
  "timed out": "Blocked (no answer in time)",
  failed: "Allowed, but the tool failed",
  waiting: "Waiting for a person",
};

export function resultWords(r: Result): string {
  return WORDS[r];
}

export function readAuditEntries(path: string): AuditEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditEntry);
}

function action(tool: string): string {
  const dot = tool.indexOf(".");
  return dot > 0 ? `${humanize(tool.slice(dot + 1))} (${tool.slice(0, dot)})` : humanize(tool);
}

/** Fold the log's low-level events into one line per call, oldest first. */
export function summarizeAudit(entries: readonly AuditEntry[]): Activity[] {
  const rows: Activity[] = [];
  const open = new Map<string, Activity>(); // latest unfinished call per action hash
  for (const e of entries) {
    const key = e.actionHash ?? "";
    if (e.event === "call") {
      const row: Activity = { time: e.ts, agent: e.agent as string | undefined, tool: e.tool ?? "?", action: action(e.tool ?? "?"), result: "waiting", args: e.args };
      rows.push(row);
      open.set(key, row);
      continue;
    }
    const row = open.get(key);
    if (!row) continue;
    if (e.event === "decision") row.reason = e.reason as string | undefined;
    else if (e.event === "approval") row.result = e.outcome === "approved" ? "approved" : e.outcome === "timeout" ? "timed out" : "denied";
    else if (e.event === "blocked") {
      if (row.result === "waiting") row.result = "blocked";
      if (row.result === "blocked") row.reason = e.reason as string | undefined;
      open.delete(key);
    } else if (e.event === "forwarded") {
      if (row.result === "waiting") row.result = e.isError ? "failed" : "allowed";
      open.delete(key);
    } else if (e.event === "error") {
      row.result = "failed";
      row.reason = e.message as string | undefined;
      open.delete(key);
    }
  }
  return rows;
}

/** A plain text table for the terminal. */
export function renderActivity(rows: readonly Activity[]): string {
  if (rows.length === 0) return "No calls recorded yet.";
  const local = (iso: string) => new Date(iso).toLocaleString();
  const head = ["WHEN", "AGENT", "WANTED TO", "RESULT", "WHY"];
  const why = (r: Activity) => (r.result === "allowed" ? "within its rules" : (r.reason ?? ""));
  const body = rows.map((r) => [local(r.time), r.agent ?? "-", r.action, resultWords(r.result), why(r)]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => Math.min(b[i]!.length, 40))));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.slice(0, 40).padEnd(w[i]!))).join("  ").trimEnd();
  const counts = (["allowed", "approved", "blocked", "denied", "timed out", "failed", "waiting"] as Result[])
    .map((r) => [r, rows.filter((x) => x.result === r).length] as const)
    .filter(([, n]) => n > 0)
    .map(([r, n]) => `${n} ${r}`)
    .join(", ");
  return [line(head), ...body.map(line), "", `${rows.length} calls: ${counts}.`].join("\n");
}
