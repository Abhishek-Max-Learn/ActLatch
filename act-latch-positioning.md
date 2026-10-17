# Act-Latch: kahan fit hota hai, existing auth ke saath kaise chalega, aur hero kaise banega

_Research date: 17 Oct 2026. Sources end mein hain. Jo baatein sources se nahi, meri apni raay hain, unhe "(raay)" likha hai._

---

## 1. Existing AI apps mein Act-Latch kahan baithega

Har agent ka loop same hota hai: **LLM sochta hai → tool call banata hai → tool chalta hai.** Act-Latch ko us beech wale point pe baithna hai jahan tool call ban chuka hai lekin chala nahi. Wahan teen tarike se ghus sakte hain:

| Tarika | Kaise kaam karta hai | App wale ko kya badalna padega | Kab best |
|---|---|---|---|
| **A. MCP Gateway / Proxy** | Agent ka MCP client Gmail/Drive MCP server ki jagah Act-Latch ka URL use karta hai. Act-Latch har `tools/call` check karke aage bhejta hai ya rokta hai. | Sirf config mein ek URL. Code change zero. | Claude, Cursor, ChatGPT, LangGraph, OpenAI Agents SDK jaise koi bhi MCP client. **Pehle yahi banao.** |
| **B. SDK / Middleware** | `pip install act-latch` / `npm i act-latch`. Developer apne tool functions ko `@latch.guard` se wrap karta hai, ya framework ke hook (LangGraph interrupt, Vercel AI SDK, OpenAI Agents guardrails) mein plug hota hai. | 5-10 line code. | Jo log MCP use nahi karte, apne custom tools likhte hain. |
| **C. Low-code node** | n8n / Make / Zapier ke liye ek "Act-Latch Check" node jo tool step se pehle lagta hai. | Workflow mein ek node drag karo. | Aapka asli target audience (SMB, consultants, no-code builders). |

**Ek zaroori rule:** agar agent ke paas tool ka direct token hai, toh woh Act-Latch ko bypass kar sakta hai. Isliye best design yeh hai ki **real credentials (OAuth tokens) sirf Act-Latch ke paas rahein**, agent ke paas nahi. Tab Act-Latch se guzre bina koi action ho hi nahi sakta. (TrueFoundry ka doc bhi yahi kehta hai: jo traffic gateway se nahi guzarta, us par gateway ki policy laagu nahi hoti.)

Suggested order (raay): **A (MCP gateway) + C (n8n node)** pehle, B baad mein.

---

## 2. Agar app pehle se authn/authz use kar rahi hai (OAuth, Auth0, Okta, Entra)

Inse ladna nahi hai, inke **upar** baithna hai. Dono alag sawal ka jawab dete hain:

| Layer | Sawal | Example |
|---|---|---|
| **Authn** (Auth0, Okta, Entra ID) | Yeh agent/user kaun hai? | "Yeh Sales-Bot hai, AB ki taraf se chal raha hai" |
| **OAuth scopes / MCP auth** | Kis cheez ko chhoo sakta hai? | `gmail.send` scope mila hai |
| **Act-Latch** | **Yeh specific action, in parameters ke saath, abhi chalna chahiye ya nahi?** | "500 external logon ko email? Approval chahiye." |

Problem yeh hai ki scopes bahut moote hain. `gmail.send` mil gaya toh technically 1 email bhi bhej sakta hai aur 5000 bhi. Scope "500 recipients", "external domain", "attachment mein customer list" jaisi cheezein nahi dekhta. **Act-Latch yahi gap bharta hai: action-level, parameter-level decision.**

Kaise support karein:
- **Bring your own identity:** Act-Latch agent ka OIDC/JWT token (Auth0/Okta/Entra ka) padhe aur policy mein use kare ("Sales team ke agents", "AB ki taraf se"). Apna login system mat banao enterprise ke liye.
- **Token vault ke saath kaam karo:** Auth0 jaise providers ka Token Vault already Google/Slack tokens rakhta hai. Act-Latch ya toh unse token le, ya apna vault rakhe (SMB ke liye simple option).
- **Approval channel reuse karo:** Auth0 ke paas CIBA-based "async authorization" hai (phone pe push approve). Act-Latch decide karega *kab* approval chahiye; notification Auth0 ke through bhi bhej sakte ho ya apne Slack/WhatsApp/email se.
- **Standards follow karo:** MCP ka OAuth 2.1 auth flow, OpenTelemetry for logs, aur policies ke liye OPA/Cedar jaisa format export. Isse enterprise bolega "yeh hamare stack mein fit hota hai".

Ek line mein (raay): **"Your IdP decides who the agent is. OAuth decides what it can touch. Act-Latch decides what it should do right now."**

---

## 3. Market mein kaun hai (Oct 2026)

Market bhara hua hai, aur bade players chhote startups khareed rahe hain:

- **Acquisitions:** Snyk ne Invariant Labs (MCP runtime), Check Point ne Lakera (prompt injection), SentinelOne ne Prompt Security, F5 ne CalypsoAI, Palo Alto ne Protect AI, Cisco ne Robust Intelligence aur Astrix, Proofpoint ne Acuvity liya.
- **MCP gateways with approvals:** TrueFoundry, MintMCP jaise gateways tool approvals de rahe hain.
- **Identity for agents:** Auth0 for AI Agents (Token Vault, CIBA approvals, FGA for RAG), Okta, Astrix/Cisco, Clutch, Entro.
- **Enterprise posture/governance:** Zenity, Noma, Wiz, Orca, Lasso.
- **Low-code HITL:** n8n aur Zapier mein basic "wait for approval" step hai, lekin policy engine ya audit nahi.

