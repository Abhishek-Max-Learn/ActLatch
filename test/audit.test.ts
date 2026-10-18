import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, actionHash, verifyAudit } from "../src/audit.js";

const tmp = () => join(mkdtempSync(join(tmpdir(), "actlatch-test-")), "audit.jsonl");

describe("audit log", () => {
  it("writes a verifiable hash chain and continues it across restarts", () => {
    const path = tmp();
    const a = new AuditLog(path);
    a.write({ event: "call", tool: "mail.send_email" });
    a.write({ event: "blocked", tool: "mail.send_email", reason: "too many" });
    new AuditLog(path).write({ event: "call", tool: "mail.read_inbox" });
    expect(verifyAudit(path)).toEqual({ ok: true, entries: 3 });
  });

  it.skipIf(process.platform === "win32")("creates the log readable by its owner only", () => {
    const path = tmp();
    new AuditLog(path).write({ event: "call", tool: "mail.send_email", args: { to: "a@acme.com" } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("detects an edited entry", () => {
    const path = tmp();
    const a = new AuditLog(path);
    a.write({ event: "blocked", tool: "mail.send_email", reason: "too many" });
    a.write({ event: "call", tool: "mail.read_inbox" });
    writeFileSync(path, readFileSync(path, "utf8").replace('"blocked"', '"forwarded"'));
    expect(verifyAudit(path)).toMatchObject({ ok: false, line: 1 });
  });

  it("detects a deleted entry", () => {
    const path = tmp();
    const a = new AuditLog(path);
    for (let i = 0; i < 3; i++) a.write({ event: "call", tool: `t${i}` });
    const lines = readFileSync(path, "utf8").split("\n");
    lines.splice(1, 1);
    writeFileSync(path, lines.join("\n"));
    expect(verifyAudit(path)).toMatchObject({ ok: false, line: 2 });
  });

  it("hashes actions independent of key order but sensitive to values", () => {
    expect(actionHash("t", { a: 1, b: [1, 2] })).toBe(actionHash("t", { b: [1, 2], a: 1 }));
    expect(actionHash("t", { a: 1 })).not.toBe(actionHash("t", { a: 2 }));
  });
});
