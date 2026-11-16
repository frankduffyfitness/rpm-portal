/**
 * Bullpen booking API — Vercel Serverless Function
 * RPM Strength Coach Portal (Bullpens tab) and the pitcher page at /pen
 *
 * One mound, Hack watches every pen, a pen is 20 minutes: 3 pitchers per hour.
 * Pitchers pick an HOUR on the days their plan has mound work, not a 20-minute
 * slot; their place in that hour is the order they booked in (Frank, 2026-11-16).
 *
 * Where the plan comes from: Hack's "RPM Pitching Weekly Planner" Google Sheet,
 * read live (link-shared, no login) one week tab at a time. The portal never
 * writes to it. A pitcher can only book a day whose cell is mound work
 * (Bullpen, Mound Blend, Patterning w/ Slope, Live; "?" = maybe, still bookable).
 * Rows under the planner's REMOTE heading are left out.
 *
 * Storage: Upstash Redis (same store as api/training.js).
 *   bp:config            string {sheetId}                 (env PLANNER_SHEET_ID wins)
 *   bp:plan:<monday>     string parsed week, 5 minute cache
 *   bp:planlast:<monday> string last good read, used if Google can't be reached
 *   bp:pitchers          hash   pid -> {name, token, created}   pid = slug of the planner name
 *   bp:tokens            hash   sha256(token) -> pid
 *   bp:b:<date>          hash   pid -> "<HH:MM>|<ISO time booked>"   one booking per pitcher per day
 *   bp:w:<date>:<HH:MM>  list   pids in that hour; RPUSH length is the capacity gate
 *   bp:closed            hash   date -> ["HH:MM", ...] hours Hack closed
 *   bp:req               hash   "<date>|<pid>" -> {pid, name, date, note, at}  "move my pen" requests
 *
 * Auth: `Authorization: Bearer <secret>`.
 *   - STAFF_PASSWORD: the coach, everything.
 *   - a pitcher link key ("p_...", one per pitcher, made the first time he shows
 *     up on the planner): his own days, his own booking. The key is kept so the
 *     coach can copy the link again; "new link" replaces it and kills the old one.
 *   A pitcher never sees another pitcher's name, only how many spots are left.
 *
 * GET  ?op=me                              -> his pen days from today on                pitcher
 * POST {op:"book", date, win}              book or change his hour                      pitcher
 * POST {op:"cancel", date}                                                              pitcher
 * POST {op:"request", date, note?}         ask Hack to move the pen to another day      pitcher
 * POST {op:"unrequest", date}                                                           pitcher
 * GET  ?op=week&monday=YYYY-MM-DD[&fresh=1] -> the week: hours, bookings, plan, links   coach
 * POST {op:"bpBook", pid, date, win} / {op:"bpCancel", pid, date}                       coach
 * POST {op:"bpWindow", date, win, open}    close or reopen an hour                      coach
 * POST {op:"bpReqDone", date, pid}         clear a move request                         coach
 * POST {op:"bpNewLink", pid}               -> {token}                                   coach
 * POST {op:"bpConfig", sheet}              planner link or id -> {posted}               coach
 */
import crypto from "crypto";

