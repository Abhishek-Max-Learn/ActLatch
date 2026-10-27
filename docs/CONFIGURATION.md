# Act-Latch configuration guide

This guide walks you from nothing to a working Act-Latch in front of your AI agents. It is written for the person who sets the app up (the admin). You don't need to write code, but you will edit one settings file and run a few commands.

> This guide describes Act-Latch once PR #8 (security fixes, npm package) and PR #9 (only the orchestrator hands out work) are merged.

## What you are setting up

Your agents normally plug straight into their tools (Gmail, a database, a helpdesk). With Act-Latch, each agent plugs into Act-Latch instead, and Act-Latch plugs into the real tools. Every request passes five checks before anything happens:

1. **Who is asking?** Unknown agents get nothing.
2. **Is this tool on their list?** Anything not listed is blocked.
3. **Is it within their limits?** For example: at most 5 recipients, refunds up to $50.
4. **Is it a hand-off to another agent?** Only the orchestrator may do that.
5. **Is it risky?** Then a human approves it first, on the approval page.

You describe all of this in one settings file, `actlatch.yaml`. Act-Latch reads it once at start-up and locks it, so nothing an agent reads or says can change it while it runs.

## Before you start

| You need | Why |
|---|---|
| Node.js 20 or newer | Act-Latch runs on it. Or use GitHub Codespaces, where it is already installed. |
| Your agents use MCP to reach their tools | MCP is the standard "tool plug" for AI agents. Act-Latch sits on that plug. Tools wired straight into an app's own code can't be checked yet. |
| The agents and Act-Latch on the same computer | Today they connect directly on the machine. Connecting over the internet is not built yet. |
| The tools' passwords or API keys | They go into Act-Latch's environment, never to the agents. |

Any AI model works (Claude, ChatGPT, Grok, Llama and so on). Act-Latch only looks at tool requests, not at the model.

## Step 1: list your tool servers

Create `servers.yaml` with the real tool servers your agents use today. Each one is called an *upstream*.

```yaml
upstreams:
  mail:                          # a short name you choose; tools appear as mail.<tool>
    command: npx                 # how to start the tool server
    args: [some-gmail-mcp-server]
    env:
      GMAIL_TOKEN: ${GMAIL_TOKEN}    # the real key, read from Act-Latch's own environment
    trust: untrusted             # its output can contain text from strangers (emails, web pages)
```

| Setting | What it means |
|---|---|
| `command`, `args` | The command that starts the tool server, the same one you used before Act-Latch. |
| `cwd` | Optional folder to start it in, relative to the settings file. |
| `env` | Keys and settings for the tool server. `${NAME}` is read from Act-Latch's environment, so the key never sits in the file. If the variable is missing, Act-Latch refuses to start. |
| `trust` | `untrusted` (the default) for anything that returns outside text, like an inbox or a website. `trusted` for your own systems, like an order database. |

## Step 2: answer the setup questions

```bash
npx actlatch setup --config servers.yaml --out actlatch.yaml
```

Act-Latch connects to your tool servers, finds every tool, and asks you plain questions for each agent:

- the agent's name and what it does
- which tools it may use
- for each tool: *yes* (on its own), *ask* (a human approves each time) or *no*
- limits, such as "above how many recipients should a human approve?"
- if you give it a hand-off tool: "Is this agent the orchestrator?"

Press Enter to accept the suggestion in brackets. At the end it shows a table of what every agent may do and a security review, and saves only after you say yes.

**AI help with the questions.** If an AI key is already in the environment, setup uses it to write questions that fit each tool. It never decides anything: every answer comes from you.

| Your AI provider | Set this before running setup |
|---|---|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Grok (xAI), Groq, Azure, Gemini, Ollama, any OpenAI-style API | `ACTLATCH_LLM_URL` (for Grok: `https://api.x.ai/v1`), `ACTLATCH_LLM_KEY`, `ACTLATCH_LLM_MODEL` |
| None, or you'd rather not | add `--no-ai`; fixed questions are used |

