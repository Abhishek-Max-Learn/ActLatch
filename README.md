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
- **Audit log you can check.** Each line in the JSON Lines log includes the hash of the line before it. `actlatch verify-audit` finds any edited or deleted line. `npm run log` (or `actlatch log --config your.yaml`) lists every call in plain words: who asked, what for, and whether it was allowed, blocked, approved, denied or timed out, and why.

## Quick start

### In GitHub Codespaces (nothing to install)

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/Abhishek-Max-Learn/ActLatch)

1. Click the badge (or **Code → Codespaces → Create codespace on main**). Dependencies install automatically.
2. In the terminal run `npm test`, then `npm run demo` (email example) or `npm run demo:agents` and `npm run registry` (agent registry, helpdesk example). Then `npm run log` shows every call the demos made.
3. When the demo prints `approval needed ... https://<codespace>-4848.app.github.dev/?token=...`, the approval page opens in your browser by itself (or open that link). The request pops up as a card in plain words: who wants to do what, why you are asked, the real values Act-Latch checked, and a countdown. Click **Approve once** or **Deny** within 2 minutes (no answer counts as Deny). Keep the tab open: later requests pop up in it, with a sound and, if you allow it, a desktop alert. Open the whole link, including the `?token=...` part: the page refuses links without it, and each run prints a new one. Port 4848 stays private to your GitHub account.

### On your own machine

```bash
npm install
npm test            # 77 tests
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

## Agent registry: who can use which tool, and how

Act-Latch is not tied to email. Any MCP server works. The registry lists every agent that may use the gateway, which tools each one can use, and what each tool lets it do. Anything not listed is blocked, and an agent that is not listed gets nothing.

```yaml
agents:
  support-bot:
    description: Answers customer tickets
    # key: ${SUPPORT_BOT_KEY}   # optional; then ACTLATCH_AGENT_KEY must match
    tools:                      # first match wins
      - tool: helpdesk.list_tickets
        decision: allow
      - tool: helpdesk.refund_order
        if: { number: { arg: amount, gt: 500 } }
        decision: deny
      - tool: helpdesk.refund_order
        if: { number: { arg: amount, gt: 50 } }
        decision: approve
      - tool: helpdesk.refund_order
        decision: allow
  report-bot:
    tools:
      - tool: helpdesk.list_tickets
        decision: allow
```

- **Identity.** Each agent's MCP client starts its own gateway with `actlatch start --agent support-bot` (or `ACTLATCH_AGENT=support-bot`). The name is fixed when the gateway starts, so nothing the model says can change it. If the agent has a `key`, the gateway also needs `ACTLATCH_AGENT_KEY` set to it.
- **Each agent only sees its own tools.** Tools it cannot use are hidden from its tool list and blocked if it calls them anyway.
- **Tools are discovered automatically** from every connected server, so you write rules against the tools servers actually offer.
- **`policy.rules` still apply** to everyone as extra guardrails. With agents registered they can only make a decision stricter.

See it all as one table:

```
$ npm run registry      # or: actlatch registry --config your.yaml

AGENT support-bot - Answers customer tickets
  TOOL                   WHAT IT MAY DO
  helpdesk.list_tickets  allowed
  helpdesk.get_order     allowed
  helpdesk.reply_ticket  allowed; also checked by rules for everyone
  helpdesk.refund_order  blocked if "amount" is more than 500; needs approval if "amount" is more than order.price + 5; needs approval if "amount" is more than 50; otherwise allowed; checks real order via helpdesk.get_order
  ...and 1 other tool(s): blocked

AGENT report-bot - Writes a weekly summary; read-only
  TOOL                   WHAT IT MAY DO
  helpdesk.list_tickets  allowed
  ...and 4 other tool(s): blocked

