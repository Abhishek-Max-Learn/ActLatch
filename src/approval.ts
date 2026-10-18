import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resultWords, type Activity } from "./activity.js";
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
  expires: number;
}

export interface ApprovalOptions {
  host: string;
  port: number;
  timeoutSeconds: number;
  /** Open the page in the browser when a decision is needed and no page is open. */
  openBrowser?: boolean;
}

/**
 * Local approval page. It binds to localhost and every request needs a random
 * token printed at startup, so the agent cannot approve its own actions by
 * guessing the URL. Each approval covers one exact action (its hash), once.
 * While the page is open it pops up each new request by itself.
 */
export class WebApprover implements Approver {
  readonly token = randomBytes(16).toString("hex");
  private readonly pending = new Map<string, Pending>();
  private server?: Server;
  private lastSeen = 0; // when an open page last checked in
  /** Recent calls to show under "What happened" on the page, oldest first. */
  activity?: () => Activity[];

  constructor(
    private readonly opts: ApprovalOptions,
    private readonly log: (msg: string) => void = (m) => process.stderr.write(m + "\n"),
    private readonly open: (url: string) => boolean = openInBrowser,
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

  /** Whether an approval page is open right now (it checks in every few seconds). */
  get pageOpen(): boolean {
    return Date.now() - this.lastSeen < 5_000;
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

  list(): (ApprovalRequest & { secondsLeft: number })[] {
    return [...this.pending.values()].map(({ resolve: _r, timer: _t, expires, ...rest }) => ({
      ...rest,
      secondsLeft: Math.max(0, Math.round((expires - Date.now()) / 1000)),
    }));
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
        expires: Date.now() + this.opts.timeoutSeconds * 1000,
        timer,
        resolve: (outcome) => resolve({ id, outcome }),
      });
      const what = req.preview.headline ?? req.preview.tool;
      if (this.pageOpen) {
        this.log(`[actlatch] approval needed: ${what}. It has popped up on the approval page.`);
      } else if (this.opts.openBrowser && this.open(this.browserUrl)) {
        this.log(`[actlatch] approval needed: ${what}. Opening the approval page in your browser: ${this.browserUrl}`);
      } else {
        this.log(`[actlatch] approval needed: ${what}. Open this link to decide: ${this.browserUrl}`);
      }
    });
  }

  private authorised(url: URL): boolean {
    const given = Buffer.from(url.searchParams.get("token") ?? "");
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (!this.authorised(url)) {
      // Usually a link opened without its ?token=... part (for example from the Codespaces
      // "Open in Browser" pop-up), or a tab left open from an earlier run.
      res.writeHead(403, { "content-type": "text/html; charset=utf-8" }).end(LOCKED_PAGE);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/pending") {
      this.lastSeen = Date.now();
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(this.list()));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/activity") {
      const rows = (this.activity?.() ?? []).slice(-50).reverse();
      const body = rows.map((r) => ({ ...r, args: undefined, resultText: resultWords(r.result) }));
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/closed") {
      this.lastSeen = 0; // the tab was closed: open a new one for the next request
      res.writeHead(204).end();
      return;
    }
    const m = /^\/(approve|deny)\/([0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === "POST" && m) {
      const ok = this.decide(m[2]!, m[1] === "approve" ? "approved" : "denied");
      res.writeHead(ok ? 303 : 404, { location: `/?token=${this.token}` }).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      this.lastSeen = Date.now();
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(PAGE);
      return;
    }
    res.writeHead(404).end();
  }
}

/**
 * Open a URL in the person's browser. Inside VS Code and Codespaces terminals
 * $BROWSER points at a helper that opens it on their own computer.
 * Returns false when there is no way to open one (e.g. a server with no screen).
 */