## Step 3: check the result

```bash
npx actlatch registry --config actlatch.yaml
```

This prints every agent, its tools, what each tool allows, and a security review. Fix anything marked **HIGH** before going live. Examples of what the review catches:

- an agent can delete things with no human involved
- an agent can read private data *and* send things out on its own (a leak path)
- the orchestrator can get another agent to use tools it doesn't have itself
- an agent has blanket access (`mail.*`) instead of only the tools it needs

## Step 4: connect each agent to Act-Latch

Each agent starts its own Act-Latch door with its own name. In the agent's MCP settings, **replace** the real tool server with Act-Latch. For Claude Desktop (`claude_desktop_config.json`) it looks like this:

```json
{
  "mcpServers": {
    "actlatch": {
      "command": "npx",
      "args": ["actlatch", "start", "--config", "/full/path/actlatch.yaml", "--agent", "email-reader"],
      "env": { "GMAIL_TOKEN": "the-real-key" }
    }
  }
}
```

Other MCP clients and agent frameworks (Python or JavaScript, with Claude, GPT or Grok) have the same idea: a command plus arguments. Use `npx actlatch start --config ... --agent <name>`.

**Remove the real tool server from the agent's settings.** If the agent can still reach it directly, it can go around Act-Latch.

## Step 5: approve risky actions

When a request needs a human, Act-Latch opens the approval page in your browser (and prints the link). A card says in plain words who wants to do what, why you are asked, and the real values it checked. Click **Approve once** or **Deny**. No answer before the timer runs out counts as Deny.

Always open the full link, including the `?token=...` part. Each start prints a new one.

## Step 6: read the diary

```bash
npx actlatch log --config actlatch.yaml
```

Every request in plain words: who asked, for what, and whether it was allowed, blocked, approved, denied or timed out. It also checks that nobody edited the diary. `npx actlatch verify-audit actlatch-audit.jsonl` runs only that check.

---

## Settings reference

A full `actlatch.yaml` has these sections. Only `upstreams` is required.

### `agents`: who may use what

```yaml
agents:
  orchestrator:
    description: Decides which agent handles each email
    orchestrator: true                       # the only agent that may hand out work
    talksTo: [email-reader, summarizer, reply-writer]   # hand-offs to these need no approval
    tools:
      - tool: team.ask_agent
        decision: allow

  email-reader:
    description: Reads the inbox
    key: ${EMAIL_READER_KEY}                 # optional secret, see below
    tools:
      - tool: mail.read_inbox
        decision: allow

  summarizer:
    description: Summarizes emails; needs no tools
    tools: []

  reply-writer:
    description: Drafts and sends replies
    tools:
      - tool: mail.draft_email
        decision: allow
      - tool: mail.send_email
        if: { count: { arg: to, gt: 50 } }
        decision: deny
        reason: Never send to more than 50 people.
      - tool: mail.send_email
        if: { externalRecipients: { arg: to } }
        decision: approve
        reason: Email outside the company needs a human.
      - tool: mail.send_email
        decision: approve
```

| Setting | What it means |
|---|---|
| `tools` | The agent's tool list. Rules are read top to bottom and **the first match wins**. Any tool not listed is blocked, and is hidden from the agent's tool list. |
| `orchestrator: true` | Marks the boss agent. Only an orchestrator may pass work to other agents. Every other agent is a helper: helpers don't see hand-off tools, and if they try one anyway, it is blocked with no approval card. |
| `talksTo` | Agents the orchestrator may hand work to without asking. Hand-offs to other registered agents need approval, and to unregistered names they're blocked. Only allowed on an orchestrator. |
| `key` | Optional shared secret. Act-Latch then only starts for this agent when `ACTLATCH_AGENT_KEY` matches, so another program can't pretend to be it. |

If there is no `agents` section, every caller gets the same `policy` rules (fine for a single agent).