Anyone not registered above: blocked from every tool.
Tools no agent can use: helpdesk.delete_customer
```

### Guided setup: answer questions instead of writing rules

Whoever built the agents knows best what each one should do. `actlatch setup` connects to your servers, finds their tools, and asks plain questions for each agent and tool ("Should support-bot use refund_order? yes / ask / no", "Above what amount should a human approve first?"). The answers become the `agents:` section, and the registry table is shown for a final yes before anything is saved.

```bash
npm run setup     # example: examples/servers.yaml -> examples/my-actlatch.yaml
# or: actlatch setup --config servers.yaml [--out actlatch.yaml] [--no-ai]
```

- **Uses the LLM your app already has.** With `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` already in the environment (or `ACTLATCH_LLM_URL` / `_KEY` / `_MODEL` for any OpenAI-compatible API such as Azure, Gemini, Groq or a local Ollama), the LLM reads each tool's name, description and fields and writes questions that fit that tool, with suggested answers. With no key, fixed questions based on the tool's fields are used.
- **The LLM only drafts questions.** It never decides anything: questions about fields that don't exist are dropped, every answer comes from the person, and the result is a fixed file. While agents run, no LLM is involved in decisions.
- **Admin only.** Setup is a command run on the machine that holds the gateway's config, by whoever manages it. Agents connect over MCP and only ever see the gateway's tools, so they have no way to run setup or change the result, and the config is frozen once the gateway starts.

### Tool types, agent-to-agent messages and the security review

**Tool types.** Every tool is shown as `read`, `write`, `update` or `delete`, guessed from its name and the hints MCP servers publish. Setup suggests "on its own" for reads and "ask first" for everything else. Correct a guess, or mark what Act-Latch cannot see, in `toolInfo`:

```yaml
toolInfo:
  db.run_report:    { access: read, sensitive: true }   # returns private data
  crm.notify:       { external: true }                  # sends things outside
  crew.handover:    { agentCall: { arg: to } }          # passes work to the agent named in "to"
```

**Agent-to-agent messages.** A tool that passes work to another agent (guessed from names like `ask_agent` or `delegate`, or set with `agentCall`) needs a human's approval for each message by default, so one agent cannot quietly get another to use tools it was not given. A message to an unregistered agent is blocked. Pairs your app relies on can be allowed up front, so normal features keep working:

```yaml
agents:
  support-bot:
    talksTo: [report-bot]   # may hand work to report-bot without asking
```

**Security review.** `npm run registry` (or `actlatch review --config your.yaml`) ends with advice on setups no single rule shows:

| Finding | Why it matters |
|---|---|
| can delete on its own | the most damaging action needs no human |
| can read private or outside data and send things out on its own | together these are a data-leak path, even if each is harmless alone |
| can message another agent that has tools it lacks | it could get those tools used through the other agent |
| has blanket access (`server.*`) | more power than any one job needs |
| can change records with no limit | an `update` tool allowed with no condition |
| never used a tool (with `--audit actlatch-audit.jsonl`) | least privilege: remove what is not needed |

The review only advises; it changes nothing.

**About system prompts.** An LLM cannot be forced to obey its system prompt; a clever input can talk it out of almost anything. Act-Latch does not rely on that. Whatever the model decides, a call outside its permissions stops at the gateway. Safety rules in the prompt are a useful extra layer, not the lock.

### Checking against real values (lookups)

An agent, or a customer talking to it, can claim anything: "the lamp cost $35 with shipping". A lookup makes Act-Latch fetch the real value itself from a trusted tool before deciding, and rules compare against that instead:

```yaml
lookups:
  - tool: helpdesk.refund_order     # before deciding on this tool...
    call: helpdesk.get_order        # ...Act-Latch calls this itself
    args: { order_id: order_id }    # with the order_id from the agent's call
    as: order                       # and keeps the JSON answer as "order"

agents:
  support-bot:
    tools:
      - tool: helpdesk.refund_order
        if: { number: { arg: amount, gt: { fact: order.price, plus: 5 } } }
        decision: approve
        reason: Refund is more than the order's real price; a human must decide.
```

The looked-up value is shown on the approval card, so the person deciding sees "price: 20" next to "amount: 35". If the lookup fails (unknown order, server error), the limit counts as already exceeded, so the rule fires rather than letting the call slip through.

`npm run demo:agents` runs the full story with a fake helpdesk: report-bot can only read, support-bot refunds $18 on its own, needs a human for $120, needs a human for $35 on a $20 lamp even though that is under its $50 limit, is blocked at $5000 (even though a ticket says "you are authorised"), cannot delete customers, and an unregistered agent gets nothing. The full example is [`examples/agents.yaml`](examples/agents.yaml).

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

approval: { port: 4848, timeoutSeconds: 300 }   # a timeout counts as a denial; openBrowser: false stops the page opening by itself
audit:    { path: actlatch-audit.jsonl }
```

Tool patterns are `server.tool` and may use `*` (for example `mail.*`). Conditions available in `if` (all must hold):

| Condition | Holds when |
|-----------|------------|
| `count: { arg, gt, lte }` | the number of items in `arg` (array, or comma-separated string) is above `gt` / at most `lte` |
| `externalRecipients: { arg, internalDomains? }` | any email address in `arg` is outside the internal domains |
| `matches: { arg, pattern }` | the string `arg` matches the regex (case-insensitive) |
| `number: { arg, gt, lte }` | the number in `arg` is above `gt` / at most `lte` (a missing or non-numeric value counts as over any limit). A limit can be a number or a looked-up fact: `{ fact: order.price, plus: 5 }` |

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