const TZ = "America/New_York";
const PEN_MIN = 20;
// Hack's hours by weekday (0 = Sunday). Every hour is a pen window unless he closes it.
const HOURS = { 1: ["15:00", "21:00"], 2: ["15:00", "21:00"], 3: ["15:00", "21:00"], 4: ["15:00", "21:00"], 5: ["15:00", "19:30"], 6: ["09:00", "13:00"] };
const GROUPS = new Set(["high school", "position players", "college", "middle school", "pro", "remote", "men's league", "mens league", "youth"]);
const MOUND = /bullpen|mound|slope|\blive\b/i;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const WIN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PID = /^[a-z0-9][a-z0-9-]{0,80}$/;

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const same = (want, got) => !!want && crypto.timingSafeEqual(Buffer.from(sha(want), "hex"), Buffer.from(sha(got), "hex"));
const parse = (s) => { try { return s == null ? null : JSON.parse(s); } catch { return null; } };
const fail = (status, message) => Object.assign(new Error(message), { status });
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
const flat = (arr) => { const o = {}; for (let i = 0; arr && i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

async function redis(commands) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw fail(500, "Storage is not connected");
  const r = await fetch(`${url}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw fail(502, `Storage error ${r.status}`);
  const out = await r.json();
  const bad = out.find((x) => x && x.error);
  if (bad) throw fail(502, `Storage error: ${bad.error}`);
  return out.map((x) => x.result);
}

// ─── Time (the gym's clock, not the server's) ────────────────────────────────
function nowNY() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute };
}
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const mondayOf = (iso) => addDays(iso, -((dow(iso) + 6) % 7));
const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");

function windowsFor(date, closed) {
  const h = HOURS[dow(date)];
  if (!h) return [];
  const out = [];
  for (let s = toMin(h[0]); s < toMin(h[1]); s += 60) {
    const e = Math.min(s + 60, toMin(h[1]));
    const cap = Math.floor((e - s) / PEN_MIN);
    if (cap > 0) out.push({ win: hhmm(s), end: hhmm(e), cap, closed: (closed || []).includes(hhmm(s)) });
  }
  return out;
}
// A pen still fits if it can start with 20 minutes left in the hour.
const stillOpen = (date, w, now) => date > now.date || (date === now.date && now.min <= toMin(w.end) - PEN_MIN);
const started = (date, win, now) => date < now.date || (date === now.date && now.min >= toMin(win));

// ─── The planner (read only) ─────────────────────────────────────────────────
const slug = (name) => str(name, 80).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const md = (iso) => `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
const tabName = (monday) => `${md(monday)}-${md(addDays(monday, 6))}`;

function csvRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (c !== "\r") cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Asking for a tab that doesn't exist returns the workbook's FIRST tab, so the
// read only counts when the tab's own Monday date (cell C1) matches.
async function fetchPlanner(sheetId, monday) {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&headers=0&range=A1:I250&sheet=${encodeURIComponent(tabName(monday))}`;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok || !/text\/csv/i.test(r.headers.get("content-type") || "")) throw fail(502, "Could not read the pitching planner. Check that it is still shared by link.");
  const rows = csvRows(await r.text());
  const m = /^(\d{1,2})\/(\d{1,2})/.exec(str(rows[0] && rows[0][2], 12));
  if (!m || `${+m[1]}/${+m[2]}` !== md(monday)) return { monday, posted: false, pitchers: [] };
  const by = {};
  let remote = false, group = "";
  for (const row of rows.slice(2)) {
    const name = str(row[0], 80);
    if (!name) continue;
    if (/^mound sessions/i.test(name)) break;
    if (GROUPS.has(name.toLowerCase()) || str(row[1], 20).toLowerCase() === "program link") {
      group = name;
      if (/^remote$/i.test(name)) remote = true;
      continue;
    }
    const pid = slug(name);
    if (remote || !PID.test(pid)) continue;
    const p = (by[pid] = by[pid] || { pid, name, group, pens: {} });
    row.slice(2, 9).forEach((c, i) => {
      const v = str(c, 60);
      if (!v || v[0] === "=" || !MOUND.test(v)) return;
      p.pens[addDays(monday, i)] = { label: v.replace(/\?+\s*$/, "").trim().replace(/bullpen/i, "Bullpen"), maybe: /\?\s*$/.test(v) };
    });
  }
  return { monday, posted: true, pitchers: Object.values(by) };
}

async function config() {
  const [c] = await redis([["GET", "bp:config"]]);
  const cfg = parse(c) || {};
  return { ...cfg, sheetId: process.env.PLANNER_SHEET_ID || cfg.sheetId || null };
}

async function planner(cfg, monday, fresh) {
  if (!cfg.sheetId) return { monday, configured: false, posted: false, pitchers: [] };
  if (!fresh) {
    const [c] = await redis([["GET", `bp:plan:${monday}`]]);
    const p = parse(c);
    if (p) return p;
  }
  try {
    const p = { ...(await fetchPlanner(cfg.sheetId, monday)), configured: true, fetchedAt: new Date().toISOString() };
    const s = JSON.stringify(p);
    await redis([["SET", `bp:plan:${monday}`, s, "EX", 300], ...(p.posted ? [["SET", `bp:planlast:${monday}`, s, "EX", 60 * 60 * 24 * 21]] : [])]);
    return p;
  } catch (e) {
    const [c] = await redis([["GET", `bp:planlast:${monday}`]]);
    const p = parse(c);
    if (p) return { ...p, stale: true };
    throw e;
  }
}

// ─── Bookings ────────────────────────────────────────────────────────────────
const claim = (v) => { const [win, at] = String(v || "").split("|"); return WIN.test(win || "") ? { win, at: at || "" } : null; };

// {date: {closed: [...], byWin: {win: [{pid, at}] in booking order}, mine: {pid: win}}}
async function loadDays(dates) {
  const res = await redis([...dates.map((d) => ["HGETALL", `bp:b:${d}`]), ["HGETALL", "bp:closed"], ["HGETALL", "bp:req"]]);
  const closed = flat(res[dates.length]), reqRaw = flat(res[dates.length + 1]);
  const days = {};
  dates.forEach((d, i) => {
    const byWin = {}, mine = {};
    for (const [pid, v] of Object.entries(flat(res[i]))) {
      const c = claim(v);
      if (!c) continue;
      (byWin[c.win] = byWin[c.win] || []).push({ pid, at: c.at });
      mine[pid] = c.win;
    }
    for (const list of Object.values(byWin)) list.sort((a, b) => a.at.localeCompare(b.at) || a.pid.localeCompare(b.pid));
    days[d] = { closed: parse(closed[d]) || [], byWin, mine };
  });
  const requests = Object.values(reqRaw).map(parse).filter(Boolean);
  return { days, requests };
}

// Book or move. The RPUSH is the gate: it is atomic, so of several pitchers going
// for the last spot only the ones inside the cap keep it.
async function book(pid, date, w) {
  const now = new Date().toISOString();
  const bKey = `bp:b:${date}`, wKey = `bp:w:${date}:${w.win}`;
  const [cur] = await redis([["HGET", bKey, pid]]);
  const had = claim(cur);
  if (had && had.win === w.win) return { ok: true, win: w.win };
  let [len] = await redis([["RPUSH", wKey, pid]]);
  if (len > w.cap) {
    // Full, or the list holds leftovers from an interrupted cancel: check it against the claims.
    const [list, all] = await redis([["LRANGE", wKey, 0, -1], ["HGETALL", bKey]]);
    const claims = flat(all);
    const uniq = [...new Set(list)];
    const stale = uniq.filter((p) => p !== pid && (claim(claims[p]) || {}).win !== w.win);
    const dupes = uniq.filter((p) => !stale.includes(p) && list.filter((x) => x === p).length > 1);
    const fix = [...stale.map((p) => ["LREM", wKey, 0, p]), ...dupes.map((p) => ["LREM", wKey, -(list.filter((x) => x === p).length - 1), p])];
    if (fix.length) await redis(fix);
    const live = uniq.filter((p) => !stale.includes(p));
    if (live.indexOf(pid) >= w.cap) {
      await redis([["LREM", wKey, -1, pid]]);
      throw fail(409, "That hour just filled. Pick another one.");
    }
  }
  await redis([["HSET", bKey, pid, `${w.win}|${now}`], ...(had ? [["LREM", `bp:w:${date}:${had.win}`, 0, pid]] : []), ["HDEL", "bp:req", `${date}|${pid}`]]);
  return { ok: true, win: w.win };
}

async function cancel(pid, date) {
  const [cur] = await redis([["HGET", `bp:b:${date}`, pid]]);
  const had = claim(cur);
  if (had) await redis([["HDEL", `bp:b:${date}`, pid], ["LREM", `bp:w:${date}:${had.win}`, 0, pid]]);
  return { ok: true };
}

// ─── Pitcher view ────────────────────────────────────────────────────────────
async function myPens(who, cfg, now) {
  const mon = mondayOf(now.date);
  const plans = await Promise.all([planner(cfg, mon), planner(cfg, addDays(mon, 7))]);
  const pens = {};
  for (const p of plans) for (const x of p.pitchers) if (x.pid === who.pid) Object.assign(pens, x.pens);
  return { pens, plans };
}

async function me(who) {
  const cfg = await config(), now = nowNY();
  const { pens, plans } = await myPens(who, cfg, now);
  const mon = mondayOf(now.date);
  const dates = Array.from({ length: 14 }, (_, i) => addDays(mon, i)).filter((d) => d >= now.date);
  const { days, requests } = await loadDays(dates);
  const out = [];
  for (const d of dates) {
    const st = days[d], myWin = st.mine[who.pid] || null;
    if (!pens[d] && !myWin) continue;
    const wins = windowsFor(d, st.closed).map((w) => {
      const taken = (st.byWin[w.win] || []).length;
      const left = Math.max(0, w.cap - taken);
      return { win: w.win, end: w.end, cap: w.cap, left, open: !w.closed && left > 0 && stillOpen(d, w, now), mine: w.win === myWin };
    }).filter((w) => w.mine || stillOpen(d, w, now));
    let booking = null;
    if (myWin) {
      const list = st.byWin[myWin] || [], pos = Math.max(0, list.findIndex((x) => x.pid === who.pid));
      const w = windowsFor(d, st.closed).find((x) => x.win === myWin);
      booking = { win: myWin, end: w ? w.end : hhmm(toMin(myWin) + 60), pos: pos + 1, of: list.length, readyAt: hhmm(toMin(myWin) + pos * PEN_MIN), locked: started(d, myWin, now) };
    }
    const req = requests.find((r) => r.date === d && r.pid === who.pid) || null;
    out.push({
      date: d, label: pens[d] ? pens[d].label : null, maybe: !!(pens[d] && pens[d].maybe), offPlan: !pens[d],
      windows: wins, booking, full: !wins.some((w) => w.open), request: req ? { at: req.at, note: req.note || "" } : null,
    });
  }
  return { name: who.name, today: now.date, days: out, posted: plans.some((p) => p.posted), stale: plans.some((p) => p.stale) };
}

// ─── Coach view ──────────────────────────────────────────────────────────────
async function week(monday, fresh) {
  const cfg = await config(), now = nowNY();
  const plan = await planner(cfg, monday, fresh);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const [{ days, requests }, [regRaw]] = await Promise.all([loadDays(dates), redis([["HGETALL", "bp:pitchers"]])]);
  const reg = Object.fromEntries(Object.entries(flat(regRaw)).map(([k, v]) => [k, parse(v)]).filter(([, v]) => v));
  // First time a pitcher has mound work on the planner, make his link.
  const fresh_ = plan.pitchers.filter((p) => Object.keys(p.pens).length && !reg[p.pid]);
  if (fresh_.length) {
    const cmds = [];
    for (const p of fresh_) {
      const token = "p_" + crypto.randomBytes(24).toString("base64url");
      reg[p.pid] = { name: p.name, token, created: new Date().toISOString() };
      cmds.push(["HSET", "bp:pitchers", p.pid, JSON.stringify(reg[p.pid])], ["HSET", "bp:tokens", sha(token), p.pid]);
    }
    await redis(cmds);
  }
  const nameOf = (pid) => (plan.pitchers.find((p) => p.pid === pid) || reg[pid] || {}).name || pid;
  const outDays = dates.map((d) => {
    const st = days[d];
    const planned = plan.pitchers.filter((p) => p.pens[d]).map((p) => ({ pid: p.pid, name: p.name, group: p.group, label: p.pens[d].label, maybe: p.pens[d].maybe, win: st.mine[p.pid] || null }));
    const onPlan = new Set(planned.map((p) => p.pid));
    const windows = windowsFor(d, st.closed).map((w) => ({
      ...w, past: !stillOpen(d, w, now),
      booked: (st.byWin[w.win] || []).map((b, i) => ({ pid: b.pid, name: nameOf(b.pid), readyAt: hhmm(toMin(w.win) + i * PEN_MIN), offPlan: !onPlan.has(b.pid) })),
    }));
    const cap = windows.filter((w) => !w.closed).reduce((n, w) => n + w.cap, 0);
    return { date: d, windows, planned, cap, requests: requests.filter((r) => r.date === d).map((r) => ({ ...r, name: nameOf(r.pid) })) };
  });
  const links = Object.fromEntries(plan.pitchers.filter((p) => reg[p.pid]).map((p) => [p.pid, reg[p.pid].token]));
  return { monday, today: now.date, configured: !!cfg.sheetId, posted: plan.posted, stale: !!plan.stale, fetchedAt: plan.fetchedAt || null, days: outDays, links };
}

// ─── Writes ──────────────────────────────────────────────────────────────────
async function write(body, who) {
  const op = body && body.op;
  const date = DAY.test((body && body.date) || "") ? body.date : null;
  if (who.role === "pitcher") {
    if (!["book", "cancel", "request", "unrequest"].includes(op)) throw fail(403, "Not allowed");
    if (!date) throw fail(400, "Bad day");
    const now = nowNY();
    if (date < now.date) throw fail(400, "That day has passed.");
    if (op === "unrequest") { await redis([["HDEL", "bp:req", `${date}|${who.pid}`]]); return { ok: true }; }
    const [cur] = await redis([["HGET", `bp:b:${date}`, who.pid]]);
    const had = claim(cur);
    if (op === "cancel") {
      if (had && started(date, had.win, now)) throw fail(409, "Your hour has started. Tell Hack in person.");
      return cancel(who.pid, date);
    }
    const { pens } = await myPens(who, await config(), now);
    if (!pens[date]) throw fail(409, "Your plan has no mound work that day. Check with Hack.");
    if (op === "request") {
      const doc = { pid: who.pid, name: who.name, date, note: str(body.note, 300), at: new Date().toISOString() };
      await redis([["HSET", "bp:req", `${date}|${who.pid}`, JSON.stringify(doc)]]);
      return { ok: true };
    }
    if (had && started(date, had.win, now)) throw fail(409, "Your hour has started. Tell Hack in person.");
    const [closed] = await redis([["HGET", "bp:closed", date]]);
    const w = windowsFor(date, parse(closed) || []).find((x) => x.win === body.win);
    if (!w || w.closed) throw fail(409, "That hour isn't open.");
    if (!stillOpen(date, w, now)) throw fail(409, "That hour is too far along. Pick a later one.");
    return book(who.pid, date, w);
  }
  if (who.role !== "coach") throw fail(403, "Not allowed");
  if (op === "bpConfig") {
    const m = /[-\w]{25,}/.exec(str(body.sheet, 300));
    if (!m) throw fail(400, "Paste the planner's Google Sheets link.");
    const monday = mondayOf(nowNY().date);
    const p = await fetchPlanner(m[0], monday);
    await redis([["SET", "bp:config", JSON.stringify({ sheetId: m[0] })], ["DEL", `bp:plan:${monday}`, `bp:plan:${addDays(monday, 7)}`]]);
    return { ok: true, posted: p.posted, pitchers: p.pitchers.length };
  }
  if (op === "bpNewLink") {
    if (!PID.test(body.pid || "")) throw fail(400, "Bad pitcher");
    const [cur] = await redis([["HGET", "bp:pitchers", body.pid]]);
    const rec = parse(cur);
    if (!rec) throw fail(404, "No such pitcher");
    const token = "p_" + crypto.randomBytes(24).toString("base64url");
    await redis([["HDEL", "bp:tokens", sha(rec.token || "")], ["HSET", "bp:tokens", sha(token), body.pid], ["HSET", "bp:pitchers", body.pid, JSON.stringify({ ...rec, token })]]);
    return { token };
  }
  if (!date) throw fail(400, "Bad day");
  if (op === "bpWindow") {
    if (!windowsFor(date, []).some((w) => w.win === body.win)) throw fail(400, "No such hour");
    const [cur] = await redis([["HGET", "bp:closed", date]]);
    const set = new Set(parse(cur) || []);
    body.open ? set.delete(body.win) : set.add(body.win);
    await redis([set.size ? ["HSET", "bp:closed", date, JSON.stringify([...set].sort())] : ["HDEL", "bp:closed", date]]);
    return { ok: true };
  }
  if (!PID.test(body.pid || "")) throw fail(400, "Bad pitcher");
  if (op === "bpReqDone") { await redis([["HDEL", "bp:req", `${date}|${body.pid}`]]); return { ok: true }; }
  if (op === "bpCancel") return cancel(body.pid, date);
  if (op === "bpBook") {
    const w = windowsFor(date, []).find((x) => x.win === body.win);
    if (!w) throw fail(400, "No such hour");
    return book(body.pid, date, w);
  }
  throw fail(400, "Unknown op");
}

// -> {role: "coach"} | {role: "pitcher", pid, name} | null
async function whoIs(req) {
  const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!got || got.length > 200) return null;
  if (same(process.env.STAFF_PASSWORD || "", got)) return { role: "coach" };
  if (!/^p_[A-Za-z0-9_-]{20,}$/.test(got)) return null;
  const [pid] = await redis([["HGET", "bp:tokens", sha(got)]]);
  if (!pid) return null;
  const [rec] = await redis([["HGET", "bp:pitchers", pid]]);
  const r = parse(rec);
  return r && same(r.token || "", got) ? { role: "pitcher", pid, name: r.name } : null;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const who = await whoIs(req);
    if (!who) return res.status(401).json({ error: "Staff password or pitcher link required" });
    if (req.method === "GET") {
      const op = req.query.op;
      if (op === "me" && who.role === "pitcher") return res.status(200).json(await me(who));
      if (who.role !== "coach") throw fail(403, "Not allowed");
      if (op === "week") {
        const monday = DAY.test(req.query.monday || "") ? mondayOf(req.query.monday) : mondayOf(nowNY().date);
        return res.status(200).json(await week(monday, req.query.fresh === "1"));
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
