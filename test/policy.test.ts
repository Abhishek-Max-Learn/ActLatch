import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { applyTaint, evaluate, globMatch } from "../src/policy.js";

const config = parseConfig({
  upstreams: { mail: { command: "x" } },
  policy: {
    internalDomains: ["acme.com"],
    rules: [
      { tool: "mail.read_*", decision: "allow" },
      { tool: "mail.send_email", if: { count: { arg: "to", gt: 50 } }, decision: "deny" },
      { tool: "mail.send_email", if: { count: { arg: "to", gt: 5 } }, decision: "approve" },
      { tool: "mail.send_email", if: { externalRecipients: { arg: "to" } }, decision: "approve", reason: "external" },
      { tool: "mail.send_email", if: { matches: { arg: "body", pattern: "password" } }, decision: "deny" },
      { tool: "mail.send_email", decision: "allow" },
    ],
    protectAfterUntrusted: ["mail.send_*"],
  },
});
const p = config.policy;
const emails = (n: number, domain = "acme.com") => Array.from({ length: n }, (_, i) => `u${i}@${domain}`);

describe("policy", () => {
  it("matches globs", () => {
    expect(globMatch("mail.*", "mail.send_email")).toBe(true);
    expect(globMatch("mail.read_*", "mail.send_email")).toBe(false);
    expect(globMatch("mail.send.email", "mail.sendXemail")).toBe(false);
  });

  it("denies tools no rule mentions (fail closed)", () => {
    expect(evaluate(p, "files.delete_all", {}).decision).toBe("deny");
    expect(evaluate(p, "mail.delete_inbox", {}).decision).toBe("deny");
  });

  it("decides on recipient count", () => {
    expect(evaluate(p, "mail.send_email", { to: emails(2), body: "hi" }).decision).toBe("allow");
    expect(evaluate(p, "mail.send_email", { to: emails(6), body: "hi" }).decision).toBe("approve");
    expect(evaluate(p, "mail.send_email", { to: emails(500), body: "hi" }).decision).toBe("deny");
  });

  it("counts comma-separated recipients too", () => {
    expect(evaluate(p, "mail.send_email", { to: emails(60).join(", ") }).decision).toBe("deny");
  });

  it("flags external recipients", () => {
    const v = evaluate(p, "mail.send_email", { to: ["a@acme.com", "b@gmail.com"], body: "hi" });
    expect(v).toMatchObject({ decision: "approve", reason: "external" });
  });

  it("matches argument patterns", () => {
    expect(evaluate(p, "mail.send_email", { to: ["a@acme.com"], body: "my PASSWORD is" }).decision).toBe("deny");
  });

  it("cannot be dodged by how the agent writes the recipients", () => {
    const send = (to: unknown) => evaluate(p, "mail.send_email", { to, body: "hi" }).decision;
    expect(send(emails(60).join("\n"))).toBe("deny");
    expect(send(emails(60).join(" "))).toBe("deny");
    expect(send([emails(30), emails(30, "acme.com")])).toBe("deny"); // nested lists
    expect(send({ a: emails(60) })).toBe("deny");
    expect(send("b@gmail.com a@acme.com")).toBe("approve"); // an outside address hidden before an inside one
    expect(send(["Ann <a@acme.com>, Bob <b@gmail.com>"])).toBe("approve");
    expect(send("Ann Smith <a@acme.com>")).toBe("allow");
  });

  it("cannot be dodged by wrapping a blocked word in a list or object", () => {
    expect(evaluate(p, "mail.send_email", { to: ["a@acme.com"], body: ["my password"] }).decision).toBe("deny");
    expect(evaluate(p, "mail.send_email", { to: ["a@acme.com"], body: { text: "password" } }).decision).toBe("deny");
    // An allow rule never gets looser: it only matches plain text.
    const allowOnly = parseConfig({
      upstreams: {},
      policy: { rules: [{ tool: "t.x", if: { matches: { arg: "q", pattern: "ok" } }, decision: "allow" }] },
    }).policy;
    expect(evaluate(allowOnly, "t.x", { q: "ok" }).decision).toBe("allow");
    expect(evaluate(allowOnly, "t.x", { q: ["ok"] }).decision).toBe("deny");
  });

  it("stays fast on huge hostile input", () => {
    const start = Date.now();
    evaluate(p, "mail.send_email", { to: "@".repeat(200_000) + " x", body: "hi" });
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("is frozen after load", () => {
    expect(() => (p.rules as unknown[]).push({ tool: "*", decision: "allow" })).toThrow();
    expect(() => Object.assign(p, { default: "allow" })).toThrow();
  });

  it("fails on unknown keys instead of ignoring them", () => {
    expect(() => parseConfig({ upstreams: {}, policy: { rules: [{ tool: "x", decision: "allow", typo: 1 }] } })).toThrow();
  });

  it("expands ${VAR} credentials from the gateway environment only", () => {
    const c = parseConfig(
      { upstreams: { mail: { command: "x", env: { KEY: "${MAIL_KEY}" } } }, policy: {} },
      "/",
      { MAIL_KEY: "s3cret" },
    );
    expect(c.upstreams.mail!.env.KEY).toBe("s3cret");
    expect(() => parseConfig({ upstreams: { m: { command: "x", env: { K: "${NOPE}" } } }, policy: {} }, "/", {})).toThrow(/NOPE/);
  });
});

describe("taint", () => {
  const allow = { decision: "allow" as const, reason: "ok" };

  it("does nothing in a clean session", () => {
    expect(applyTaint(p, "mail.send_email", allow, [])).toBe(allow);
  });

  it("escalates protected tools to approval after untrusted content", () => {
    expect(applyTaint(p, "mail.send_email", allow, ["mail"]).decision).toBe("approve");
  });

  it("leaves unprotected tools alone", () => {
    expect(applyTaint(p, "mail.read_inbox", allow, ["mail"]).decision).toBe("allow");
  });

  it("never loosens a deny", () => {
    const deny = { decision: "deny" as const, reason: "no" };
    expect(applyTaint(p, "mail.send_email", deny, ["mail"])).toBe(deny);
  });
});
