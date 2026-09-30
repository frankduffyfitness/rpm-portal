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
 *
 * Athlete activity (remote athletes saving from their link, for the coach's "New from athletes"):
 *   activity                 list   newest first, {id, month, keys, at}, capped at 500
 *   activity:seen            hash   athlete id -> ISO time the coach last checked them
 * GET  ?op=activity                      -> {updates: [{id, name, sessions, last}]}       coach
 * POST {op:"activitySeen", id}                                                            coach
 *
 * Remote intake (the questionnaire new remote athletes fill out before their call):
 *   intakes                  hash   intakeId -> {id, label, created, status: sent|draft|submitted,
 *                                   updatedAt, submittedAt, answers}
 *   itoken:<sha256(token)>   string {id}  intake link key -> intake (key starts "i_")
 * POST {op:"createIntake", label}        -> {id, token} (shown once)                     coach
 * GET  ?op=intakes                       -> {intakes: [...]}                               coach
 * POST {op:"deleteIntake", intakeId}                                                      coach
 * GET  ?op=intake                        -> that intake (label, status, answers)           intake link
 * POST {op:"saveIntake", answers, final} saves a draft, or submits when final             intake link
 *
 * Schedule (the Coach Portal's daily schedule; typed in the portal, coach only):
 *   schedule                 hash   eventId -> {id, date, time, type, athlete, coach, notes, created}
 * GET  ?op=schedule&from=YYYY-MM-DD&to=YYYY-MM-DD -> {events, programs}  (programs = open
 *                                   board rows due in the range, shown as "new program" items)
 * POST {op:"scheduleSave", event}        (adds, or updates event.id)  -> {event}          coach
 * POST {op:"scheduleDelete", eventId}                                                     coach
 *
 * Program board (programs due to be written; typed in the portal, coach only):
 *   boardrows                hash   rowId -> {name, athlete?, format, due, coach, done, doneAt, created,
 *                                   draft?, recap?, focus?}
 *                                   draft = note from the Mac's due-day drafting run ("Draft ready ...");
 *                                   recap / focus = the coach's words for the compose (how last month
 *                                   went, what this program should focus on). Each is kept on writes
 *                                   that don't send it (the written check, the drafting run).
 * GET  ?op=board                         -> {rows: [...], status: {rowId: log progress}}   coach
 * POST {op:"boardPut", row}              (adds, or updates row.id)  -> {row}               coach
 * POST {op:"boardDelete", rowId}                                                          coach
 */
import crypto from "crypto";

const ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const SKEY = /^[dm]\d{1,2}w\d{1,2}$/;   // d<day>w<week> lift days, m<n>w<week> movement days
const MAX_JSON = 200 * 1024;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const same = (want, got) => !!want && crypto.timingSafeEqual(Buffer.from(sha(want), "hex"), Buffer.from(sha(got), "hex"));

// -> {role: "coach"} | {role: "athlete", id} | {role: "intake", id} | null
async function whoIs(req) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length > 200) return null;
  if (same(process.env.STAFF_PASSWORD || "", got)) return { role: "coach" };
  if (/^i_[A-Za-z0-9_-]{20,}$/.test(got)) {
    const [rec] = await redis([["GET", `itoken:${sha(got)}`]]);
    const r = parse(rec);
    return r && RID.test(r.id || "") ? { role: "intake", id: r.id } : null;
  }
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

