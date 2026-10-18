import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditEntries, renderActivity, summarizeAudit } from "../src/activity.js";
import { AuditLog } from "../src/audit.js";

function log() {
  const path = join(mkdtempSync(join(tmpdir(), "actlatch-test-")), "audit.jsonl");
  return { path, audit: new AuditLog(path) };
}

describe("activity from the audit log", () => {
  it("turns every call into one plain line with its outcome", () => {
    const { path, audit } = log();
    const call = (h: string, tool: string) => audit.write({ event: "call", tool, actionHash: h, agent: "support-bot", args: { amount: 1 } });
    call("a", "helpdesk.list_tickets");
    audit.write({ event: "decision", tool: "helpdesk.list_tickets", actionHash: "a", decision: "allow", reason: "matched rule #1" });
    audit.write({ event: "forwarded", tool: "helpdesk.list_tickets", actionHash: "a", isError: false });
    call("b", "helpdesk.delete_customer");
    audit.write({ event: "blocked", tool: "helpdesk.delete_customer", actionHash: "b", reason: "not in its tool list" });
    for (const [h, outcome] of [["c", "approved"], ["d", "denied"], ["e", "timeout"]] as const) {
      call(h, "helpdesk.refund_order");
      audit.write({ event: "decision", tool: "helpdesk.refund_order", actionHash: h, decision: "approve", reason: "Refunds over $50 need a human." });
      audit.write({ event: "approval", tool: "helpdesk.refund_order", actionHash: h, outcome });
      if (outcome === "approved") audit.write({ event: "forwarded", tool: "helpdesk.refund_order", actionHash: h, isError: false });
      else audit.write({ event: "blocked", tool: "helpdesk.refund_order", actionHash: h, reason: "a human denied this action" });
    }
    call("f", "helpdesk.refund_order"); // still waiting

    const rows = summarizeAudit(readAuditEntries(path));
    expect(rows.map((r) => [r.action, r.result, r.reason])).toEqual([
      ["list tickets (helpdesk)", "allowed", "matched rule #1"],
      ["delete customer (helpdesk)", "blocked", "not in its tool list"],
      ["refund order (helpdesk)", "approved", "Refunds over $50 need a human."],
      ["refund order (helpdesk)", "denied", "Refunds over $50 need a human."],
      ["refund order (helpdesk)", "timed out", "Refunds over $50 need a human."],
      ["refund order (helpdesk)", "waiting", undefined],
    ]);
    const text = renderActivity(rows);
    expect(text).toContain("Blocked (no answer in time)");
    expect(text).toContain("within its rules");
    expect(text).toContain("6 calls: 1 allowed, 1 approved, 1 blocked, 1 denied, 1 timed out, 1 waiting.");
  });

  it("is friendly when nothing happened yet", () => {
    expect(renderActivity(summarizeAudit(readAuditEntries("/nope/missing.jsonl")))).toBe("No calls recorded yet.");
  });
});