### Rules: `tool`, `if`, `decision`, `reason`

| Field | Values |
|---|---|
| `tool` | `server.tool`, for example `mail.send_email`. `*` matches anything: `mail.*`. |
| `decision` | `allow` (goes through), `approve` (a human decides), `deny` (blocked). |
| `reason` | Shown to the agent and on the approval card. |
| `if` | Optional conditions. All of them must hold for the rule to match. |

Conditions:

| Condition | Matches when |
|---|---|
| `count: { arg: to, gt: 5 }` | the argument holds more than 5 items. `lte: 5` means at most 5. |
| `externalRecipients: { arg: to }` | any email address in it is outside `policy.internalDomains` (or its own `internalDomains`). |
| `matches: { arg: body, pattern: "password" }` | the text matches the pattern (case-insensitive). |
| `number: { arg: amount, gt: 50 }` | the number is above 50. A missing or non-number value counts as over the limit. The limit can be a looked-up fact: `gt: { fact: order.price, plus: 5 }`. |

### `policy`: rules for everyone

```yaml
policy:
  default: deny                      # what happens when no rule matches (keep it deny)
  internalDomains: [acme.com]        # your own email domains
  rules: []                          # extra rules for every agent; they can only make a decision stricter
  protectAfterUntrusted: [mail.send_email]   # once this door has read untrusted text, these always need a human
```

### `toolInfo`: correct Act-Latch's guesses

Act-Latch guesses what each tool does from its name: read, write, update or delete, whether it returns private data, sends things out, or passes work to another agent. Set it where the guess is wrong:

```yaml
toolInfo:
  db.run_report:  { access: read, sensitive: true }
  crm.notify:     { external: true }
  crew.handover:  { agentCall: { arg: to } }     # a hand-off tool; "to" names the agent
```

### `lookups`: check against real values

Don't trust a number the agent (or a customer) typed. Let Act-Latch fetch the real one first:

```yaml
lookups:
  - tool: shop.refund_order        # before deciding on this tool...
    call: shop.get_order           # ...Act-Latch calls this trusted tool itself
    args: { order_id: order_id }
    as: order                      # rules can now use order.price
```

If the lookup fails, the limit counts as exceeded, so the safer rule applies.

### `approval` and `audit`

```yaml
approval:
  host: 127.0.0.1          # keep it on this computer
  port: 4848
  timeoutSeconds: 300      # no answer in time = Deny
  openBrowser: true        # open the page by itself when needed
audit:
  path: actlatch-audit.jsonl   # contains full request details; keep it private
```

### Environment variables

| Variable | Used for |
|---|---|
| `ACTLATCH_AGENT` | The agent's name, instead of `--agent`. |
| `ACTLATCH_AGENT_KEY` | The agent's secret, when its entry has a `key`. |
| `ACTLATCH_LLM_URL`, `_KEY`, `_MODEL` | Setup's AI helper on any OpenAI-style API. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Setup's AI helper. |
| `ACTLATCH_LLM=off` | Turn the AI helper off (same as `--no-ai`). |
| any `${NAME}` in the file | Tool keys and agent secrets. |

## Common problems

| You see | Fix |
|---|---|
| `Forbidden` on the approval page | Open the full link with `?token=...`. Each start prints a new one. |
| `agent "x" is not registered` | Add the agent under `agents`, or fix the `--agent` name. |
| `... is not in x's tool list` | Add a rule for that tool to the agent, if it really needs it. |
| `x is a helper agent; only an orchestrator may pass work to other agents` | Working as designed. Route the work through the orchestrator. |
| `talksTo is only for an orchestrator` | Add `orchestrator: true` to that agent, or remove `talksTo`. |
| `Config references ${X} but it is not set` | Set that environment variable before starting. |
| A typo in a setting stops start-up | On purpose: unknown settings are an error, so a typo can't quietly switch a rule off. |

See also [SECURITY-DESIGN.md](SECURITY-DESIGN.md) for how and why each protection works.