// ─── Program board ───────────────────────────────────────────────────────────
const COACHES = ["Frank", "Alchi", "Ricky"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const bare = (s) => str(s, 120).toLowerCase().normalize("NFKD").replace(/[^a-z\s-]/g, "").replace(/\s+/g, " ").trim();

const RID = /^[a-f0-9]{12}$/;
function cleanRow(r) {
  if (!r || !str(r.name, 60)) throw fail(400, "Board row needs a name");
  return {
    name: str(r.name, 60),
    athlete: ID.test(r.athlete || "") ? r.athlete : null,
    format: str(r.format, 40),
    due: DAY.test(r.due || "") ? r.due : null,
    coach: COACHES.includes(r.coach) ? r.coach : null,
    done: !!r.done,
  };
}

// Board names: a full name, "Last, I." or just "Last" (unique last name). A row can
// also carry the athlete id outright (picked from the portal list).
function matcher(athletes) {
  const list = Object.entries(athletes).filter(([, a]) => a && a.name).map(([id, a]) => {
    const full = bare(a.name);
    return { id, full, first: full.split(" ")[0] || "", pin: a.boardName ? bare(a.boardName) : null };
  });
  return (boardName) => {
    const b = bare(boardName);
    const exact = list.filter((a) => a.full === b || (a.pin && a.pin === b));
    if (exact.length === 1) return exact[0].id;
    let [last, init = ""] = str(boardName, 60).split(",").map(bare);
    if (!init && last.includes(" ")) { const w = last.split(" "); init = w[0]; last = w.slice(1).join(" "); }
    if (!last) return null;
    const hits = list.filter((a) => !a.pin && (a.full === last || a.full.endsWith(" " + last)) && (!init || a.first.startsWith(init[0])));
    return hits.length === 1 ? hits[0].id : null;
  };
}

// Per matched athlete: the newest month with sessions logged, and any newer program.
async function boardStatus(rows) {
  const [ath] = await redis([["HGETALL", "athletes"]]);
  const athletes = pairs(ath);
  const find = matcher(athletes);
  const rowIds = rows.map((r) => [r.id, r.athlete && athletes[r.athlete] ? r.athlete : find(r.name)]).filter((x) => x[1]);
  const ids = [...new Set(rowIds.map((x) => x[1]))];
  const monthLists = ids.length ? await redis(ids.map((id) => ["SMEMBERS", `months:${id}`])) : [];
  const pairsList = ids.flatMap((id, i) => (monthLists[i] || []).sort().map((m) => [id, m]));
  const res = pairsList.length ? await redis(pairsList.flatMap(([id, m]) => [["GET", `program:${id}:${m}`], ["HGETALL", `log:${id}:${m}`]])) : [];
  const per = {};
  pairsList.forEach(([id, m], i) => {
    const prog = parse(res[2 * i]), log = pairs(res[2 * i + 1]);
    const done = (s) => s && !s.skipped && (s.load != null || s.reps != null || s.done);
    const logged = Object.entries(log).filter(([k, s]) => k[0] === "d" && s && Object.values(s.entries || {}).some((cells) => (cells || []).some(done))).length;
    (per[id] = per[id] || []).push({ month: m, logged, total: ((prog && prog.days) || []).length * 4 });
  });
  const info = {};
  for (const id of ids) {
    const ms = per[id] || [];
    const withLogs = ms.filter((x) => x.logged > 0);
    const cur = withLogs[withLogs.length - 1] || ms[ms.length - 1];
    if (!cur) continue;
    const next = ms.filter((x) => x.month > cur.month).map((x) => x.month);
    info[id] = { id, name: athletes[id].name, month: cur.month, logged: cur.logged, total: cur.total, next };
  }
  const status = {};
  for (const [rid, id] of rowIds) if (info[id]) status[rid] = info[id];
  return status;
}

// Unseen athlete saves, one entry per athlete, each session listed once (latest save).
async function activity() {
  const [list, seen, ath] = await redis([["LRANGE", "activity", 0, 499], ["HGETALL", "activity:seen"], ["HGETALL", "athletes"]]);
  const seenAt = {};
  for (let i = 0; seen && i < seen.length; i += 2) seenAt[seen[i]] = seen[i + 1];
  const athletes = pairs(ath), by = {};
  for (const raw of list || []) {
    const e = parse(raw);
    if (!e || !athletes[e.id] || (seenAt[e.id] && e.at <= seenAt[e.id])) continue;
    const u = (by[e.id] = by[e.id] || { id: e.id, name: athletes[e.id].name, last: e.at, sessions: [] });
    for (const key of e.keys || []) if (!u.sessions.some((x) => x.month === e.month && x.key === key)) u.sessions.push({ month: e.month, key, at: e.at });
  }
  return { updates: Object.values(by).sort((a, b) => b.last.localeCompare(a.last)) };
}

const publicIntake = (r) => {
  const { tokenHash, ...rest } = r || {};
  return rest;
};

async function intakeList() {
  const [h] = await redis([["HGETALL", "intakes"]]);
  const list = Object.values(pairs(h)).filter(Boolean).map(publicIntake);
  return { intakes: list.sort((a, b) => (b.submittedAt || b.updatedAt || b.created).localeCompare(a.submittedAt || a.updatedAt || a.created)) };
}

async function intakeSave(id, body) {
  const [cur] = await redis([["HGET", "intakes", id]]);
  const rec = parse(cur);
  if (!rec) throw fail(404, "This intake link was removed. Ask RPM for a new one.");
  const answers = body && typeof body.answers === "object" && !Array.isArray(body.answers) ? body.answers : null;
  if (!answers) throw fail(400, "Bad answers");
  const now = new Date().toISOString();
  const next = { ...rec, answers, updatedAt: now };
  if (body.final) { next.status = "submitted"; next.submittedAt = now; }
  else if (rec.status !== "submitted") next.status = "draft";
  await redis([["HSET", "intakes", id, json(next)]]);
  return { ok: true, status: next.status, updatedAt: now };
}

async function boardRows() {
  const [h] = await redis([["HGETALL", "boardrows"]]);
  return Object.entries(pairs(h)).filter(([, r]) => r).map(([id, r]) => ({ id, ...r }));
}

async function write(body, who) {
  const { op, month } = body || {};
  if (op === "scheduleSave" || op === "scheduleDelete") {
    if (who.role !== "coach") throw fail(403, "Not allowed");
    if (op === "scheduleDelete") {
      if (!RID.test(body.eventId || "")) throw fail(400, "Bad event");
      await redis([["HDEL", "schedule", body.eventId]]);
      return { ok: true };
    }
    const e = body.event || {};
    if (!DAY.test(e.date || "")) throw fail(400, "Event needs a date");
    if (!str(e.type, 40)) throw fail(400, "Event needs a type");
    const eid = RID.test(e.id || "") ? e.id : crypto.randomBytes(6).toString("hex");
    const [cur] = await redis([["HGET", "schedule", eid]]);
    const prev = parse(cur) || {};
    const doc = {
      id: eid, date: e.date, time: /^\d{2}:\d{2}$/.test(e.time || "") ? e.time : null,
      type: str(e.type, 40), athlete: str(e.athlete, 80), coach: COACHES.includes(e.coach) ? e.coach : null,
      notes: str(e.notes, 1000), created: prev.created || new Date().toISOString(),
    };
    await redis([["HSET", "schedule", eid, json(doc)]]);
    return { event: doc };
  }
  if (op === "createIntake" || op === "deleteIntake") {
    if (who.role !== "coach") throw fail(403, "Not allowed");
    if (op === "deleteIntake") {
      if (!RID.test(body.intakeId || "")) throw fail(400, "Bad intake");
      const [cur] = await redis([["HGET", "intakes", body.intakeId]]);
      const rec = parse(cur);
      await redis([["HDEL", "intakes", body.intakeId], ...(rec && rec.tokenHash ? [["DEL", `itoken:${rec.tokenHash}`]] : [])]);
      return { ok: true };
    }
    const iid = crypto.randomBytes(6).toString("hex");
    const token = "i_" + crypto.randomBytes(24).toString("base64url");
    const h = sha(token);
    const doc = { id: iid, label: str(body.label, 80) || "New athlete", created: new Date().toISOString(), status: "sent", tokenHash: h };
    await redis([["HSET", "intakes", iid, json(doc)], ["SET", `itoken:${h}`, json({ id: iid })]]);
    return { id: iid, token };
  }
  if (op === "boardPut" || op === "boardDelete") {
    if (who.role !== "coach") throw fail(403, "Not allowed");
    if (op === "boardDelete") {
      if (!RID.test(body.rowId || "")) throw fail(400, "Bad row");
      await redis([["HDEL", "boardrows", body.rowId]]);
      return { ok: true };
    }
    const row = cleanRow(body.row);
    const rid = RID.test((body.row && body.row.id) || "") ? body.row.id : crypto.randomBytes(6).toString("hex");
    const [cur] = await redis([["HGET", "boardrows", rid]]);
    const prev = parse(cur) || {};
    const now = new Date().toISOString();
    const keep = (k, n) => (k in body.row ? String(body.row[k] == null ? "" : body.row[k]).trim().slice(0, n) || null : prev[k] || null);
    const doc = { ...row, draft: keep("draft", 200), recap: keep("recap", 4000), focus: keep("focus", 4000), created: prev.created || now, doneAt: row.done ? prev.doneAt || now : null };
    await redis([["HSET", "boardrows", rid, json(doc)]]);
    return { row: { id: rid, ...doc } };
  }
  const id = who.role === "athlete" ? who.id : body && body.id;  // a link only ever writes its own athlete
  if (!ID.test(id || "")) throw fail(400, "Bad athlete id");
  if (who.role === "athlete" && op !== "saveSessions") throw fail(403, "Not allowed");
  if (op === "activitySeen") {
    await redis([["HSET", "activity:seen", id, new Date().toISOString()]]);
    return { ok: true };
  }
  if (op === "saveSessions") {
    if (!MONTH.test(month || "")) throw fail(400, "Bad month");
    const entries = Object.entries(body.sessions || {});
    if (!entries.length || entries.some(([k]) => !SKEY.test(k))) throw fail(400, "Bad sessions");
    const [exists] = await redis([["SISMEMBER", `months:${id}`, month]]);
    if (!exists) throw fail(404, "No program for that month");
    const now = new Date().toISOString();
    const by = who.role === "athlete" ? { by: "athlete" } : {};
    const cmds = [["HSET", `log:${id}:${month}`, ...entries.flatMap(([k, v]) => [k, json({ ...v, ...by, updatedAt: now })])]];
    if (who.role === "athlete") cmds.push(["LPUSH", "activity", json({ id, month, keys: entries.map(([k]) => k), at: now })], ["LTRIM", "activity", 0, 499]);
    await redis(cmds);
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
    if (who.role === "intake") {
      if (req.method === "GET" && req.query.op === "intake") {
        const [cur] = await redis([["HGET", "intakes", who.id]]);
        const rec = parse(cur);
        if (!rec) throw fail(404, "This intake link was removed. Ask RPM for a new one.");
        const { label, status, answers, submittedAt, updatedAt } = rec;
        return res.status(200).json({ label, status, answers: answers || {}, submittedAt: submittedAt || null, updatedAt: updatedAt || null });
      }
      if (req.method === "POST") {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (!body || body.op !== "saveIntake") throw fail(403, "Not allowed");
        return res.status(200).json(await intakeSave(who.id, body));
      }
      throw fail(403, "Not allowed");
    }
    if (req.method === "GET") {
      const op = req.query.op;
      if (op === "me" && who.role === "athlete") return res.status(200).json(await athlete(who.id));
      if (who.role !== "coach") throw fail(403, "Not allowed");
      if (op === "index") return res.status(200).json(await index());
      if (op === "activity") return res.status(200).json(await activity());
      if (op === "intakes") return res.status(200).json(await intakeList());
      if (op === "schedule") {
        const from = DAY.test(req.query.from || "") ? req.query.from : null, to = DAY.test(req.query.to || "") ? req.query.to : null;
        if (!from || !to) throw fail(400, "Bad range");
        const [h] = await redis([["HGETALL", "schedule"]]);
        const events = Object.values(pairs(h)).filter((e) => e && e.date >= from && e.date <= to);
        const programs = (await boardRows()).filter((r) => !r.done && r.due && r.due >= from && r.due <= to)
          .map((r) => ({ id: r.id, due: r.due, name: r.name, format: r.format, coach: r.coach, draft: r.draft || null }));
        return res.status(200).json({ events, programs });
      }
      if (op === "board") {
        const rows = await boardRows();
        return res.status(200).json({ rows, status: await boardStatus(rows) });
      }
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