export function openInBrowser(url: string): boolean {
  let cmd: string | undefined;
  let args = [url];
  const browser = process.env.BROWSER?.split(":")[0];
  if (browser) cmd = browser;
  else if (process.platform === "darwin") cmd = "open";
  else if (process.platform === "win32") [cmd, args] = ["cmd", ["/c", "start", "", url]];
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) cmd = "xdg-open";
  if (!cmd) return false;
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const LOCKED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Act-Latch approvals</title></head><body style="font:15px system-ui,sans-serif;max-width:640px;margin:24px auto;padding:0 16px">
<h1>This link is missing its secret key</h1>
<p>For safety, the approval page only opens with the full link Act-Latch printed in the terminal, the one that ends in <code>?token=...</code>.</p>
<p>Copy that whole line from the terminal and open it. If you restarted Act-Latch, use the newest link: each run makes a new one.</p>
</body></html>`;

// The page renders requests itself from /api/pending, always with textContent,
// so nothing an agent puts in its arguments can run as code here.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Act-Latch approvals</title><style>
:root{--bg:#f6f6f3;--card:#fff;--ink:#1c1c1c;--soft:#5f5f5a;--line:#e2e1dc;--warn:#8a4b00;--warnbg:#fff4e0;--ok:#1d7a3a;--no:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#22221f;--ink:#ecebe6;--soft:#a5a49d;--line:#3a3934;--warn:#ffb85c;--warnbg:#3a2a12;--ok:#5cc47e;--no:#ff8a80}}
*{box-sizing:border-box}body{font:16px/1.45 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
main{max-width:720px;margin:0 auto;padding:20px 16px 60px}h1{font-size:22px;margin:0 0 4px}.sub{color:var(--soft);margin:0 0 16px}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:16px}.pill{font-size:13px;padding:4px 10px;border-radius:99px;border:1px solid var(--line);color:var(--soft)}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.head{font-size:19px;font-weight:650;margin:0 0 8px}.why{background:var(--warnbg);color:var(--warn);border-radius:8px;padding:8px 10px;margin:8px 0 12px}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--soft);margin:14px 0 6px}
dl{display:grid;grid-template-columns:minmax(110px,max-content) 1fr;gap:4px 14px;margin:0}dt{color:var(--soft)}dd{margin:0;overflow-wrap:anywhere}
.note{color:var(--soft);margin:4px 0}.left{font-variant-numeric:tabular-nums;color:var(--soft);font-size:14px}
.btns{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}button{font:inherit;font-weight:600;padding:10px 18px;border-radius:9px;border:1px solid var(--line);cursor:pointer;background:var(--card);color:var(--ink)}
button.ok{background:var(--ok);border-color:var(--ok);color:#fff}button.no{color:var(--no);border-color:var(--no)}button.link{font-weight:400;padding:4px 10px;font-size:13px}
details{margin-top:12px;color:var(--soft);font-size:14px}pre{background:var(--bg);padding:8px;border-radius:6px;overflow:auto;font-size:12px}
.empty{color:var(--soft);text-align:center;padding:40px 0}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px;overflow:auto;z-index:9}
.done{background:var(--card);border:2px solid var(--ok);border-radius:14px;padding:16px 18px;margin:14px 0;font-weight:600}.done.no{border-color:var(--no)}.done p{font-weight:400;color:var(--soft);margin:4px 0 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--soft);font-weight:600;font-size:12px;text-transform:uppercase}
.r-allowed,.r-approved{color:var(--ok)}.r-blocked,.r-denied,.r-timed{color:var(--no)}.why2{color:var(--soft);font-size:13px}
.overlay .card{max-width:640px;width:100%;margin:0;box-shadow:0 20px 50px rgba(0,0,0,.35)}.overlay[hidden]{display:none}
</style></head><body><main>
<h1>Act-Latch approvals</h1>
<p class="sub">An AI agent wants to do something your rules say a person must check. Nothing happens until you choose.</p>
<div class="bar"><span class="pill" id="status">Connecting...</span><button class="link" id="alerts" hidden>Turn on pop-up alerts</button></div>
<div id="done"></div>
<div id="list"></div>
<p class="note">New requests pop up here by themselves. If nobody answers in time, the action is blocked. You can close this tab: it opens again when a person is needed.</p>
<h2 style="font-size:18px;margin:28px 0 8px">What happened</h2>
<p class="sub">Every call an agent made, newest first. Act-Latch keeps the full record in its audit log.</p>
<div id="activity"><p class="empty">No calls yet.</p></div>
</main><div class="overlay" id="overlay" hidden></div>
<script>
const token = new URLSearchParams(location.search).get("token");
const listEl = document.getElementById("list"), overlay = document.getElementById("overlay"), statusEl = document.getElementById("status"), alertsBtn = document.getElementById("alerts");
let items = [], seen = new Set(), popped = null, base = Date.now();
function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function lines(title, rows) {
  if (!rows || !rows.length) return [];
  const dl = el("dl");
  for (const r of rows) { dl.append(el("dt", "", r.label), el("dd", "", r.value)); }
  return [el("h3", "", title), dl];
}
function left(r) { const s = Math.max(0, r.secondsLeft - Math.floor((Date.now() - base) / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
function card(r) {
  const p = r.preview, c = el("div", "card");
  c.append(el("p", "head", p.headline || ("An agent wants to use " + p.tool)));
  c.append(el("div", "why", "Why you are asked: " + r.reason));
  c.append(...lines("What it will do", p.details));
  c.append(...lines("Checked by Act-Latch (real values, not the agent's word)", p.facts));
  const notes = (p.summary || []).filter((s) => /recipient|organisation|internal|reversible/i.test(s));
  if (p.effect) notes.unshift(p.effect);
  if (notes.length) { c.append(el("h3", "", "Good to know")); for (const n of notes) c.append(el("p", "note", n)); }
  const t = el("p", "left"); t.dataset.left = r.id; t.textContent = "Blocked automatically in " + left(r) + " if nobody answers."; c.append(t);
  const b = el("div", "btns"), yes = el("button", "ok", "Approve once"), no = el("button", "no", "Deny");
  yes.onclick = () => decide(r.id, "approve"); no.onclick = () => decide(r.id, "deny"); b.append(yes, no); c.append(b);
  const d = el("details"); d.append(el("summary", "", "Technical details"), el("p", "", "Tool: " + p.tool + " | Action fingerprint: " + r.actionHash.slice(0, 12)), el("pre", "", JSON.stringify(p.args, null, 2))); c.append(d);
  return c;
}
async function decide(id, what) {
  const r = items.find((x) => x.id === id);
  await fetch("/" + what + "/" + id + "?token=" + token, { method: "POST", redirect: "manual" }).catch(() => {});
  if (popped === id) { popped = null; overlay.hidden = true; }
  const d = el("div", what === "approve" ? "done" : "done no", (what === "approve" ? "Done: you approved " : "Done: you denied ") + "\u201c" + (r ? r.preview.headline || r.preview.tool : "the request") + "\u201d.");
  d.append(el("p", "", what === "approve" ? "The action is going ahead now." : "The action was blocked and the agent was told not to try another way."));
  document.getElementById("done").replaceChildren(d);
  await poll();
  if (!items.length) {
    d.append(el("p", "", "Nothing else is waiting. This tab will try to close itself; if it stays open, you can close it."));
    setTimeout(() => { if (!items.length) window.close(); }, 4000);
  }
}
function activity(rows) {
  const box = document.getElementById("activity");
  if (!rows.length) { box.replaceChildren(el("p", "empty", "No calls yet.")); return; }
  const t = el("table"), head = el("tr");
  for (const h of ["When", "Agent", "Wanted to", "Result"]) head.append(el("th", "", h));
  t.append(head);
  for (const r of rows) {
    const tr = el("tr"), res = el("td", "r-" + r.result.split(" ")[0], r.resultText);
    if (r.reason && r.result !== "allowed") res.append(el("div", "why2", r.reason));
    tr.append(el("td", "", new Date(r.time).toLocaleTimeString()), el("td", "", r.agent || "-"), el("td", "", r.action), res);
    t.append(tr);
  }
  box.replaceChildren(t);
}
function render() {
  listEl.replaceChildren(...(items.length ? items.map(card) : [el("p", "empty", "Nothing waiting right now.")]));
  document.title = items.length ? "(" + items.length + ") Approval needed - Act-Latch" : "Act-Latch approvals";
  const fresh = items.find((r) => !seen.has(r.id));
  items.forEach((r) => seen.add(r.id));
  if (popped && !items.some((r) => r.id === popped)) { popped = null; overlay.hidden = true; }
  if (fresh && !popped) popup(fresh);
}
function popup(r) {
  popped = r.id; overlay.replaceChildren(card(r)); overlay.hidden = false; beep();
  if ("Notification" in window && Notification.permission === "granted") {
    const n = new Notification("Act-Latch: approval needed", { body: r.preview.headline || r.preview.tool, tag: r.id, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  }
}
function beep() {
  try { const a = new AudioContext(), o = a.createOscillator(), g = a.createGain(); o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + 0.25); } catch (e) {}
}
async function poll() {
  try {
    const res = await fetch("/api/pending?token=" + token, { cache: "no-store" });
    if (!res.ok) throw new Error();
    items = await res.json(); base = Date.now();
    if (items.length) document.getElementById("done").replaceChildren();
    fetch("/api/activity?token=" + token, { cache: "no-store" }).then((a) => a.json()).then(activity).catch(() => {});
    statusEl.textContent = items.length ? items.length + " waiting for you" : "Watching for requests";
    render();
  } catch (e) { statusEl.textContent = "Act-Latch is not running. Start it again and open the new link."; }
}
setInterval(() => { for (const t of document.querySelectorAll("[data-left]")) { const r = items.find((x) => x.id === t.dataset.left); if (r) t.textContent = "Blocked automatically in " + left(r) + " if nobody answers."; } }, 1000);
if ("Notification" in window && Notification.permission === "default") {
  alertsBtn.hidden = false;
  alertsBtn.onclick = () => Notification.requestPermission().then(() => { alertsBtn.hidden = true; });
}
overlay.onclick = (e) => { if (e.target === overlay) { overlay.hidden = true; popped = null; } };
addEventListener("pagehide", () => navigator.sendBeacon("/api/closed?token=" + token));
poll(); setInterval(poll, 2000);
</script></body></html>`;
