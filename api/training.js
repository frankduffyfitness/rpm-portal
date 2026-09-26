/**
 * Training log API — Vercel Serverless Function
 * RPM Strength Coach Portal (Training tab)
 *
 * Storage: Upstash Redis (Vercel Marketplace, env KV_REST_API_URL / KV_REST_API_TOKEN).
 *   athletes                 hash   id -> athlete JSON {name, trainingMax?, compStance?, ...}
 *   months:<id>              set    program months, "YYYY-MM"
 *   program:<id>:<month>     string program JSON (days -> exercises -> weeks)
 *   log:<id>:<month>         hash   "d<day>w<week>" (lift day) or "m<n>w<week>"
 *                                   (movement day n) -> session JSON
 * One hash field per session, so saving one session never touches another.
 *
 *   atoken:<sha256(token)>   string {id, created}  athlete link key -> athlete
 *   atokens:<id>             set    that athlete's key hashes (for "turn off links")
 *
 * Auth: `Authorization: Bearer <secret>`. The secret is either
 *   - STAFF_PASSWORD (Vercel env, Sensitive): the coach, every athlete and op; or
 *   - an athlete link key (random, made by createLink, stored only as a hash): that one
 *     athlete, read their own log and save their own sessions, nothing else.
 * Nothing here is public: the data never ships in the page bundle.
 *
 * GET  ?op=index                         -> {athletes: [{id, name, months}]}          coach
 * GET  ?op=athlete&id=<id>               -> {athlete, programs, logs}                 coach
 * GET  ?op=me                            -> same shape, for the link's athlete        athlete
 * GET  ?op=linkStatus&id=<id>            -> {links: n}                                coach
 * POST {op:"saveSessions", id, month, sessions: {key: session}}                       coach, athlete (own id)
 * POST {op:"patchAthlete", id, data}     (merges fields, e.g. compStance)             coach
 * POST {op:"putAthlete", id, data}       (replaces; loader scripts)                   coach
 * POST {op:"putProgram", id, month, doc} (replaces; loader scripts)                   coach
 * POST {op:"createLink", id}             -> {token} (shown once)                      coach
 * POST {op:"revokeLinks", id}            turns off every link for that athlete        coach
 */
import crypto from "crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SKEY = /^[dm]\d{1,2}w\d{1,2}$/;   // d<day>w<week> lift days, m<n>w<week> movement days
const MAX_JSON = 200 * 1024;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

// -> {role: "coach"} | {role: "athlete", id} | null
async function whoIs(req) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length > 200) return null;
  const want = process.env.STAFF_PASSWORD || "";
  if (want && crypto.timingSafeEqual(Buffer.from(sha(want), "hex"), Buffer.from(sha(got), "hex"))) return { role: "coach" };
  if (!/^a_[A-Za-z0-9_-]{20,}$/.test(got)) return null;
  const [rec] = await redis([["GET", `atoken:${sha(got)}`]]);
  const r = parse(rec);
  return r && ID.test(r.id || "") ? { role: "athlete", id: r.id } : null;
}

async function redis(commands) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw Object.assign(new Error("Storage is not connected"), { status: 500 });
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw Object.assign(new Error(`Storage error ${r.status}`), { status: 502 });
  const out = await r.json();
  const bad = out.find((x) => x && x.error);
  if (bad) throw Object.assign(new Error(`Storage error: ${bad.error}`), { status: 502 });
  return out.map((x) => x.result);
}

const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const pairs = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = parse(arr[i + 1]); return o; };
const json = (v) => { const s = JSON.stringify(v); if (s.length > MAX_JSON) throw Object.assign(new Error("Too large"), { status: 413 }); return s; };
const fail = (status, message) => Object.assign(new Error(message), { status });

async function index() {
  const [ath] = await redis([["HGETALL", "athletes"]]);
  const athletes = pairs(ath);
  const ids = Object.keys(athletes);
  const months = ids.length ? await redis(ids.map((id) => ["SMEMBERS", `months:${id}`])) : [];
  return { athletes: ids.map((id, i) => ({ id, ...athletes[id], months: (months[i] || []).sort() })) };
}

