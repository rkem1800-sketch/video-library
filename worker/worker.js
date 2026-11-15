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
const HQ_MAX_TASKS = 1000, HQ_MAX_TOMBS = 1000;
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }
function cleanTask(t) {
  if (!t || typeof t !== "object") return null;
  const id = str(t.id, 64); const text = str(t.text, 400);
  if (!id || !/^[\w-]+$/.test(id) || !text) return null;
  const num = (x) => (typeof x === "number" && isFinite(x) && x > 0 ? Math.floor(x) : 0);
  return { id, text, bot: str(t.bot, 64), done: t.done === true, createdAt: num(t.createdAt) || Date.now(), updatedAt: num(t.updatedAt) || Date.now(), doneAt: t.done === true ? (num(t.doneAt) || Date.now()) : 0 };
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
    if (path === "/hq/state") {
      if (req.method !== "GET" && req.method !== "PUT") return json(req, 405, { ok: false, error: "method" });
      const bad = await checkPin(req, env, cfg); if (bad) return bad;
      const cur = (await env.KV.get("hq:state", "json")) || { tasks: [], deleted: [], updatedAt: 0 };
      if (req.method === "GET") return json(req, 200, { ok: true, state: cur });
      const body = await readJson(req);
      if (!body || !Array.isArray(body.tasks)) return json(req, 400, { ok: false, error: "bad_state", message: "Need {tasks: [], deleted: []}" });
      // Merge: newest updatedAt wins per task; deleted ids are kept as tombstones.
      const tombs = new Set((cur.deleted || []).filter((x) => typeof x === "string"));
      (Array.isArray(body.deleted) ? body.deleted : []).forEach((x) => { if (typeof x === "string" && x.length <= 64) tombs.add(x); });
      const byId = new Map();
      (cur.tasks || []).forEach((t) => byId.set(t.id, t));
      body.tasks.slice(0, HQ_MAX_TASKS).forEach((raw) => {
        const t = cleanTask(raw); if (!t) return;
        const old = byId.get(t.id);
        if (!old || (t.updatedAt || 0) >= (old.updatedAt || 0)) byId.set(t.id, t);
      });
      const tasks = [...byId.values()].filter((t) => !tombs.has(t.id)).slice(-HQ_MAX_TASKS);
      const st = { tasks, deleted: [...tombs].slice(-HQ_MAX_TOMBS), updatedAt: Date.now() };
      await env.KV.put("hq:state", JSON.stringify(st));
      return json(req, 200, { ok: true, state: st });
    }

    if (path === "/hq/brief") {
      if (req.method === "GET") {
        const bad = await checkPin(req, env, cfg); if (bad) return bad;
        return json(req, 200, { ok: true, brief: (await env.KV.get("hq:brief", "json")) || null });
      }
      if (req.method === "PUT" || req.method === "POST") {
        // Write-only token for routines. Only its SHA-256 hash is stored in the Worker.
        if (!env.HQ_BRIEF_TOKEN_HASH) return json(req, 503, { ok: false, error: "no_token", message: "Brief writer token isn't configured." });
        const auth = req.headers.get("Authorization") || "";
        const tok = auth.replace(/^bearer\s+/i, "").trim();
        if (!tok || tok.length > 200 || !safeEq(await sha256Hex(tok), String(env.HQ_BRIEF_TOKEN_HASH).toLowerCase())) return json(req, 401, { ok: false, error: "bad_token" });
        const body = await readJson(req);
        const brief = cleanBrief(body && body.brief ? body.brief : body);
        if (!brief) return json(req, 400, { ok: false, error: "bad_brief", message: "Need a headline or at least one item." });
        await env.KV.put("hq:brief", JSON.stringify(brief));
        return json(req, 200, { ok: true, brief });
      }
      return json(req, 405, { ok: false, error: "method" });
    }

    return json(req, 404, { ok: false, error: "not_found" });
  }
};