**Gaps jo dikh rahe hain:**
1. Lagbhag sab **enterprise security teams** ke liye bana hai. SMB / non-expert ke liye koi clear product nahi dikhta.
2. Runtime enforcement se **"tuning debt"** aur bahut saare alerts aate hain; bina security engineer wali team enforcement band kar deti hai (securityopswire market map).
3. Approvals mein kamzoriyan: e.g. TrueFoundry ka time-based grant requester+server+tool pe lagta hai, toh grant ke dauraan **arguments badal jayein toh dobara review nahi hota**.
4. n8n/Zapier ke approval steps mein **policy, risk explanation aur proper audit** nahi.

---

## 4. Act-Latch hero kaise banega (raay)

Features sabke paas same naam se hain (permissions, preview, approval, enforcement, audit). Jeetna **depth aur simplicity** se hai. Har pillar mein ek "wow" cheez:

| Pillar | Doosre kya karte hain | Act-Latch ka "wow" |
|---|---|---|
| **Permissions** | YAML/Rego policies, security team likhti hai | **Plain-English presets** ("Draft kar sakta hai, bhej nahi sakta"). Plus **Learn Mode**: 1 hafta sirf dekho, phir khud policy suggest karo. Tuning debt ka seedha ilaj. |
| **Action Preview** | Raw JSON dikhate hain | **Blast-radius card:** "Yeh 500 logon ko jayega, 470 company ke bahar, attachment mein 1,200 phone numbers." Draft ka diff, recipients ki list, reversible hai ya nahi. |
| **Human Approval** | Approve/deny button, kabhi time-based grant | **Exact-action binding:** approval ek hash se juda; recipient ya text badla toh approval khatam. Approve Slack/WhatsApp/mobile se. "Sirf pehle 10 bhejo, phir dekhte hain" jaisa **partial approval**. |
| **Runtime Enforcement** | Prompt-injection classifier (probabilistic) | **Source tracking (taint):** agar action ka idea untrusted email/doc se aaya, toh woh kabhi permission nahi badha sakta. Deterministic, model pe depend nahi. Fail-closed. |
| **Audit Trail** | Logs / SIEM export | **Story timeline:** "Agent ne email padha → usme hidden instruction tha → agent ne contacts export try kiya → Act-Latch ne roka." Tamper-evident (hash-chain), ek click mein PDF/CSV. |

**Positioning (raay):** "Enterprise AI security" mein mat ghuso, wahan Cisco/Palo Alto/Auth0 hain. Wedge yeh ho:
- **Kiske liye:** SMB, AI consultants, n8n/MCP builders.
- **Kya promise:** "5 minute mein apne agent pe seatbelt lagao. Code nahi likhna."
- **Demo jo bechega:** ek email jisme hidden prompt hai, agent 500 customers ko mail bhejne ki koshish karta hai, Act-Latch preview card dikhata hai aur rokta hai. Yeh 60-second video pitch hai.

Baad mein growth: consultants ke liye multi-client dashboard, policy templates marketplace, aur enterprise ke liye IdP/SIEM integrations.

---

## 5. Agla step (suggestion)

1. 10-15 SMB/consultant users se baat karo: kaunsa agent, kaunsa tool, sabse darawna action kya hai.
2. MVP: **MCP gateway + Gmail (ya simulated email tool) + 3 decisions (allow/deny/approve) + preview card + audit timeline.**
3. Wahi hidden-prompt demo banao aur pilot users ko dikhao.

---

## Sources
- [TrueFoundry: MCP tool approval, human gate in the call path](https://www.truefoundry.com/blog/mcp-tool-approval-human-gate-call-path)
- [TrueFoundry: MCP tool approvals explained](https://www.truefoundry.com/es/blog/mcp-tool-approvals-explained)
- [Auth0 for AI Agents docs](https://auth0.com/docs/get-started/auth-for-ai-agents)
- [Auth0 for MCP](https://auth0.com/ai/docs/mcp/auth-for-mcp)
- [Auth0 May 2026 product innovations](https://www.okta.com/newsroom/articles/auth0-may-2026-product-innovations/)
- [Apideck: Agent Auth, why OAuth wasn't built for this](https://www.apideck.com/blog/agent-auth-oauth-ai-agents)
- [AI Agent Security Companies: six-control-plane market map](https://securityopswire.com/ai-agent-security-companies-market-map/)
- [AI security acquisition wave 2026](https://pipelab.org/blog/ai-agent-security-acquisition-wave-2026/)
- [Pillar Security: agentic AI security platforms 2026](https://www.pillar.security/blog/best-agentic-ai-security-platforms-enterprise-2026)
- [MintMCP: AI agent security platforms](https://www.mintmcp.com/blog/ai-agent-security-platforms)
- [Invariant Labs: guardrails](https://invariantlabs.ai/blog/guardrails.html)
- [n8n human-in-the-loop guide](https://growwstacks.com/blog/human-in-the-loop-n8n-guide)
