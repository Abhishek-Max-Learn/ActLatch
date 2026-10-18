import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Preview } from "./preview.js";

export type ApprovalOutcome = "approved" | "denied" | "timeout";

export interface ApprovalRequest {
  id: string;
  actionHash: string;
  reason: string;
  preview: Preview;
  createdAt: string;
}

export interface Approver {
  /** Ask a human. Resolves once they decide or the request times out. */
  request(req: Omit<ApprovalRequest, "id" | "createdAt">): Promise<{ id: string; outcome: ApprovalOutcome }>;
}

interface Pending extends ApprovalRequest {
  resolve: (o: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Local approval page. It binds to localhost and every request needs a random
 * token printed at startup, so the agent cannot approve its own actions by
 * guessing the URL. Each approval covers one exact action (its hash), once.
 */
export class WebApprover implements Approver {
  readonly token = randomBytes(16).toString("hex");
  private readonly pending = new Map<string, Pending>();
  private server?: Server;

  constructor(
    private readonly opts: { host: string; port: number; timeoutSeconds: number },
    private readonly log: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
  ) {}

  get url(): string {
    const addr = this.server?.address();
    const port = addr && typeof addr === "object" ? addr.port : this.opts.port;
    return `http://${this.opts.host}:${port}/?token=${this.token}`;
  }

  /** The link to open in a browser. Inside GitHub Codespaces this is the forwarded port's URL. */
  get browserUrl(): string {
    const { CODESPACE_NAME: name, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
    if (!name || !domain) return this.url;
    const port = new URL(this.url).port;
    return `https://${name}-${port}.${domain}/?token=${this.token}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((ok, fail) => {
      this.server!.once("error", fail);
      this.server!.listen(this.opts.port, this.opts.host, ok);
    });
    this.log(`[actlatch] approvals: ${this.browserUrl}`);
  }

  async stop(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve("denied");
    }
    this.pending.clear();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  list(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, ...rest }) => rest);
  }

  decide(id: string, outcome: "approved" | "denied"): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(outcome);
    return true;
  }

  request(req: Omit<ApprovalRequest, "id" | "createdAt">): Promise<{ id: string; outcome: ApprovalOutcome }> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ id, outcome: "timeout" });
      }, this.opts.timeoutSeconds * 1000);
      this.pending.set(id, {
        ...req,
        id,
        createdAt: new Date().toISOString(),
        timer,
        resolve: (outcome) => resolve({ id, outcome }),
      });
      this.log(`[actlatch] approval needed for ${req.preview.tool}: ${this.browserUrl}`);
    });
  }

  private authorised(url: URL): boolean {
    const given = Buffer.from(url.searchParams.get("token") ?? "");
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.authorised(url)) {
      // Usually a link opened without its ?token=... part (for example from the Codespaces
      // "Open in Browser" pop-up), or a tab left open from an earlier run.
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(LOCKED_PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/pending") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.list()));
      return;
    }
    const m = /^\/(approve|deny)\/([0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const ok = this.decide(m[2]!, m[1] === "approve" ? "approved" : "denied");
      res.writeHead(ok ? 303 : 404, { location: `/?token=${this.token}` }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(this.page());
      return;
    }
    res.writeHead(404).end();
  }

  private page(): string {
    const items = this.list();
    const cards = items.length
      ? items.map((r) => card(r, this.token)).join("")
      : `<p class="empty">Nothing waiting. This page refreshes every few seconds.</p>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="3"><title>Act-Latch approvals</title><style>
body{font:15px system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;background:#f7f7f5;color:#1c1c1c}
.card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;margin:12px 0}
.tool{font-weight:600;font-size:17px}.why{color:#8a4b00;margin:6px 0}ul{padding-left:20px}
pre{background:#f1f1ee;padding:8px;border-radius:6px;overflow:auto;font-size:12px}
button{font-size:15px;padding:8px 16px;border-radius:6px;border:1px solid #999;margin-right:8px;cursor:pointer}
.ok{background:#e5f4e8}.no{background:#fbe9e7}.empty{color:#666}
</style></head><body><h1>Act-Latch approvals</h1>${cards}</body></html>`;
  }
}

const LOCKED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Act-Latch approvals</title></head><body style="font:15px system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px">
<h1>This link is missing its secret key</h1>
<p>For safety, the approval page only opens with the full link Act-Latch printed in the terminal, the one that ends in <code>?token=...</code>.</p>
<p>Copy that whole line from the terminal and open it. If you restarted Act-Latch, use the newest link: each run makes a new one.</p>
</body></html>`;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function card(r: ApprovalRequest, token: string): string {
  return `<div class="card"><div class="tool">${esc(r.preview.tool)}</div>
<div class="why">${esc(r.reason)}</div>
<ul>${r.preview.summary.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<details><summary>Exact arguments (hash ${esc(r.actionHash.slice(0, 12))})</summary><pre>${esc(JSON.stringify(r.preview.args, null, 2))}</pre></details>
<form method="post" style="display:inline" action="/approve/${r.id}?token=${token}"><button class="ok">Approve once</button></form>
<form method="post" style="display:inline" action="/deny/${r.id}?token=${token}"><button class="no">Deny</button></form></div>`;
}
