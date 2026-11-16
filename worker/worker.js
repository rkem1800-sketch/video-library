// Video Library + Penguin HQ API — Cloudflare Worker (module syntax).
// Secrets live only in KV and Worker secrets. HQ_BRIEF_TOKEN_HASH = SHA-256 hex of the brief-writer token.
const ORIGIN = "https://rkem1800-sketch.github.io";
const MAX_FAILS = 10;          // wrong PINs per IP before lockout
const GLOBAL_MAX_FAILS = 50;   // wrong PINs across all IPs before lockout
const LOCK_SECONDS = 900;      // 15 minutes
const VIDEO_RE = [
  /^https?:\/\/(www\.|m\.|music\.)?youtube\.com\/watch\?(.*&)?v=[\w-]{6,}/i,
  /^https?:\/\/(www\.)?youtu\.be\/[\w-]{6,}/i,
  /^https?:\/\/(www\.|m\.)?youtube\.com\/(shorts|live)\/[\w-]{6,}/i,
  /^https?:\/\/(www\.|m\.|web\.)?facebook\.com\/(reel\/\d+|watch\/?\?(.*&)?v=\d+|[^\/?#]+\/videos\/[^?#]*\d+|video\.php\?(.*&)?v=\d+|share\/[rv]\/[\w-]+)/i,
  /^https?:\/\/fb\.watch\/[\w-]+/i
];

function cors(req) {
  const h = { "Vary": "Origin" };
  if (req.headers.get("Origin") === ORIGIN) {
    h["Access-Control-Allow-Origin"] = ORIGIN;
    h["Access-Control-Allow-Methods"] = "GET, PUT, POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, X-PIN, Authorization";
    h["Access-Control-Max-Age"] = "86400";
  }
  return h;
}
function json(req, status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors(req) } });
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return [...a].map(b => b.toString(16).padStart(2, "0")).join(""); }
function safeEq(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
async function readJson(req) { try { const t = await req.text(); if (t.length > 100000) return null; return JSON.parse(t || "{}"); } catch (e) { return null; } }
function validPin(p) { return typeof p === "string" && p.length >= 6 && p.length <= 64; }

async function lockState(env, ip) {
  const [mine, all] = await Promise.all([env.KV.get("fails:" + ip, "json"), env.KV.get("fails:all", "json")]);
  const now = Date.now();
  const lockedUntil = Math.max(mine && mine.lockedUntil || 0, all && all.lockedUntil || 0);
  return { mine: mine || { n: 0 }, all: all || { n: 0 }, locked: lockedUntil > now, retryAfter: Math.ceil((lockedUntil - now) / 1000) };
}
async function recordFail(env, ip, ls) {
  const now = Date.now();
  const mine = { n: (ls.mine.n || 0) + 1 }; if (mine.n >= MAX_FAILS) mine.lockedUntil = now + LOCK_SECONDS * 1000;
  const all = { n: (ls.all.n || 0) + 1 }; if (all.n >= GLOBAL_MAX_FAILS) all.lockedUntil = now + LOCK_SECONDS * 1000;
  await Promise.all([
    env.KV.put("fails:" + ip, JSON.stringify(mine), { expirationTtl: LOCK_SECONDS }),
    env.KV.put("fails:all", JSON.stringify(all), { expirationTtl: LOCK_SECONDS })
  ]);
  return { left: Math.max(0, MAX_FAILS - mine.n), locked: !!(mine.lockedUntil || all.lockedUntil) };
}
// Returns null when the PIN is good, or a Response to send back.
async function checkPin(req, env, cfg) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const ls = await lockState(env, ip);
  if (ls.locked) return json(req, 429, { ok: false, error: "locked", message: "Too many wrong PINs. Try again in 15 minutes.", retryAfter: ls.retryAfter });
  const pin = req.headers.get("X-PIN") || "";
  if (!pin) return json(req, 401, { ok: false, error: "pin_required", message: "Sign in with your PIN." });
  if (!cfg) return json(req, 409, { ok: false, error: "not_setup", message: "Set up first." });
  const h = await sha256Hex(cfg.salt + ":" + pin);
  if (!safeEq(h, cfg.pinHash)) {
    const r = await recordFail(env, ip, ls);
    return json(req, r.locked ? 429 : 401, { ok: false, error: r.locked ? "locked" : "bad_pin", message: r.locked ? "Too many wrong PINs. Try again in 15 minutes." : "Wrong PIN.", triesLeft: r.left });
  }
  if (ls.mine.n) await env.KV.delete("fails:" + ip);
  return null;
}