async function athlete(id) {
  if (!ID.test(id || "")) throw fail(400, "Bad athlete id");
  const [a, months] = await redis([["HGET", "athletes", id], ["SMEMBERS", `months:${id}`]]);
  if (!a) throw fail(404, "No such athlete");
  const ms = (months || []).sort();
  const res = ms.length ? await redis(ms.flatMap((m) => [["GET", `program:${id}:${m}`], ["HGETALL", `log:${id}:${m}`]])) : [];
  const programs = {}, logs = {};
  ms.forEach((m, i) => { programs[m] = parse(res[2 * i]); logs[m] = pairs(res[2 * i + 1]); });
  return { athlete: { id, ...parse(a) }, programs, logs };
}

async function write(body, who) {
  const { op, month } = body || {};
  const id = who.role === "athlete" ? who.id : body && body.id;  // a link only ever writes its own athlete
  if (!ID.test(id || "")) throw fail(400, "Bad athlete id");
  if (who.role === "athlete" && op !== "saveSessions") throw fail(403, "Not allowed");
  if (op === "saveSessions") {
    if (!MONTH.test(month || "")) throw fail(400, "Bad month");
    const entries = Object.entries(body.sessions || {});
    if (!entries.length || entries.some(([k]) => !SKEY.test(k))) throw fail(400, "Bad sessions");
    const [exists] = await redis([["SISMEMBER", `months:${id}`, month]]);
    if (!exists) throw fail(404, "No program for that month");
    const now = new Date().toISOString();
    await redis([["HSET", `log:${id}:${month}`, ...entries.flatMap(([k, v]) => [k, json({ ...v, updatedAt: now })])]]);
    return { ok: true, updatedAt: now };
  }
  if (op === "patchAthlete") {
    const [cur] = await redis([["HGET", "athletes", id]]);
    if (!cur) throw fail(404, "No such athlete");
    const allowed = ["compStance"];  // the page only ever changes these
    const patch = Object.fromEntries(Object.entries(body.data || {}).filter(([k]) => allowed.includes(k)));
    await redis([["HSET", "athletes", id, json({ ...parse(cur), ...patch })]]);
    return { ok: true };
  }
  if (op === "putAthlete") {
    if (!body.data || typeof body.data.name !== "string") throw fail(400, "Athlete needs a name");
    await redis([["HSET", "athletes", id, json(body.data)]]);
    return { ok: true };
  }
  if (op === "putProgram") {
    if (!MONTH.test(month || "") || !body.doc || !Array.isArray(body.doc.days)) throw fail(400, "Bad program");
    await redis([["SET", `program:${id}:${month}`, json(body.doc)], ["SADD", `months:${id}`, month]]);
    return { ok: true };
  }
  if (op === "createLink") {
    const [a] = await redis([["HGET", "athletes", id]]);
    if (!a) throw fail(404, "No such athlete");
    const token = "a_" + crypto.randomBytes(24).toString("base64url");
    const h = sha(token);
    await redis([["SET", `atoken:${h}`, json({ id, created: new Date().toISOString() })], ["SADD", `atokens:${id}`, h]]);
    return { token };
  }
  if (op === "revokeLinks") {
    const [hashes] = await redis([["SMEMBERS", `atokens:${id}`]]);
    await redis([...(hashes || []).map((h) => ["DEL", `atoken:${h}`]), ["DEL", `atokens:${id}`]]);
    return { ok: true, revoked: (hashes || []).length };
  }
  throw fail(400, "Unknown op");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const who = await whoIs(req);
    if (!who) return res.status(401).json({ error: "Staff password or athlete link required" });
    if (req.method === "GET") {
      const op = req.query.op;
      if (op === "me" && who.role === "athlete") return res.status(200).json(await athlete(who.id));
      if (who.role !== "coach") throw fail(403, "Not allowed");
      if (op === "index") return res.status(200).json(await index());
      if (op === "athlete") return res.status(200).json(await athlete(req.query.id));
      if (op === "linkStatus") {
        if (!ID.test(req.query.id || "")) throw fail(400, "Bad athlete id");
        const [n] = await redis([["SCARD", `atokens:${req.query.id}`]]);
        return res.status(200).json({ links: n || 0 });
      }
      throw fail(400, "Unknown op");
    }
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      return res.status(200).json(await write(body, who));
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || "Server error" });
  }
}
