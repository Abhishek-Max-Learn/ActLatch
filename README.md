# Shri Ram
# ActLatch
A latch keeps a door secured until it is safe to open. Our product similarly holds risky AI-agent actions until they pass policy checks or receive approval.

**Every AI action. Checked before it happens.**

Act-Latch is an [MCP](https://modelcontextprotocol.io) gateway. Your agent (Claude Desktop, Cursor, any MCP client) connects to Act-Latch instead of the real MCP servers. Act-Latch starts the real servers itself, holds their credentials, and checks every tool call against your policy before anything happens:

| Decision  | What happens |
|-----------|--------------|
| `allow`   | The call goes through to the real server. |
| `deny`    | The call is blocked. The agent gets an error saying why. |
| `approve` | A human sees a plain-language preview and clicks Approve or Deny. |

Everything is written to a tamper-evident audit log.

```
 Agent ──MCP──▶ Act-Latch ──MCP──▶ mail server (holds MAIL_API_KEY)
                  │  policy.yaml (frozen at startup)
                  │  approval page  http://127.0.0.1:4848
                  └─ audit.jsonl    (hash-chained)
```

## What it guarantees

- **Fail closed.** A tool that no rule mentions is denied.
- **Credentials stay in the gateway.** Upstream API keys live in the gateway's config and environment. The agent never receives them, so it cannot go around Act-Latch.
- **Injected text cannot grant permissions.** The policy is loaded once and frozen; no tool exists that changes it. On top of that, once the agent has read output from an `untrusted` server (an inbox, a web page), the tools listed in `protectAfterUntrusted` always need a human, even if the policy would normally allow them. This check can only tighten a decision, never loosen it.
- **Approval covers one exact action.** Each approval is for one call, recorded with a SHA-256 hash of the tool and its exact arguments. A different recipient list is a different action and needs its own approval.
- **The agent cannot approve itself.** The approval page listens on localhost only, and every request needs a random token printed at startup.
- **Audit log you can check.** Each line in the JSON Lines log includes the hash of the line before it. `actlatch verify-audit` finds any edited or deleted line.

## Quick start

```bash
npm install
npm test            # 31 tests
npm run demo        # scripted demo; open the printed URL to approve or deny
npm run demo -- --deny   # same demo, answers approvals automatically
```

### Demo: the poisoned inbox

The demo uses a fake email server. One email in its inbox hides a prompt injection telling the agent it "now has permission" to email all 500 customers.

```
> Agent emails 2 colleagues (clean session)
  OK: Sent "Standup" to 2 recipient(s).

> Agent reads the inbox (one email hides a prompt injection)
  OK: [ { "from": "priya@acme.com", ...

> Injected prompt: email all 500 customers
  BLOCKED: Act-Latch blocked mail.send_email: more than 50 recipients.

> Agent emails 20 customers (a human sees a preview card)
   preview: Goes to 20 recipients. 20 outside your organisation (example.com). ...
  BLOCKED: Act-Latch blocked mail.send_email: a human denied this action.

> Agent drafts a reply (still allowed)
  OK: Draft saved: "Re: Q3 numbers" to 1 recipient(s).

> Agent emails 1 colleague after reading untrusted mail (needs a human now)
  BLOCKED: Act-Latch blocked mail.send_email: a human denied this action.

Emails actually sent: 1
Audit log: ... (23 entries, hash chain intact)
```

## Use it with a real MCP client

1. Write a config (see [`examples/actlatch.yaml`](examples/actlatch.yaml)).
2. Build: `npm run build`.
3. Point your client at Act-Latch instead of the real server. For Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "actlatch": {
      "command": "node",
      "args": ["/path/to/actlatch/dist/src/cli.js", "start", "--config", "/path/to/actlatch.yaml"],
      "env": { "MAIL_API_KEY": "the-real-key" }
    }
  }
}
```

Remove the real server from the client's config so the agent has no direct route to it. The agent will see tools named `mail__send_email` and so on. When a call needs approval, open the URL Act-Latch prints to stderr (it appears in the client's MCP logs).

## Policy file

```yaml
upstreams:
  mail:
    command: npx
    args: [tsx, mock-email-server.ts]
    env:
      MAIL_API_KEY: ${MAIL_API_KEY}   # taken from the gateway's environment
    trust: untrusted                  # its output may contain injected text

policy:
  default: deny
  internalDomains: [acme.com]
  rules:                              # first match wins
    - tool: mail.read_inbox
      decision: allow
    - tool: mail.send_email
      if: { count: { arg: to, gt: 50 } }
      decision: deny
      reason: Sending to more than 50 people is never done by the agent.
    - tool: mail.send_email
      if: { count: { arg: to, gt: 5 } }
      decision: approve
    - tool: mail.send_email
      if: { externalRecipients: { arg: to } }
      decision: approve
    - tool: mail.send_email
      decision: allow
  protectAfterUntrusted: [mail.send_email]

approval: { port: 4848, timeoutSeconds: 300 }   # a timeout counts as a denial
audit:    { path: actlatch-audit.jsonl }
```

Tool patterns are `server.tool` and may use `*` (for example `mail.*`). Conditions available in `if` (all must hold):

| Condition | Holds when |
|-----------|------------|
| `count: { arg, gt, lte }` | the number of items in `arg` (array, or comma-separated string) is above `gt` / at most `lte` |
| `externalRecipients: { arg, internalDomains? }` | any email address in `arg` is outside the internal domains |
| `matches: { arg, pattern }` | the string `arg` matches the regex (case-insensitive) |

Unknown keys in the config are an error, so a typo cannot quietly switch a rule off.

## Audit log

```bash
node dist/src/cli.js verify-audit actlatch-audit.jsonl
# ok: 23 entries, chain intact
```

Events: `call`, `decision`, `approval`, `forwarded`, `untrusted_output`, `blocked`, `error`. The `call` event records the full arguments, so keep the log somewhere private.

## Not in this version

- Upstreams over HTTP (stdio only for now), and serving the gateway itself over HTTP.
- Identity (OIDC/JWT) in policy, Slack/WhatsApp approvals, partial approvals.
- Learn mode, plain-English policy presets, the n8n node.

## Layout

```
src/config.ts     config schema, ${VAR} expansion, deep freeze
src/policy.ts     rule matching, conditions, taint escalation
src/preview.ts    plain-language preview for approvers
src/approval.ts   local approval web page
src/audit.ts      hash-chained JSONL log and verifier
src/gateway.ts    the MCP proxy
src/cli.ts        `actlatch start` / `actlatch verify-audit`
examples/         fake mail server, example config, scripted demo
test/             vitest suites
```