// ---------- Penguin HQ helpers ----------
const HQ_MAX_ITEMS = 2000, HQ_MAX_TOMBS = 2000, HQ_MAX_EVENTS = 200, DONE_KEEP_MS = 14 * 86400000;
const TASK_STATUSES = ["todo", "doing", "review", "done", "future"];
const TASK_LABEL = { todo: "To Do", doing: "In Progress", review: "For Review", done: "Done", future: "Future" };
const PRIORITIES = ["high", "med", "low"];
const CLOSEOUT_FLAGS = ["permit", "return visit", "parts", "estimate", "rebate", "photos"];
// Field types: s = short text, l = long text, n = number, d = date (YYYY-MM-DD), f = closeout flags
const WS = {
  ar: { label: "AR Collections", statuses: ["Not due", "Due", "In collection", "Paid", "Forgiven", "Do not contact"],
    fields: { customer: "s", invoice: "s", balance: "n", due: "d", lastContact: "d", note: "l", source: "s", sourceId: "s" },
    name: (r) => [r.customer, r.invoice && "#" + r.invoice].filter(Boolean).join(" ") },
  closeout: { label: "Job Closeout", statuses: ["Unresolved", "Incomplete", "Closed out"],
    fields: { job: "s", customer: "s", tech: "s", date: "d", flags: "f", note: "l" },
    name: (r) => [r.job && "Job " + r.job, r.customer].filter(Boolean).join(" ") },
  members: { label: "Membership Tracker", statuses: ["Active not due", "Confirmed due", "Scheduled", "Completed", "Expired"],
    fields: { customer: "s", plan: "s", lastVisit: "d", nextDue: "d", note: "l" },
    name: (r) => [r.customer, r.plan].filter(Boolean).join(", ") },
  permits: { label: "Permits", statuses: ["Not started", "In progress", "Submitted", "Approved", "Closed"],
    fields: { job: "s", customer: "s", address: "s", due: "d", owner: "s", comments: "l" },
    name: (r) => [r.job && "Job " + r.job, r.customer].filter(Boolean).join(" ") }
};
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : (typeof v === "number" && isFinite(v) ? String(v).slice(0, max) : ""); }
function num(x) { return typeof x === "number" && isFinite(x) && x > 0 ? Math.floor(x) : 0; }
function dateStr(v) { const s = str(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ""; }
function goodId(id) { return !!id && id.length <= 64 && /^[\w.-]+$/.test(id); }
function cleanTask(t) {
  if (!t || typeof t !== "object") return null;
  const id = str(t.id, 64); const text = str(t.text || t.title, 300);
  if (!goodId(id) || !text) return null;
  let status = TASK_STATUSES.includes(t.status) ? t.status : (t.done === true ? "done" : "todo");
  const now = Date.now();
  return { id, text, bot: str(t.bot, 64), status, done: status === "done", priority: PRIORITIES.includes(t.priority) ? t.priority : "",
    due: dateStr(t.due), notes: str(t.notes, 2000), needsRK: t.needsRK === true,
    createdAt: num(t.createdAt) || now, updatedAt: num(t.updatedAt) || now, doneAt: status === "done" ? (num(t.doneAt) || now) : 0 };
}
function cleanRow(ws, r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id, 64); if (!goodId(id)) return null;
  const now = Date.now();
  const out = { id, status: ws.statuses.includes(r.status) ? r.status : ws.statuses[0], needsRK: r.needsRK === true,
    createdAt: num(r.createdAt) || now, updatedAt: num(r.updatedAt) || now };
  for (const [k, t] of Object.entries(ws.fields)) {
    if (t === "s") out[k] = str(r[k], 200);
    else if (t === "l") out[k] = str(r[k], 2000);
    else if (t === "d") out[k] = dateStr(r[k]);
    else if (t === "dt") { const v = str(r[k], 16); out[k] = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(v) ? v : ""; }
    else if (t === "yn") { const v = r[k], x = typeof v === "string" ? v.trim().toLowerCase() : v; out[k] = (x === true || x === 1 || x === "yes" || x === "true" || x === "1") ? "yes" : (x === false || x === 0 || x === "no" || x === "false" || x === "0") ? "no" : ""; }
    else if (t === "u") out[k] = r[k] === "urgent" ? "urgent" : "normal";
    else if (t === "n") { const n = typeof r[k] === "string" ? parseFloat(r[k].replace(/[$,]/g, "")) : r[k]; out[k] = typeof n === "number" && isFinite(n) ? Math.round(n * 100) / 100 : null; }
    else if (t === "f") out[k] = Array.isArray(r[k]) ? [...new Set(r[k].filter((f) => CLOSEOUT_FLAGS.includes(f)))] : [];
  }
  return out;
}
function cleanBrief(b) {
  if (!b || typeof b !== "object") return null;
  const items = Array.isArray(b.items) ? b.items.slice(0, 12).map((it) => {
    if (typeof it === "string") return { emoji: "", text: str(it, 300), bot: "" };
    if (!it || typeof it !== "object") return null;
    return { emoji: str(it.emoji, 8), text: str(it.text, 300), bot: str(it.bot, 64) };
  }).filter((it) => it && it.text) : [];
  const out = { date: str(b.date, 20), title: str(b.title, 80), headline: str(b.headline, 300), items, from: str(b.from, 60), updatedAt: Date.now() };
  if (!out.headline && !items.length) return null;
  return out;
}
// Write-only token for bots/routines: HQ_WRITE_TOKEN_HASH (and, for the brief, HQ_BRIEF_TOKEN_HASH). Only SHA-256 hashes live in the Worker.
async function tokenOk(req, env, allowBrief) {
  const tok = (req.headers.get("Authorization") || "").replace(/^bearer\s+/i, "").trim();
  if (!tok || tok.length > 200) return false;
  const h = await sha256Hex(tok);
  const hashes = [env.HQ_WRITE_TOKEN_HASH, allowBrief ? env.HQ_BRIEF_TOKEN_HASH : null].filter(Boolean).map((x) => String(x).toLowerCase());
  return hashes.some((x) => safeEq(h, x));
}
async function addEvents(env, evs) {
  if (!evs.length) return;
  const cur = (await env.KV.get("hq:activity", "json")) || { events: [] };
  const events = evs.concat(cur.events || []).slice(0, HQ_MAX_EVENTS);
  await env.KV.put("hq:activity", JSON.stringify({ events, updatedAt: Date.now() }));
}
function ev(by, text, kind, extra) { return Object.assign({ id: "e" + Date.now().toString(36) + randHex(3), ts: Date.now(), by: str(by, 60) || "RK", text: str(text, 300), kind: kind || "note" }, extra || {}); }
// Collections: tasks live in "hq:state" ({tasks, deleted}); trackers in "hq:ws:<name>" ({rows, deleted}).
function coll(name) {
  if (name === "tasks") return { key: "hq:state", list: "tasks", clean: cleanTask, label: "Board", name: (t) => t.text, status: (t) => TASK_LABEL[t.status] };
  const ws = WS[name]; if (!ws) return null;
  return { key: "hq:ws:" + name, list: "rows", clean: (r) => cleanRow(ws, r), label: ws.label, name: ws.name, status: (r) => r.status, ws: name, keep: ws.keep };
}
function pruneTasks(st) {
  const cut = Date.now() - DONE_KEEP_MS; const tombs = new Set(st.deleted);
  st.tasks = st.tasks.filter((t) => { if (t.status === "done" && t.doneAt && t.doneAt < cut) { tombs.add(t.id); return false; } return true; });
  st.deleted = [...tombs].slice(-HQ_MAX_TOMBS);
  return st;
}
async function readColl(env, c) {
  const raw = (await env.KV.get(c.key, "json")) || {};
  const st = { [c.list]: (Array.isArray(raw[c.list]) ? raw[c.list] : []).map(c.clean).filter(Boolean), deleted: Array.isArray(raw.deleted) ? raw.deleted : [], updatedAt: raw.updatedAt || 0 };
  return c.list === "tasks" ? pruneTasks(st) : st;
}
// mode "replace": newest updatedAt wins (app). mode "patch": fields merge onto the existing item (bots).
async function writeColl(env, c, body, mode, by) {
  const cur = await readColl(env, c);
  const tombs = new Set(cur.deleted.filter((x) => typeof x === "string"));
  const byId = new Map(cur[c.list].map((x) => [x.id, x]));
  const evs = []; let added = 0, changed = 0, removed = 0;
  for (const id of (Array.isArray(body.deleted) ? body.deleted : [])) {
    if (typeof id !== "string" || id.length > 64) continue;
    if (byId.has(id)) { removed++; if (mode === "replace" && evs.length < 5) evs.push(ev(by, "Deleted from " + c.label + ": " + c.name(byId.get(id)), "delete", { ws: c.ws })); }
    tombs.add(id); byId.delete(id);
  }
  const incoming = Array.isArray(body[c.list]) ? body[c.list] : [];
  for (const raw of incoming.slice(0, HQ_MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const old = byId.get(str(raw.id, 64));
    let item;
    if (mode === "patch") {
      const keepSt = c.keep && old && c.keep.includes(old.status) && raw.reopen !== true ? { status: old.status } : {};
      item = c.clean(Object.assign({}, old || {}, raw, keepSt, { updatedAt: Date.now(), createdAt: old ? old.createdAt : Date.now() }));
    }
    else item = c.clean(raw);
    if (!item || tombs.has(item.id) && mode !== "patch") continue;
    if (mode === "patch") tombs.delete(item.id);
    if (old && mode === "replace" && (item.updatedAt || 0) < (old.updatedAt || 0)) continue;
    if (!old) { added++; if (mode === "replace" && evs.length < 5) evs.push(ev(by, "Added to " + c.label + ": " + c.name(item), "add", { ws: c.ws })); }
    else if (JSON.stringify(Object.assign({}, old, { updatedAt: 0 })) !== JSON.stringify(Object.assign({}, item, { updatedAt: 0 }))) {
      changed++;
      if (mode === "replace" && evs.length < 5) {
        const moved = c.status(old) !== c.status(item);
        evs.push(ev(by, (moved ? "Moved to " + c.status(item) + ": " : "Updated in " + c.label + ": ") + c.name(item), moved ? "move" : "update", { ws: c.ws }));
      }
    }
    byId.set(item.id, item);
  }
  let st = { [c.list]: [...byId.values()].filter((x) => !tombs.has(x.id)).slice(-HQ_MAX_ITEMS), deleted: [...tombs].slice(-HQ_MAX_TOMBS), updatedAt: Date.now() };
  if (c.list === "tasks") st = pruneTasks(st);
  await env.KV.put(c.key, JSON.stringify(st));
  if (mode === "patch") {
    const custom = str(body.activity, 300);
    if (custom) evs.push(ev(by, custom, "bot", { ws: c.ws }));
    else if (added || changed || removed) evs.push(ev(by, c.label + ": " + [added && added + " added", changed && changed + " updated", removed && removed + " removed"].filter(Boolean).join(", "), "bot", { ws: c.ws }));
  } else if (evs.length >= 5 && added + changed + removed > 5) {
    evs.push(ev(by, c.label + ": " + (added + changed + removed - 5) + " more changes", "update", { ws: c.ws }));
  }
  await addEvents(env, evs);
  return { st, added, changed, removed };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const cfg = await env.KV.get("config", "json");

    if (path === "/" || path === "/status") {
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      return json(req, 200, { ok: true, service: "video-library-api", setup: !!cfg });
    }

    if (path === "/setup") {
      if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
      const body = await readJson(req);
      if (!body) return json(req, 400, { ok: false, error: "bad_json" });
      let next;
      if (!cfg) {
        if (!validPin(body.pin)) return json(req, 400, { ok: false, error: "bad_pin_format", message: "PIN must be at least 6 characters." });
        if (typeof body.webhookUrl !== "string" || !/^https:\/\/\S+$/i.test(body.webhookUrl.trim())) return json(req, 400, { ok: false, error: "bad_webhook_url", message: "Webhook URL must start with https://" });
        if (typeof body.webhookKey !== "string" || !body.webhookKey.trim()) return json(req, 400, { ok: false, error: "bad_key", message: "Paste the sender key." });
        const salt = randHex(16);
        next = { salt, pinHash: await sha256Hex(salt + ":" + body.pin), webhookUrl: body.webhookUrl.trim(), webhookKey: body.webhookKey.trim(), createdAt: Date.now() };
      } else {
        const bad = await checkPin(req, env, cfg); if (bad) return bad;
        next = { ...cfg, updatedAt: Date.now() };
        if (body.newPin !== undefined && body.newPin !== "") {
          if (!validPin(body.newPin)) return json(req, 400, { ok: false, error: "bad_pin_format", message: "PIN must be at least 6 characters." });
          next.salt = randHex(16); next.pinHash = await sha256Hex(next.salt + ":" + body.newPin);
        }
        if (typeof body.webhookUrl === "string" && body.webhookUrl.trim()) {
          if (!/^https:\/\/\S+$/i.test(body.webhookUrl.trim())) return json(req, 400, { ok: false, error: "bad_webhook_url", message: "Webhook URL must start with https://" });
          next.webhookUrl = body.webhookUrl.trim();
        }
        if (typeof body.webhookKey === "string" && body.webhookKey.trim()) next.webhookKey = body.webhookKey.trim();
      }
      next.webhookKey = next.webhookKey.replace(/^authorization:\s*/i, "").replace(/^bearer\s+/i, "");
      await env.KV.put("config", JSON.stringify(next));
      return json(req, 200, { ok: true, setup: true });
    }

    if (path === "/state") {
      if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      if (req.method === "GET") {
        const st = (await env.KV.get("state", "json")) || { deleted: [], ticks: {}, updatedAt: 0 };
        return json(req, 200, { ok: true, state: st });
      }
      const body = await readJson(req);
      if (!body || !Array.isArray(body.deleted) || typeof body.ticks !== "object" || body.ticks === null || Array.isArray(body.ticks))
        return json(req, 400, { ok: false, error: "bad_state", message: "Need {deleted: [], ticks: {}}" });
      const deleted = body.deleted.filter(x => typeof x === "string" && x.length < 100).slice(0, 1000);
      const ticks = {};
      for (const [k, v] of Object.entries(body.ticks).slice(0, 5000)) if (v === true && k.length < 600) ticks[k] = true;
      const st = { deleted, ticks, updatedAt: Date.now() };
      await env.KV.put("state", JSON.stringify(st));
      return json(req, 200, { ok: true, state: st });
    }

    if (path === "/add") {
      if (req.method !== "POST") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      const body = await readJson(req);
      const link = body && typeof body.url === "string" ? body.url.trim() : "";
      if (!link || link.length > 2000 || !VIDEO_RE.some(r => r.test(link))) return json(req, 400, { ok: false, error: "not_video", message: "That's not a YouTube or Facebook video link." });
      let resp;
      try {
        resp = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + cfg.webhookKey },
          body: JSON.stringify({ url: link, source: "video-library-app" })
        });
      } catch (e) {
        return json(req, 502, { ok: false, error: "webhook_unreachable", message: "Couldn't reach Summer's webhook." });
      }
      return json(req, resp.ok ? 200 : 502, { ok: resp.ok, webhookStatus: resp.status });
    }

    // ---------- Penguin HQ ----------
    // Board tasks (PIN). Old tasks without a status migrate: done -> "done", else "todo".
    if (path === "/hq/state") {
      if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      const c = coll("tasks");
      if (req.method === "GET") return json(req, 200, { ok: true, state: await readColl(env, c) });
      const body = await readJson(req);
      if (!body || !Array.isArray(body.tasks)) return json(req, 400, { ok: false, error: "bad_state", message: "Need {tasks: [], deleted: []}" });
      const r = await writeColl(env, c, body, "replace", "RK");
      return json(req, 200, { ok: true, state: r.st });
    }
    // Bots/routines: upsert tasks with the write token.
    if (path === "/hq/tasks") {
      if (req.method !== "POST" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      if (!(await tokenOk(req, env, false))) return json(req, 401, { ok: false, error: "bad_token" });
      const body = await readJson(req);
      if (!body || (!Array.isArray(body.tasks) && !Array.isArray(body.deleted))) return json(req, 400, { ok: false, error: "bad_body", message: "Need {tasks: [...]} and/or {deleted: [...]}" });
      const r = await writeColl(env, coll("tasks"), body, "patch", body.by || "Bot");
      return json(req, 200, { ok: true, added: r.added, updated: r.changed, removed: r.removed, total: r.st.tasks.length });
    }
    // Follow-ups moved to the Penguin-owned Worker penguin-hq-api (Nov 16 2026).
    // Workspaces: /hq/ws (counts), /hq/ws/<ar|closeout|members|permits>
    if (path === "/hq/ws") {
      if (req.method !== "GET") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      const out = {};
      for (const name of Object.keys(WS)) {
        const st = await readColl(env, coll(name)); const by = {};
        st.rows.forEach((r) => { by[r.status] = (by[r.status] || 0) + 1; });
        out[name] = { label: WS[name].label, statuses: WS[name].statuses, count: st.rows.length, byStatus: by, needsRK: st.rows.filter((r) => r.needsRK).length };
      }
      return json(req, 200, { ok: true, workspaces: out });
    }
    const wsm = path.match(/^\/hq\/ws\/([a-z]+)$/);
    if (wsm) {
      const c = coll(wsm[1]);
      if (!c || wsm[1] === "tasks") return json(req, 404, { ok: false, error: "no_workspace" });
      if (req.method === "POST") {
        if (!(await tokenOk(req, env, false))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        if (!body || (!Array.isArray(body.rows) && !Array.isArray(body.deleted))) return json(req, 400, { ok: false, error: "bad_body", message: "Need {rows: [...]} and/or {deleted: [...]}" });
        const r = await writeColl(env, c, body, "patch", body.by || "Bot");
        return json(req, 200, { ok: true, added: r.added, updated: r.changed, removed: r.removed, total: r.st.rows.length });
      }
      if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      if (req.method === "GET") return json(req, 200, { ok: true, state: await readColl(env, c), statuses: WS[wsm[1]].statuses });
      const body = await readJson(req);
      if (!body || !Array.isArray(body.rows)) return json(req, 400, { ok: false, error: "bad_state", message: "Need {rows: [], deleted: []}" });
      const r = await writeColl(env, c, body, "replace", "RK");
      return json(req, 200, { ok: true, state: r.st });
    }
    // Activity feed: GET with PIN, POST with the write token.
    if (path === "/hq/activity") {
      if (req.method === "GET") {
        const bad = await checkPin(req, env, cfg); if (bad) return bad;
        return json(req, 200, { ok: true, events: ((await env.KV.get("hq:activity", "json")) || { events: [] }).events });
      }
      if (req.method === "POST" || req.method === "PUT") {
        if (!(await tokenOk(req, env, false))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        const list = body && Array.isArray(body.events) ? body.events : body ? [body] : [];
        const evs = list.slice(0, 20).map((e) => e && str(e.text, 300) ? ev(e.by || "Bot", e.text, str(e.kind, 20) || "bot", { ws: WS[e.ws] ? e.ws : undefined, needsRK: e.needsRK === true || undefined }) : null).filter(Boolean);
        if (!evs.length) return json(req, 400, { ok: false, error: "bad_event", message: "Need {text, by?}" });
        await addEvents(env, evs.reverse());
        return json(req, 200, { ok: true, added: evs.length });
      }
      return json(req, 405, { ok: false, error: "method" });
    }

    if (path === "/hq/brief") {
      if (req.method === "GET") {
        const bad = await checkPin(req, env, cfg); if (bad) return bad;
        return json(req, 200, { ok: true, brief: (await env.KV.get("hq:brief", "json")) || null });
      }
      if (req.method === "PUT" || req.method === "POST") {
        if (!env.HQ_BRIEF_TOKEN_HASH && !env.HQ_WRITE_TOKEN_HASH) return json(req, 503, { ok: false, error: "no_token", message: "Brief writer token isn't configured." });
        if (!(await tokenOk(req, env, true))) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        const brief = cleanBrief(body && body.brief ? body.brief : body);
        if (!brief) return json(req, 400, { ok: false, error: "bad_brief", message: "Need a headline or at least one item." });
        await env.KV.put("hq:brief", JSON.stringify(brief));
        await addEvents(env, [ev(brief.from || "Bot", "Posted the daily brief" + (brief.headline ? ": " + brief.headline : ""), "brief")]);
        return json(req, 200, { ok: true, brief });
      }
      return json(req, 405, { ok: false, error: "method" });
    }
    return json(req, 404, { ok: false, error: "not_found" });
  }
};
