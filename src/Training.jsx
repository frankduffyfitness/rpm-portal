// ─── Training (coach portal) ─────────────────────────────────────────────────
// Logging + progress for athletes' RPM programs. Data lives server-side
// (api/training.js → Upstash Redis) behind the staff password; nothing here ships
// in the public bundle. CMJ / bodyweight / velo come from the portal's own inline
// data, passed in as `ctx` by App.jsx (this file is never touched by the 6-hour
// generator, which only splices const markers in App.jsx).
import { useEffect, useMemo, useRef, useState } from "react";

const PW_KEY = "rpm_staff_pw";
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STANCE = { sumo: "Sumo", conventional: "Conventional" };
const monShort = (m) => MON[+m.slice(5) - 1];
const round5 = (x) => Math.round(x / 5) * 5;
const other = (s) => (s === "sumo" ? "conventional" : s === "conventional" ? "sumo" : null);
const skey = (day, week) => `d${day}w${week}`;
const todayIso = () => new Date().toLocaleDateString("en-CA");
const shortDate = (iso) => (iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
const mdyToIso = (s) => { const [m, d, y] = s.split("/"); return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`; };
const setDone = (s) => !!s && !s.skipped && (s.load != null || s.reps != null || !!s.done);
const accounted = (s) => setDone(s) || !!(s && s.skipped);
const repsOf = (s, wk) => (s.reps != null ? s.reps : wk.repsN ?? null);
// Bodyweight = no implement in the name (DB, KB, barbell, cable, band, sled...). Those
// sets get a check-off instead of a weight box; loaded lifts keep the weight box.
const LOADED = /\b(db|kb|dumbbells?|kettlebells?|barbell|ssb|trap bar|hex bar|ez bar|cable|band|landmine|sled|plate|medicine ball|med ball|machine|weighted|water ball|chains?|bat|fat gripz|sandbag|goblet|farmers?|carry|pallof|chop|rope|vest|rack|deadlift|front squat|back squat|good morning|clean|snatch|jerk)\b|\d-(kb|db)\b/i;
const isBodyweight = (name) => !LOADED.test(name || "");
const isAmrap = (reps) => /amrap/i.test(String(reps || ""));
const num = (v) => { const x = parseFloat(String(v).replace(",", ".")); return Number.isFinite(x) ? x : null; };

// ─── API ─────────────────────────────────────────────────────────────────────
function getPw() { try { return localStorage.getItem(PW_KEY) || ""; } catch (e) { return ""; } }
function setPw(v) { try { v ? localStorage.setItem(PW_KEY, v) : localStorage.removeItem(PW_KEY); } catch (e) {} }
async function api(pw, { query, body }) {
  const r = await fetch("/api/training" + (query ? "?" + new URLSearchParams(query) : ""), {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + pw, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: r.status });
  return data;
}

// ─── Program logic (same rules as the old Training Log page) ─────────────────
function model(A) {
  const months = Object.values(A.programs).filter(Boolean).sort((a, b) => a.month.localeCompare(b.month));
  const logOf = (month, day, week) => (A.logs[month] || {})[skey(day, week)];
  const resolveStance = (code) => {
    const comp = A.athlete.compStance || null;
    if (code === "comp") return comp;
    if (code === "secondary") return other(comp);
    return code || null;
  };
  const stanceFor = (month, day, week, ex, wk, log) => {
    const l = log || logOf(month, day, week);
    return (l && l.stance && l.stance[ex.slot]) || resolveStance(wk.stance);
  };
  const bestSingle = (month, key) => {
    const prog = A.programs[month];
    if (!prog) return null;
    let best = null;
    for (const d of prog.days) for (const ex of d.exercises) {
      if (ex.key !== key) continue;
      for (const wk of ex.weeks) {
        const log = logOf(month, d.day, wk.w);
        for (const s of (log && log.entries && log.entries[ex.slot]) || []) {
          if (setDone(s) && s.load != null && repsOf(s, wk) === 1 && (!best || s.load > best.load))
            best = { load: s.load, stance: stanceFor(month, d.day, wk.w, ex, wk), week: wk.w };
        }
      }
    }
    return best;
  };
  const basisOf = (prog) => {
    const b = prog.loadBasis || { type: "tm" };
    if (b.type === "tm") return { value: A.athlete.trainingMax ?? null, label: "training max", b };
    const best = bestSingle(b.source, b.key);
    return { value: best ? best.load : null, best, label: b.label, b };
  };
  const targetOf = (prog, wk) => {
    if (wk.target) return wk.target;
    if (!wk.pct) return null;
    const base = basisOf(prog).value;
    return base ? wk.pct.map((p) => round5(p * base)) : null;
  };
  const sessionStats = (prog, day, week) => {
    const d = prog.days.find((x) => x.day === day);
    const log = logOf(prog.month, day, week);
    let rx = 0, done = 0;
    for (const ex of d.exercises) {
      const wk = ex.weeks.find((w) => w.w === week);
      if (!wk) continue;
      rx += wk.sets;
      done += Math.min(wk.sets, ((log && log.entries && log.entries[ex.slot]) || []).filter(accounted).length);
    }
    return { rx, done };
  };
  const sessions = [];
  months.forEach((p, mi) => { for (let w = 1; w <= 4; w++) for (const d of p.days) sessions.push({ month: p.month, day: d.day, week: w, order: mi * 100 + w * 10 + d.day }); });
  const orderOf = (month, day, week) => (sessions.find((s) => s.month === month && s.day === day && s.week === week) || {}).order ?? -1;
  const nextSession = () => sessions.find((s) => sessionStats(A.programs[s.month], s.day, s.week).done === 0) || null;
  const lastTime = (ex, cur) => {
    const curOrder = orderOf(cur.month, cur.day, cur.week);
    for (const s of sessions.filter((x) => x.order < curOrder).reverse()) {
      const log = logOf(s.month, s.day, s.week);
      if (!log || !log.entries) continue;
      const d = A.programs[s.month].days.find((x) => x.day === s.day);
      const match = d.exercises.find((e) => (ex.key ? e.key === ex.key && e.role === ex.role : e.name === ex.name));
      if (!match) continue;
      const sets = (log.entries[match.slot] || []).filter(setDone);
      if (!sets.length) continue;
      const wk = match.weeks.find((w) => w.w === s.week) || {};
      return { s, sets: sets.map((x) => ({ load: x.load, reps: repsOf(x, wk) })) };
    }
    return null;
  };
  return { months, logOf, resolveStance, stanceFor, bestSingle, basisOf, targetOf, sessionStats, sessions, orderOf, nextSession, lastTime };
}

function fmtSets(sets) {
  const parts = sets.map((x) => (x.load != null ? (x.reps != null ? `${x.load}×${x.reps}` : `${x.load}`) : x.reps != null ? `BW×${x.reps}` : "done"));
  const g = [];
  for (const p of parts) { const last = g[g.length - 1]; if (last && last.p === p) last.n++; else g.push({ p, n: 1 }); }
  return g.map((x) => (x.n > 1 ? `${x.p} (${x.n} sets)` : x.p)).join(", ");
}

function liftRows(A, M) {
  const cols = M.months.length * 4, rows = new Map();
  M.months.forEach((p, mi) => p.days.forEach((d) => d.exercises.forEach((ex) => ex.weeks.forEach((wk) => {
    const log = M.logOf(p.month, d.day, wk.w) || {};
    const name = ex.key === "deadlift" ? (ex.role === "heavy" ? "Deadlift, heavy day" : "Deadlift, speed day") : ((log.swaps || {})[ex.slot] || ex.name);
    if (!rows.has(name)) rows.set(name, { name, pts: Array(cols).fill(null), last: null, lastOrder: -1, e1rm: null });
    const row = rows.get(name);
    const sets = ((log.entries || {})[ex.slot] || []).filter((s) => setDone(s) && s.load > 0);
    if (!sets.length) return;
    const wi = mi * 4 + wk.w - 1, top = sets.reduce((m, s) => (s.load > m.load ? s : m));
    if (row.pts[wi] == null || top.load > row.pts[wi]) row.pts[wi] = top.load;
    if (wi * 10 + d.day > row.lastOrder) { row.lastOrder = wi * 10 + d.day; row.last = [top.load, repsOf(top, wk)]; }
    sets.forEach((s) => { const r = repsOf(s, wk); if (r && r <= 10) row.e1rm = Math.max(row.e1rm || 0, s.load * (1 + r / 30)); });
  }))));
  return [...rows.values()].filter((r) => r.pts.some((v) => v != null));
}

// ─── Styles (portal look: #0A0C10, DM Sans, mint #4FFFB0) ───────────────────
const CSS = `
.tl{--ink:#fff;--ink2:#E0E0E0;--mut:#6B7280;--mut2:#8A8F98;--faint:#4A4F57;--rule:rgba(255,255,255,.06);--rule2:rgba(255,255,255,.12);--acc:#4FFFB0;--accd:rgba(79,255,176,.12);--sumo:#60A5FA;--conv:#FFB020;--warn:#FF6B6B;--field:#13161B}
.tl *{box-sizing:border-box}
.tl button,.tl input,.tl textarea,.tl select{font:inherit;color:inherit}
.tl button{cursor:pointer}
.tl :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.tl .tabs{display:flex;gap:5px;margin:14px 0}
.tl .tabs button{padding:7px 12px;border:1px solid var(--rule);border-radius:8px;font-size:11px;font-weight:600;background:rgba(255,255,255,.02);color:var(--mut)}
.tl .tabs button[aria-pressed=true]{border-color:var(--acc);background:var(--accd);color:var(--acc)}
.tl .months{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px}
.tl .mh{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mut2);margin-bottom:5px;display:flex;justify-content:space-between}
.tl .mh span{color:var(--mut);letter-spacing:0;text-transform:none}
.tl .mgrid{display:grid;gap:3px;align-items:center}
.tl .lab{font-size:9px;color:var(--faint);font-weight:600}
.tl .cell{height:28px;border:1px solid var(--rule);background:rgba(255,255,255,.03);border-radius:6px;font-size:10px;font-weight:600;color:var(--mut);padding:0;position:relative}
.tl .cell.partial{background:rgba(79,255,176,.22);border-color:transparent;color:var(--ink)}
.tl .cell.done{background:var(--acc);border-color:var(--acc);color:#0A0C10}
.tl .cell.next::after{content:"";position:absolute;inset:3px;border:1.5px dashed var(--acc);border-radius:4px}
.tl .cell[aria-current=true]{outline:2px solid var(--ink);outline-offset:2px}
.tl .key{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11px;color:var(--mut);margin-top:10px}
.tl .key i{display:inline-block;width:12px;height:9px;border:1px solid var(--rule2);border-radius:3px;margin-right:5px;vertical-align:-1px}
.tl .key i.p{background:rgba(79,255,176,.22);border-color:transparent}.tl .key i.d{background:var(--acc);border-color:var(--acc)}.tl .key i.n{border-style:dashed;border-color:var(--acc)}
.tl .logger{margin-top:16px;background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.05);border-radius:14px}
.tl .lhead{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:flex-end;justify-content:space-between;padding:14px}
.tl .lhead .eb{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--acc)}
.tl .lhead h3{margin:3px 0 0;font-size:22px;font-weight:800;color:var(--ink)}
.tl .meta{display:flex;flex-wrap:wrap;gap:10px}
.tl .field{display:grid;gap:3px}
.tl .field label{font-size:9px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--mut)}
.tl .field input{border:1px solid var(--rule2);border-radius:10px;background:var(--field);color:var(--ink);padding:7px 9px;min-width:0;font-size:13px}
.tl .field input[type=number]{width:88px}
.tl .src{font-size:10px;color:var(--mut)}
.tl .dpick{display:flex;flex-wrap:wrap;gap:5px;align-items:center;font-size:11px;color:var(--mut);flex-basis:100%}
.tl details{padding:10px 14px;border-top:1px solid var(--rule);font-size:12px;color:var(--mut2)}
.tl summary{cursor:pointer;font-weight:600;color:var(--ink2)}
.tl details ul{margin:6px 0 0;padding-left:18px}
.tl .ex{padding:14px;border-top:1px solid var(--rule)}
.tl .extop{display:flex;flex-wrap:wrap;justify-content:space-between;gap:2px 12px;align-items:baseline}
.tl .exname{font-weight:700;font-size:14px;color:var(--ink);display:inline-flex;flex-wrap:wrap;gap:7px;align-items:center}
.tl .slot{color:var(--faint);font-weight:800;margin-right:2px}
.tl .rx{font-size:12px;color:var(--mut2)}
.tl .rx b{color:var(--acc)}
.tl .note{font-size:12px;color:var(--mut);margin-top:3px}
.tl .note b{color:var(--ink2)}
.tl .last{font-size:11px;color:var(--mut);margin-top:3px}
.tl .last b{color:var(--mut2)}
.tl .seg{display:inline-flex;gap:3px;padding:3px;background:rgba(255,255,255,.03);border-radius:10px}
.tl .seg button{background:transparent;border:0;border-radius:8px;padding:3px 9px;font-size:11px;font-weight:600;color:var(--mut);display:inline-flex;gap:5px;align-items:center}
.tl .seg button[aria-pressed=true]{background:var(--accd);color:var(--acc)}
.tl .dot{width:8px;height:8px;border-radius:50%;background:var(--sumo);display:inline-block}
.tl .sq{width:8px;height:8px;background:var(--conv);display:inline-block}
.tl .sets{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px;align-items:flex-start}
.tl .set{display:grid;width:62px;border:1px solid var(--rule2);border-radius:10px;background:var(--field);overflow:hidden}
.tl .set.filled{border-color:rgba(79,255,176,.35);background:rgba(79,255,176,.05)}
.tl .set .n{font-size:9px;color:var(--mut);text-align:center;padding-top:3px;font-weight:600}
.tl .set input{border:0;background:transparent;text-align:center;width:100%;color:var(--ink);font-variant-numeric:tabular-nums}
.tl .set input.load{font-size:16px;font-weight:700;padding:0 2px 2px}
.tl .set input.reps{font-size:11px;color:var(--mut2);border-top:1px dashed var(--rule2);padding:3px 2px 4px}
.tl .set input::placeholder{color:var(--faint)}
.tl .set .rt{font-size:10px;color:var(--mut);text-align:center;border:0;border-top:1px dashed var(--rule2);background:transparent;padding:4px 2px 5px;line-height:1.2;width:100%}
.tl .set .rt[aria-pressed=true]{color:var(--acc);font-weight:700}
.tl .set.bw .chk{border:0;background:transparent;font-size:20px;line-height:1;padding:4px 0 5px;color:var(--faint);cursor:pointer}
.tl .set.bw .chk[aria-pressed=true]{color:var(--acc);font-weight:800}
.tl .set.bw div.rt{border-top:1px dashed var(--rule2)}
.tl .set.skipped{border-style:dashed;background:transparent;padding:0 0 5px;justify-items:center;align-content:start;color:var(--mut)}
.tl .set.skipped .x{font-size:16px;line-height:1.3;color:var(--warn)}
.tl .set.skipped .sk{font-size:10px}
.tl .tools{display:flex;flex-direction:column;gap:5px}
.tl .tools .pm{display:flex;gap:5px}
.tl .tb{border:1px solid var(--rule2);background:rgba(255,255,255,.02);border-radius:8px;padding:4px 9px;font-size:11px;font-weight:600;color:var(--mut2);white-space:nowrap}
.tl .tb:hover{border-color:var(--acc);color:var(--acc);background:var(--accd)}
.tl .rpe{width:50px}
.tl .rpe input{border:1px solid var(--rule2);border-radius:8px;background:var(--field);color:var(--ink);width:100%;text-align:center;padding:5px 2px;font-size:12px}
.tl .rpe label{font-size:9px;color:var(--mut);display:block;text-align:center;font-weight:600}
.tl .callout{margin-top:9px;font-size:12px;background:#16191E;border:1px solid var(--rule);border-radius:10px;padding:8px 10px;color:var(--mut2)}
.tl .callout b{color:var(--ink)}
.tl .foot{padding:12px 14px 14px;border-top:1px solid var(--rule);display:grid;gap:5px}
.tl .foot textarea{width:100%;min-height:60px;border:1px solid var(--rule2);border-radius:10px;background:var(--field);color:var(--ink);padding:8px 10px;resize:vertical;font-size:13px}
.tl .toast{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:50;background:var(--acc);color:#0A0C10;font-size:12px;font-weight:700;padding:7px 14px;border-radius:999px;pointer-events:none}
.tl .toast.bad{background:var(--warn);color:#fff}
`;

// ─── Small pieces ────────────────────────────────────────────────────────────
function Spark({ pts, color = "#E0E0E0", w = 120, h = 28 }) {
  const vals = pts.filter((v) => v != null);
  if (!vals.length) return <svg width={w} height={h} />;
  const lo = Math.min(...vals), hi = Math.max(...vals), rng = hi - lo || 1;
  const X = (i) => 3 + (pts.length > 1 ? (i / (pts.length - 1)) * (w - 6) : (w - 6) / 2);
  const Y = (v) => (vals.length === 1 ? h / 2 : h - 4 - ((v - lo) / rng) * (h - 8));
  const p = pts.map((v, i) => (v == null ? null : [X(i), Y(v)])).filter(Boolean);
  const last = p[p.length - 1];
  return (
    <svg width={w} height={h} style={{ display: "block" }} aria-hidden="true">
      <line x1={3} x2={w - 3} y1={h - 1} y2={h - 1} stroke="rgba(255,255,255,0.06)" />
      {p.length > 1 && <polyline points={p.map((q) => q.join(",")).join(" ")} fill="none" stroke={color} strokeOpacity={0.75} strokeWidth={1.5} strokeLinejoin="round" />}
      <circle cx={last[0]} cy={last[1]} r={2.8} fill={color} />
    </svg>
  );
}
function Tile({ label, value, unit, sub, subColor, spark, sparkColor }) {
  return (
    <div style={{ padding: "12px 12px 10px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, minWidth: 0 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: "#6B7280", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{value}{unit && <span style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", marginLeft: 3 }}>{unit}</span>}</div>
      {sub && <div style={{ fontSize: 11, color: subColor || "#6B7280", marginTop: 2 }}>{sub}</div>}
      {spark && <div style={{ marginTop: 6 }}><Spark pts={spark} color={sparkColor} w={110} h={24} /></div>}
    </div>
  );
}
function Section({ title, subtitle, children }) {
  return (
    <div style={{ marginTop: 16, padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 14, border: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>{title}</div>
      {subtitle && <div style={{ fontSize: 11, color: "#6B7280", marginTop: 3, lineHeight: 1.45 }}>{subtitle}</div>}
      <div style={{ marginTop: 10 }}>{children}</div>
    </div>
  );
}
const backBtn = { border: "none", background: "none", color: "#6B7280", fontSize: 13, cursor: "pointer", padding: "0 0 12px" };

// ─── Unlock ──────────────────────────────────────────────────────────────────
function Unlock({ onUnlock, error }) {
  const [v, setV] = useState("");
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (v) onUnlock(v); }} style={{ marginTop: 24, textAlign: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: "#fff", marginBottom: 6 }}>Training log</div>
      <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 16, lineHeight: 1.5 }}>Enter the staff password to see and log training. This device remembers it until you lock it again.</div>
      <input type="password" value={v} autoFocus onChange={(e) => setV(e.target.value)} placeholder="Staff password" aria-label="Staff password" style={{ width: "100%", maxWidth: 280, padding: "12px 14px", border: "1px solid " + (error ? "#F97362" : "rgba(255,255,255,0.1)"), borderRadius: 10, background: "rgba(255,255,255,0.04)", color: "#fff", fontSize: 14, outline: "none", textAlign: "center" }} />
      <div><button type="submit" style={{ marginTop: 12, padding: "11px 30px", border: "none", borderRadius: 10, background: "#4FFFB0", color: "#0A0C10", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>Unlock</button></div>
      {error && <div style={{ fontSize: 12, color: "#F97362", marginTop: 12 }}>{error}</div>}
    </form>
  );
}

// ─── Progress (summary) ──────────────────────────────────────────────────────
function Progress({ A, M, ctx }) {
  const logged = M.sessions.filter((s) => M.sessionStats(A.programs[s.month], s.day, s.week).done > 0);
  const dates = logged.map((s) => (M.logOf(s.month, s.day, s.week) || {}).date).filter(Boolean).sort();
  const from = dates[0], to = dates[dates.length - 1];
  const ymd = (iso) => +iso.slice(2).replace(/-/g, "");
  const inWin = (d) => from && d >= ymd(from) && d <= ymd(to);
  const fdName = (ctx.CMJ_BY_CANON[ctx.canonName(A.athlete.name)] || {}).name || A.athlete.name;
  const fh = ctx._FH[fdName];
  const idx = fh && fh.d ? fh.d.map((d, i) => (inWin(d) ? i : -1)).filter((i) => i >= 0) : [];
  const series = (k) => idx.map((i) => fh[k][i]).filter((v) => v != null);
  const jh = series("jh"), rsi = series("rsi");
  const velo = ctx.VELO_BY_CANON[ctx.canonName(A.athlete.name)];
  const veloWin = velo ? velo.dateHistory.map((d, i) => [ymd(mdyToIso(d)), velo.peakHistory[i]]).filter(([d, v]) => inWin(d) && v != null) : [];
  const delta = (arr, dec, unit) => {
    if (arr.length < 2) return null;
    const d = arr[arr.length - 1] - arr[0];
    return { text: `${d >= 0 ? "+" : ""}${d.toFixed(dec)}${unit} since ${shortDate(from)}`, color: d > 0 ? "#4FFFB0" : d < 0 ? "#FF6B6B" : "#6B7280" };
  };
  let done = 0, rx = 0;
  logged.forEach((s) => { const st = M.sessionStats(A.programs[s.month], s.day, s.week); done += st.done; rx += st.rx; });
  const pct = rx ? Math.round((done / rx) * 100) : null;
  const lifts = liftRows(A, M);
  const jhD = delta(jh, 1, '"'), rsiD = delta(rsi, 2, "");
  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8 }}>
        <Tile label="Sets completed" value={pct != null ? pct : "–"} unit={pct != null ? "%" : ""} sub={`${done} of ${rx} programmed`} />
        <Tile label="Jump height" value={jh.length ? jh[jh.length - 1].toFixed(1) : "–"} unit={jh.length ? "in" : ""} sub={jhD ? jhD.text : jh.length ? "1 CMJ in this block" : "No CMJ in this block"} subColor={jhD && jhD.color} spark={jh.length > 1 ? jh : null} sparkColor="#4FFFB0" />
        <Tile label="RSI-mod" value={rsi.length ? rsi[rsi.length - 1].toFixed(2) : "–"} sub={rsiD ? rsiD.text : rsi.length ? "1 CMJ in this block" : "No CMJ in this block"} subColor={rsiD && rsiD.color} spark={rsi.length > 1 ? rsi : null} sparkColor="#60A5FA" />
        {M.months.some((p) => (p.movement || []).length) && (() => {
          let n = 0, done = 0;
          M.months.forEach((p) => (p.movement || []).forEach((mv, mi) => { for (let w = 1; w <= 4; w++) { n++; const l = (A.logs[p.month] || {})[`m${mi + 1}w${w}`]; if (l && Object.values(l.entries || {}).some((a) => (a || []).some((c) => c && c.done))) done++; } }));
          return <Tile label="Movement days" value={done} unit={`/ ${n}`} sub="weeks with the Movement Day logged" />;
        })()}
        {velo && <Tile label="Peak velo" value={veloWin.length ? Math.max(...veloWin.map((v) => v[1])).toFixed(1) : "–"} unit={veloWin.length ? "mph" : ""} sub={veloWin.length ? `${veloWin.length} TrackMan session${veloWin.length === 1 ? "" : "s"} in this block` : "No TrackMan in this block"} spark={veloWin.length > 1 ? veloWin.map((v) => v[1]) : null} sparkColor="#FFB020" />}
      </div>
      <Section title="Lift trends" subtitle="Heaviest set each week. Estimated 1RM uses the Epley formula on sets of 10 reps or fewer.">
        {lifts.length === 0 && <div style={{ fontSize: 12, color: "#6B7280", padding: "8px 0" }}>No loads logged yet.</div>}
        {lifts.map((r) => (
          <div key={r.name} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 84px 64px 44px", gap: 10, alignItems: "center", padding: "8px 0", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontSize: 12, color: "#E0E0E0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.name}>{r.name}</div>
            <Spark pts={r.pts.slice(0, Math.max(4, r.pts.reduce((m, v, i) => (v != null ? i + 1 : m), 0)))} w={84} h={22} />
            <div style={{ fontSize: 12, color: "#fff", fontWeight: 600, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.last[0]}{r.last[1] != null && <span style={{ color: "#6B7280", fontWeight: 500 }}>{" × " + r.last[1]}</span>}</div>
            <div style={{ fontSize: 11, color: "#8A8F98", textAlign: "right" }} title="Estimated 1RM">{r.e1rm ? Math.round(r.e1rm) : ""}</div>
          </div>
        ))}
      </Section>
    </div>
  );
}

// ─── Logger ──────────────────────────────────────────────────────────────────
function Logger({ A, M, ctx, pw, onSaved, onLocked, start }) {
  const nx = M.nextSession() || M.sessions[0];
  const [sel, setSel] = useState(() => {
    const m = start && /^d(\d+)w(\d+)$/.exec(start.key || "");
    if (m && A.programs[start.month] && A.programs[start.month].days.some((x) => x.day === +m[1])) return { month: start.month, day: +m[1], week: +m[2] };
    return nx ? { month: nx.month, day: nx.day, week: nx.week } : null;
  });
  const [drafts, setDrafts] = useState({});
  const [toast, setToast] = useState(null);
  const timers = useRef({}), writing = useRef({}), again = useRef({}), latest = useRef({}), toastT = useRef(null);
  latest.current = drafts;

  // Sets saved only on this device (lost signal at the gym) go back up on open.
  useEffect(() => {
    if (!sel) return;
    let pend = {};
    try { pend = JSON.parse(localStorage.getItem("rpm_tl_pending") || "{}"); } catch (e) {}
    const mine = Object.entries(pend).filter(([, v]) => v && v.athlete === A.athlete.id);
    if (!mine.length) return;
    const restored = Object.fromEntries(mine.map(([key, v]) => [key, v.body]));
    latest.current = { ...latest.current, ...restored };
    setDrafts((o) => ({ ...restored, ...o }));
    mine.forEach(([key]) => save(key));
  }, []);

  // Force Decks bodyweight by date (portal's filtered bodyweight history)
  const fdName = (ctx.CMJ_BY_CANON[ctx.canonName(A.athlete.name)] || {}).name || A.athlete.name;
  const bwMap = useMemo(() => {
    const b = ctx.BW_DATA[fdName];
    const m = {};
    if (b && b.dates) b.dates.forEach((d, i) => { if (b.history[i] != null) m[mdyToIso(d)] = b.history[i]; });
    return m;
  }, [fdName]);
  const fdBw = (date) => (date ? bwMap[date] ?? null : null);

  if (!sel) return <div style={{ fontSize: 13, color: "#6B7280" }}>No program loaded for this athlete yet.</div>;
  const k = `${sel.month}|${skey(sel.day, sel.week)}`;
  const saved = M.logOf(sel.month, sel.day, sel.week);
  const blank = { date: "", bodyweight: null, notes: "", entries: {}, rpe: {}, stance: {}, swaps: {} };
  // Older or partial sessions (e.g. a note saved with no sets) may lack fields.
  const log = { ...blank, ...(drafts[k] || (saved ? JSON.parse(JSON.stringify(saved)) : {})) };
  for (const f of ["entries", "rpe", "stance", "swaps"]) if (!log[f] || typeof log[f] !== "object") log[f] = {};
  const prog = A.programs[sel.month];
  const d = prog.days.find((x) => x.day === sel.day);

  const flash = (text, bad) => { setToast({ text, bad }); clearTimeout(toastT.current); if (!bad) toastT.current = setTimeout(() => setToast(null), 1300); };
  async function save(key) {
    if (writing.current[key]) { again.current[key] = true; return; }
    writing.current[key] = true;
    const [month, sk] = key.split("|");
    const body = latest.current[key];
    flash("Saving");
    try {
      const r = await api(pw, { body: { op: "saveSessions", id: A.athlete.id, month, sessions: { [sk]: body } } });
      onSaved(month, sk, { ...body, updatedAt: r.updatedAt });
      writing.current[key] = false;
      try { const p = JSON.parse(localStorage.getItem("rpm_tl_pending") || "{}"); delete p[key]; localStorage.setItem("rpm_tl_pending", JSON.stringify(p)); } catch (e) {}
      if (again.current[key]) { again.current[key] = false; return save(key); }
      flash("Saved");
    } catch (e) {
      writing.current[key] = false;
      if (e.status === 401) { onLocked(); return; }
      flash("Not saved yet. Kept on this device, retrying", true);
      setTimeout(() => save(key), 4000);
    }
  }
  function change(mut) {
    const next = JSON.parse(JSON.stringify(log));
    mut(next);
    if (!next.date) {
      const choices = dateChoices(next);
      if (!choices.length) next.date = todayIso();
    }
    setDrafts((o) => ({ ...o, [k]: next }));
    latest.current = { ...latest.current, [k]: next };
    try { const p = JSON.parse(localStorage.getItem("rpm_tl_pending") || "{}"); p[k] = { athlete: A.athlete.id, body: next }; localStorage.setItem("rpm_tl_pending", JSON.stringify(p)); } catch (e) {}
    clearTimeout(timers.current[k]);
    const key = k;
    timers.current[k] = setTimeout(() => save(key), 700);
  }
  // Movement days (Pre-Work tab): one log per movement day per week, key m<n>w<week>;
  // each exercise is a single "done" tick, keyed by its slot label ("A1", "D"...).
  const mvSk = (mi) => `m${mi + 1}w${sel.week}`;
  const mvSlot = (x, i) => ((x.name.match(/^([A-Z]\d?)\)/) || [])[1] || `X${i + 1}`);
  const mvLog = (mi) => {
    const kk = `${sel.month}|${mvSk(mi)}`;
    const base = drafts[kk] || (A.logs[sel.month] || {})[mvSk(mi)] || {};
    return { date: "", notes: "", ...base, entries: { ...(base.entries || {}) } };
  };
  function mvChange(mi, mut) {
    const kk = `${sel.month}|${mvSk(mi)}`;
    const next = JSON.parse(JSON.stringify(mvLog(mi)));
    mut(next);
    if (!next.date) next.date = todayIso();
    setDrafts((o) => ({ ...o, [kk]: next }));
    latest.current = { ...latest.current, [kk]: next };
    try { const p = JSON.parse(localStorage.getItem("rpm_tl_pending") || "{}"); p[kk] = { athlete: A.athlete.id, body: next }; localStorage.setItem("rpm_tl_pending", JSON.stringify(p)); } catch (e) {}
    clearTimeout(timers.current[kk]);
    timers.current[kk] = setTimeout(() => save(kk), 700);
  }

  // Force Decks days not yet tied to a session, after the last dated earlier session.
  function dateChoices(l) {
    const curOrder = M.orderOf(sel.month, sel.day, sel.week);
    const all = M.sessions.map((s) => ({ s, l: drafts[`${s.month}|${skey(s.day, s.week)}`] || M.logOf(s.month, s.day, s.week) })).filter((x) => x.l);
    const used = new Set(all.map((x) => x.l.date).filter(Boolean));
    const prior = all.filter((x) => x.l.date && x.s.order < curOrder).map((x) => x.l.date).sort().pop() || "";
    const start = new Date(M.months[0].month + "-01T00:00:00"); start.setDate(start.getDate() - 7);
    const floor = start.toLocaleDateString("en-CA");
    return Object.keys(bwMap).sort().filter((x) => !used.has(x) && x > prior && x >= floor && x <= todayIso()).slice(0, 4);
  }

  const setCell = (slot, i, field, value) => change((l) => {
    const arr = (l.entries[slot] = l.entries[slot] || []);
    while (arr.length <= i) arr.push(null);
    const s = { ...(arr[i] || {}) };
    s[field] = value;
    arr[i] = s.load != null || s.reps != null || s.done ? { load: s.load ?? null, reps: s.reps ?? null, ...(s.done ? { done: true } : {}) } : null;
  });

  const isDl = (ex) => ex.key === "deadlift";
  const choices = !log.date ? dateChoices(log) : [];
  const bwShown = log.bodyweight ?? fdBw(log.date);
  const bwSrc = log.bodyweight != null ? "Entered by you" : fdBw(log.date) != null ? "From Force Decks" : log.date ? "No Force Decks jump this day" : "Set the date to pull it";

  return (
    <div>
      <div className="months">
        {M.months.map((p) => {
          let dn = 0;
          const cells = [];
          for (let w = 1; w <= 4; w++) {
            cells.push(<span key={"l" + w} className="lab">W{w}</span>);
            for (const dd of p.days) {
              const st = M.sessionStats(p, dd.day, w);
              if (st.done > 0) dn++;
              const cls = st.done === 0 ? "" : st.done >= st.rx ? "done" : "partial";
              const isNext = nx && nx.month === p.month && nx.day === dd.day && nx.week === w;
              const cur = sel.month === p.month && sel.day === dd.day && sel.week === w;
              cells.push(<button key={w + "-" + dd.day} className={`cell ${cls} ${isNext ? "next" : ""}`} aria-current={cur} aria-label={`${p.label}, week ${w}, day ${dd.day}: ${st.done} of ${st.rx} sets`} onClick={() => setSel({ month: p.month, day: dd.day, week: w })}>D{dd.day}</button>);
            }
          }
          return (
            <div key={p.month}>
              <div className="mh">{p.label.split(" ")[0]}<span>{dn}/{p.days.length * 4}</span></div>
              <div className="mgrid" style={{ gridTemplateColumns: `20px repeat(${p.days.length}, 1fr)` }}>{cells}</div>
            </div>
          );
        })}
      </div>
      {(prog.movement || []).map((mv, mi) => {
        const ml = mvLog(mi);
        const ticked = mv.exercises.filter((x, i) => ((ml.entries || {})[mvSlot(x, i)] || [])[0]?.done).length;
        return (
          <details key={mi} style={{ marginTop: 14, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, background: "rgba(255,255,255,0.02)" }}>
            <summary>{mv.label} · Week {sel.week}{" "}
              <span style={{ fontSize: 11, fontWeight: 700, color: ticked ? "#4FFFB0" : "#6B7280", marginLeft: 6 }}>{ticked === mv.exercises.length ? "✓ logged" : ticked ? `${ticked}/${mv.exercises.length} done` : "not logged"}</span>
            </summary>
            <div style={{ fontSize: 12, color: "#8A8F98", marginTop: 8 }}>
              {mv.warmup.length > 0 && <>
                <div style={{ color: "#E0E0E0", fontWeight: 600 }}>{mv.warmup[0].endsWith(":") ? mv.warmup[0].slice(0, -1) : "Warm-up"}{mv.note ? ` (${mv.note.replace(/\.$/, "").toLowerCase()})` : ""}</div>
                <ul>{mv.warmup.filter((x, i) => !(i === 0 && x.endsWith(":"))).map((x, i) => <li key={i}>{x}</li>)}</ul>
              </>}
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {mv.exercises.map((x, i) => {
                  const done = !!(((ml.entries || {})[mvSlot(x, i)] || [])[0]?.done);
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid rgba(255,255,255,0.05)", paddingTop: 6 }}>
                      <span style={{ color: "#E0E0E0", minWidth: 0 }}>{x.name}<span style={{ color: "#6B7280" }}>{x.weeks[sel.week - 1] ? ` · ${x.weeks[sel.week - 1]}` : ""}</span></span>
                      <button className="tb" aria-pressed={done} style={done ? { borderColor: "#4FFFB0", color: "#4FFFB0", background: "rgba(79,255,176,0.12)" } : null}
                        onClick={() => mvChange(mi, (l) => { l.entries[mvSlot(x, i)] = done ? [] : [{ load: null, reps: null, done: true }]; })}>{done ? "✓ Done" : "Done"}</button>
                    </div>
                  );
                })}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 10 }}>
                <button className="tb" onClick={() => mvChange(mi, (l) => { mv.exercises.forEach((x, i) => { l.entries[mvSlot(x, i)] = [{ load: null, reps: null, done: true }]; }); })}>Mark all done</button>
                {ml.date && <span style={{ fontSize: 11, color: "#6B7280" }}>Logged {shortDate(ml.date)}</span>}
              </div>
              <textarea aria-label={`${mv.label} notes`} placeholder="Notes (optional)" value={ml.notes || ""} onChange={(e) => mvChange(mi, (l) => { l.notes = e.target.value; })}
                style={{ width: "100%", minHeight: 44, marginTop: 8, border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, background: "#13161B", color: "#fff", padding: "7px 9px", fontSize: 12, resize: "vertical" }} />
            </div>
          </details>
        );
      })}
      <div className="key"><span><i />Not logged</span><span><i className="p" />Partly</span><span><i className="d" />Logged</span><span><i className="n" />Up next</span></div>

      <div className="logger">
        <div className="lhead">
          <div><div className="eb">{prog.label} · Week {sel.week}</div><h3>Day {sel.day}</h3></div>
          <div className="meta">
            <div className="field"><label htmlFor="tl-date">Date</label><input id="tl-date" type="date" value={log.date || ""} onChange={(e) => change((l) => { l.date = e.target.value; })} /></div>
            <div className="field"><label htmlFor="tl-bw">Bodyweight</label><input id="tl-bw" type="number" inputMode="decimal" step="0.1" placeholder="lb" value={bwShown ?? ""} onChange={(e) => change((l) => { l.bodyweight = num(e.target.value); })} /><span className="src">{bwSrc}</span></div>
          </div>
          {!log.date && (
            <div className="dpick"><span>{choices.length ? "Which day was this? Force Decks days:" : "Date:"}</span>
              <button className="tb" onClick={() => change((l) => { l.date = todayIso(); })}>Today</button>
              {choices.map((c) => <button key={c} className="tb" onClick={() => change((l) => { l.date = c; })}>{new Date(c + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" })}</button>)}
            </div>
          )}
        </div>
        {prog.warmup && prog.warmup.length > 0 && <details><summary>Warm-up ({prog.warmup.length})</summary><ul>{prog.warmup.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
        {d.prework && d.prework.length > 0 && <details><summary>Pre-work ({d.prework.length})</summary><ul>{d.prework.map((x, i) => <li key={i}>{x}</li>)}</ul></details>}
        {d.exercises.map((ex) => {
          const wk = ex.weeks.find((w) => w.w === sel.week);
          if (!wk) return null;
          const target = M.targetOf(prog, wk);
          const stance = isDl(ex) ? M.stanceFor(sel.month, sel.day, sel.week, ex, wk, log) : null;
          const planned = isDl(ex) ? M.resolveStance(wk.stance) : null;
          const swapped = (log.swaps || {})[ex.slot] || null;
          const name = isDl(ex) ? "Deadlift" : swapped || ex.name;
          const lt = M.lastTime(ex, sel);
          const entries = log.entries[ex.slot] || [];
          const n = Math.max(wk.sets, entries.length);
          const pctTxt = wk.pct ? ` @ ${wk.pct.map((p) => +(p * 100).toFixed(1)).join("-")}%` : "";
          let callout = null;
          if (isDl(ex) && wk.target && wk.target.length > 1) callout = <><b>Test single.</b> Work up to one single at 92-95%. Your best single this month sets next month's loads.</>;
          if (isDl(ex) && sel.month.endsWith("-12") && sel.week === 4) {
            const best = M.months.map((p) => M.bestSingle(p.month, "deadlift")).filter(Boolean).reduce((m, s) => (!m || s.load > m.load ? s : m), null);
            callout = best ? <><b>Jan 1 attempts.</b> Best training single so far: {best.load}. Opener about {round5(best.load * 0.95)}, second a small PR over {best.load}, third is the day's call.</> : <><b>Jan 1 attempts.</b> Opener is about 95% of your best training single.</>;
          }
          return (
            <div key={ex.slot} className="ex">
              <div className="extop">
                <span className="exname"><span className="slot">{ex.slot}</span>{name}
                  {isDl(ex) && <span className="seg" role="group" aria-label="Stance this session">
                    {["conventional", "sumo"].map((st) => <button key={st} aria-pressed={stance === st} onClick={() => change((l) => { l.stance = { ...(l.stance || {}), [ex.slot]: st === planned ? null : st }; })}>{st === "sumo" ? <span className="dot" /> : <span className="sq" />}{STANCE[st]}</button>)}
                  </span>}
                </span>
                <span className="rx">{wk.sets} × {wk.reps}{pctTxt}{target && <b> → {target.length > 1 ? `${target[0]}-${target[1]}` : target[0]} lb</b>}{wk.loadNote ? ` · load ${wk.loadNote}` : ""}</span>
              </div>
              {isDl(ex) && stance && planned && stance !== planned && <div className="note">Swapped from {STANCE[planned].toLowerCase()}</div>}
              {swapped && <div className="note"><b>Swapped</b> from {ex.name}</div>}
              {ex.note && <div className="note">{ex.note}</div>}
              {lt && <div className="last">Last: <b>{monShort(lt.s.month)} wk {lt.s.week}</b> {fmtSets(lt.sets)}</div>}
              <div className="sets">
                {Array.from({ length: n }, (_, i) => {
                  const s = entries[i] || {};
                  if (s.skipped) return <button key={i} className="set skipped" aria-label={`${name} set ${i + 1} skipped. Tap to bring it back.`} onClick={() => change((l) => { l.entries[ex.slot][i] = null; })}><span className="n">{i + 1}</span><span className="x">✕</span><span className="sk">Skipped</span></button>;
                  const ph = target ? target[0] : lt ? (lt.sets[Math.min(i, lt.sets.length - 1)] || {}).load ?? "" : "";
                  if (isBodyweight(name) && !(s.load > 0)) {
                    const done = setDone(s), repsBox = wk.repsN != null || isAmrap(wk.reps) || s.reps != null;
                    return (
                      <div key={i} className={`set bw ${done ? "filled" : ""}`}>
                        <span className="n">{i + 1 > wk.sets ? "+" : ""}{i + 1}</span>
                        <button className="chk" aria-pressed={done} aria-label={`${name} set ${i + 1} ${done ? "done, tap to undo" : "tap when done"}`}
                          onClick={() => change((l) => { const arr = (l.entries[ex.slot] = l.entries[ex.slot] || []); while (arr.length <= i) arr.push(null); arr[i] = done ? null : { load: null, reps: s.reps ?? null, done: true }; })}>{done ? "✓" : "○"}</button>
                        {repsBox
                          ? <input className="reps" inputMode="numeric" aria-label={`${name} set ${i + 1} reps`} placeholder={isAmrap(wk.reps) ? "reps" : `×${wk.repsN ?? ""}`} value={s.reps ?? ""} onChange={(e) => change((l) => { const arr = (l.entries[ex.slot] = l.entries[ex.slot] || []); while (arr.length <= i) arr.push(null); const r = num(e.target.value); arr[i] = r != null ? { load: null, reps: r, done: true } : (arr[i] && arr[i].done ? { load: null, reps: null, done: true } : null); })} />
                          : <div className="rt">{wk.reps.replace("seconds", "sec").replace("yards", "yd")}</div>}
                      </div>
                    );
                  }
                  return (
                    <div key={i} className={`set ${setDone(s) ? "filled" : ""}`}>
                      <span className="n">{i + 1 > wk.sets ? "+" : ""}{i + 1}</span>
                      <input className="load" inputMode="decimal" aria-label={`${name} set ${i + 1} load, lb`} placeholder={ph} value={s.load ?? ""} onChange={(e) => setCell(ex.slot, i, "load", num(e.target.value))} />
                      {wk.repsN != null || isAmrap(wk.reps) || s.reps != null
                        ? <input className="reps" inputMode="numeric" aria-label={`${name} set ${i + 1} reps`} placeholder={`×${wk.repsN ?? ""}`} value={s.reps ?? ""} onChange={(e) => setCell(ex.slot, i, "reps", num(e.target.value))} />
                        : <button className="rt" aria-pressed={!!s.done} aria-label={`Mark ${name} set ${i + 1} done`} onClick={() => setCell(ex.slot, i, "done", !s.done)}>{s.done ? "✓ " : ""}{wk.reps.replace("seconds", "sec").replace("yards", "yd")}</button>}
                    </div>
                  );
                })}
                <div className="tools">
                  <button className="tb" title="Copy your first set, or the target, into the empty sets" onClick={() => change((l) => {
                    const arr = (l.entries[ex.slot] = l.entries[ex.slot] || []);
                    const nn = Math.max(wk.sets, arr.length), first = arr.find((s) => s && s.load != null);
                    for (let i = 0; i < nn; i++) {
                      if (setDone(arr[i]) || (arr[i] && arr[i].skipped)) continue;
                      const load = first ? first.load : target ? target[0] : lt ? (lt.sets[Math.min(i, lt.sets.length - 1)] || {}).load ?? null : null;
                      arr[i] = { load, reps: first ? first.reps : null, done: true };
                    }
                  })}>Fill sets</button>
                  <span className="pm">
                    <button className="tb" aria-label="Remove or skip the last set" onClick={() => change((l) => {
                      const arr = (l.entries[ex.slot] = l.entries[ex.slot] || []);
                      const nn = Math.max(wk.sets, arr.length);
                      while (arr.length < nn) arr.push(null);
                      let i = nn - 1;
                      while (i >= 0 && arr[i] && arr[i].skipped) i--;
                      if (i < 0) return;
                      if (i >= wk.sets) arr.splice(i, 1); else arr[i] = { skipped: true };
                    })}>− Set</button>
                    <button className="tb" onClick={() => change((l) => { const arr = (l.entries[ex.slot] = l.entries[ex.slot] || []); while (arr.length < Math.max(wk.sets, arr.length)) arr.push(null); arr.push(null); })}>+ Set</button>
                  </span>
                </div>
                {wk.repsN != null && <div className="rpe"><input inputMode="decimal" aria-label={`${name} RPE`} value={(log.rpe || {})[ex.slot] ?? ""} onChange={(e) => change((l) => { l.rpe = { ...(l.rpe || {}), [ex.slot]: num(e.target.value) }; })} /><label>RPE</label></div>}
              </div>
              {callout && <div className="callout">{callout}</div>}
            </div>
          );
        })}
        <div className="foot">
          <label htmlFor="tl-notes" style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "#6B7280" }}>Session notes</label>
          <textarea id="tl-notes" placeholder="How it moved, bar speed, anything that hurt" value={log.notes || ""} onChange={(e) => change((l) => { l.notes = e.target.value; })} />
        </div>
      </div>
      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">{toast.text}</div>}
    </div>
  );
}

// ─── Athlete link (coach side) ───────────────────────────────────────────────
function AthleteLinks({ A, pw, onLocked }) {
  const [count, setCount] = useState(null);
  const [url, setUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const first = A.athlete.name.split(" ")[0];
  const load = () => api(pw, { query: { op: "linkStatus", id: A.athlete.id } }).then((d) => setCount(d.links)).catch((e) => { if (e.status === 401) onLocked(); });
  useEffect(() => { load(); }, [A.athlete.id]);
  const create = async () => {
    setBusy(true); setMsg(null);
    try { const d = await api(pw, { body: { op: "createLink", id: A.athlete.id } }); setUrl(`${window.location.origin}/log#t=${d.token}`); load(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const revoke = async () => {
    setBusy(true); setMsg(null);
    try { await api(pw, { body: { op: "revokeLinks", id: A.athlete.id } }); setUrl(null); setMsg(`Turned off. ${first}'s old links no longer open.`); load(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); setMsg("Copied. Text it to " + first + "."); }
    catch (e) { setMsg("Press and hold the link to copy it."); }
  };
  return (
    <Section title={`${first}'s logging link`} subtitle={`A private link ${first} opens on their phone to see this program and log sets. It only opens ${first}'s own log. Anyone holding the link can log for ${first}, so send it only to them.`}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <button className="tb" disabled={busy} onClick={create}>{count ? "Make a new link" : "Make a link"}</button>
        {count > 0 && <button className="tb" disabled={busy} onClick={revoke}>Turn off links</button>}
        <span style={{ fontSize: 11, color: "#6B7280" }}>{count == null ? "" : count === 0 ? "No active links" : `${count} active link${count === 1 ? "" : "s"}`}</span>
      </div>
      {url && (
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: "#8A8F98" }}>Shown once. Copy it now:</div>
          <div style={{ fontSize: 11, color: "#E0E0E0", background: "#13161B", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 8, padding: "8px 10px", wordBreak: "break-all", userSelect: "all" }}>{url}</div>
          <div><button className="tb" onClick={copy}>Copy link</button></div>
        </div>
      )}
      {msg && <div style={{ fontSize: 11, color: "#8A8F98", marginTop: 8 }}>{msg}</div>}
    </Section>
  );
}

// ─── Athlete ─────────────────────────────────────────────────────────────────
function AthleteView({ id, pw, ctx, onBack, onLocked, start }) {
  const [A, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("log");
  useEffect(() => {
    let live = true;
    api(pw, { query: { op: "athlete", id } }).then((d) => live && setA(d)).catch((e) => { if (e.status === 401) onLocked(); else if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id]);
  const M = useMemo(() => (A ? model(A) : null), [A]);
  if (err) return <div><button style={backBtn} onClick={onBack}>{"←"} All athletes</button><div style={{ fontSize: 13, color: "#F97362" }}>{err}</div></div>;
  if (!A || !M) return <div style={{ fontSize: 13, color: "#6B7280", padding: "20px 0" }}>Loading…</div>;
  const onSaved = (month, sk, body) => setA((a) => ({ ...a, logs: { ...a.logs, [month]: { ...(a.logs[month] || {}), [sk]: body } } }));
  const logged = M.sessions.filter((s) => M.sessionStats(A.programs[s.month], s.day, s.week).done > 0).length;
  const range = M.months.length > 1 ? `${M.months[0].label.split(" ")[0]} to ${M.months[M.months.length - 1].label}` : (M.months[0] || {}).label || "";
  return (
    <div>
      <button style={backBtn} onClick={onBack}>{"←"} All athletes</button>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: "#4FFFB0", textTransform: "uppercase" }}>Training</div>
      <div style={{ fontSize: 24, fontWeight: 800, color: "#fff", marginTop: 3 }}>{A.athlete.name}</div>
      <div style={{ fontSize: 12, color: "#8A9099", marginTop: 5 }}>{range} · {logged} of {M.sessions.length} sessions logged{A.athlete.trainingMax ? ` · training max ${A.athlete.trainingMax}` : ""}</div>
      <div className="tabs">
        {[["log", "📝 Log a session"], ["progress", "📈 Progress"]].map(([k2, l]) => <button key={k2} aria-pressed={tab === k2} onClick={() => setTab(k2)}>{l}</button>)}
      </div>
      {tab === "log" ? <Logger A={A} M={M} ctx={ctx} pw={pw} onSaved={onSaved} onLocked={onLocked} start={start} /> : <Progress A={A} M={M} ctx={ctx} />}
      <AthleteLinks A={A} pw={pw} onLocked={onLocked} />
    </div>
  );
}

// ─── Athlete's own page: rpmstrength.coach/log#t=<link key> ─────────────────
const AT_KEY = "rpm_athlete_link";
export function AthleteLogPage({ ctx, logo }) {
  const [token] = useState(() => {
    let t = "";
    try {
      const m = window.location.hash.match(/t=([A-Za-z0-9_-]+)/);
      if (m) { t = m[1]; localStorage.setItem(AT_KEY, t); window.history.replaceState(null, "", window.location.pathname); }
      else t = localStorage.getItem(AT_KEY) || "";
    } catch (e) {}
    return t;
  });
  const [A, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("log");
  const dead = "This link doesn't work anymore. Ask Coach Frank for a new one.";
  useEffect(() => {
    if (!token) { setErr("Open the link Coach Frank sent you to see your program."); return; }
    api(token, { query: { op: "me" } }).then(setA).catch((e) => setErr(e.status === 401 ? dead : e.message));
  }, [token]);
  const M = useMemo(() => (A ? model(A) : null), [A]);
  const onSaved = (month, sk, body) => setA((a) => ({ ...a, logs: { ...a.logs, [month]: { ...(a.logs[month] || {}), [sk]: body } } }));
  return (
    <div style={{ minHeight: "100vh", background: "#0A0C10", fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: "#E0E0E0", maxWidth: 560, margin: "0 auto", padding: "0 18px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ height: 36 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
        {logo && <img src={logo} alt="RPM Strength" style={{ height: 30, width: "auto" }} />}
        <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.12)" }} />
        <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Training Log</div>
      </div>
      <div className="tl"><style>{CSS}</style>
        {err && <div style={{ fontSize: 14, color: "#8A8F98", padding: "24px 0", lineHeight: 1.5 }}>{err}</div>}
        {!err && (!A || !M) && <div style={{ fontSize: 13, color: "#6B7280", padding: "20px 0" }}>Loading your program…</div>}
        {!err && A && M && (
          <div>
            <div style={{ fontSize: 24, fontWeight: 800, color: "#fff" }}>{A.athlete.name}</div>
            <div style={{ fontSize: 12, color: "#8A9099", marginTop: 5 }}>{M.months.map((p) => p.label).join(" · ")}</div>
            <div className="tabs">
              {[["log", "📝 Log a session"], ["progress", "📈 Progress"]].map(([k2, l]) => <button key={k2} aria-pressed={tab === k2} onClick={() => setTab(k2)}>{l}</button>)}
            </div>
            {tab === "log" ? <Logger A={A} M={M} ctx={ctx} pw={token} onSaved={onSaved} onLocked={() => setErr(dead)} /> : <Progress A={A} M={M} ctx={ctx} />}
            <div style={{ fontSize: 11, color: "#4A4F57", margin: "24px 0 40px", lineHeight: 1.5 }}>Your sets save as you type. Only you and your coach can see this log.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── New from athletes (saves made from athletes' own links) ─────────────────
const agoText = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 6e4));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} hr ago`;
  const d = Math.round(mins / 1440);
  return d === 1 ? "yesterday" : `${d} days ago`;
};
const sessLabel = (key) => {
  const m = /^([dm])(\d+)w(\d+)$/.exec(key || "");
  if (!m) return key;
  return m[1] === "d" ? `Day ${m[2]} · Week ${m[3]}` : `Movement Day · Week ${m[3]}`;
};
function Updates({ pw, onOpen, onLocked }) {
  const [items, setItems] = useState(null);
  const load = () => api(pw, { query: { op: "activity" } }).then((d) => setItems(d.updates)).catch((e) => { if (e.status === 401) onLocked(); });
  useEffect(() => {
    load();
    const vis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", vis);
    return () => document.removeEventListener("visibilitychange", vis);
  }, [pw]);
  if (!items || !items.length) return null;
  const seen = (id) => { setItems((xs) => xs.filter((x) => x.id !== id)); api(pw, { body: { op: "activitySeen", id } }).catch(() => {}); };
  return (
    <div style={{ marginBottom: 20, border: "1px solid rgba(79,255,176,0.35)", background: "rgba(79,255,176,0.05)", borderRadius: 14, padding: "12px 12px 6px" }}>
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4FFFB0", display: "inline-block" }} />
          <div style={{ fontSize: 13, fontWeight: 800, color: "#fff" }}>New from athletes</div>
        </div>
        <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{items.length} athlete{items.length === 1 ? "" : "s"} logged since you last checked</div>
      </div>
      {items.map((u) => {
        const lifts = u.sessions.filter((x) => x.key[0] === "d");
        const first = lifts[0] || u.sessions[0];
        return (
          <div key={u.id} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "9px 0", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{u.name} <span style={{ fontSize: 11, fontWeight: 500, color: "#6B7280" }}>{agoText(u.last)}</span></div>
              <div style={{ fontSize: 11, color: "#8A8F98", marginTop: 2 }}>{u.sessions.slice(0, 4).map((x) => `${sessLabel(x.key)} (${monShort(x.month)})`).join(", ")}{u.sessions.length > 4 ? ` +${u.sessions.length - 4} more` : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="tb" style={{ borderColor: "#4FFFB0", color: "#4FFFB0" }} onClick={() => { seen(u.id); onOpen(u.id, first); }}>Check weights</button>
              <button className="tb" onClick={() => seen(u.id)} aria-label={`Dismiss ${u.name}`}>Dismiss</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Program board (programs due to be written; typed here, coach only) ────
const COACHES = ["Frank", "Alchi", "Ricky"];
const COACH_COLOR = { Frank: "#6FCF97", Alchi: "#F2C94C", Ricky: "#60A5FA" };
const BOARD_COACH = "rpm_board_coach";
const dayDiff = (iso) => Math.round((new Date(iso + "T00:00:00") - new Date(todayIso() + "T00:00:00")) / 864e5);
function dueLabel(iso) {
  if (!iso) return ["TBD", "#6B7280"];
  const d = dayDiff(iso);
  if (d < 0) return [`${-d} day${d === -1 ? "" : "s"} late`, "#FF6B6B"];
  if (d === 0) return ["Today", "#4FFFB0"];
  if (d === 1) return ["Tomorrow", "#4FFFB0"];
  return [shortDate(iso), d <= 7 ? "#E0E0E0" : "#8A8F98"];
}
const isTbd = (v) => /^\s*tbd\s*$/i.test(v || "");
function fmtFormat(f) {
  if (!f || isTbd(f)) return "Frequency TBD";
  const m = /^(\d)\s*x\s*(\d)/i.exec(f || "");
  if (!m) return f || "";
  const [t, r] = [+m[1], +m[2]];
  const extra = f.slice(m[0].length).trim();
  return `${t} day${t === 1 ? "" : "s"}` + (r === t ? ", all at RPM" : `, ${r} at RPM`) + (extra ? " " + extra : "");
}
// Due dates are typed as month/day ("9/30", "1/5", "Oct 3"); the year is whichever puts
// the date closest to today, so in December "1/5" means next January.
const MON_FULL = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function parseDue(text) {
  const t = String(text || "").trim().toLowerCase();
  if (!t || t === "tbd") return null;
  let m, d;
  let x = /^(\d{1,2})\s*[\/.-]\s*(\d{1,2})(?:\s*[\/.-]\s*\d{2,4})?$/.exec(t);
  if (x) { m = +x[1]; d = +x[2]; }
  else if ((x = /^([a-z]{3})[a-z]*\.?\s*(\d{1,2})$/.exec(t))) { m = MON_FULL.indexOf(x[1]) + 1; d = +x[2]; }
  if (!m || m > 12 || !d || d > 31) return undefined;
  const today = new Date(todayIso() + "T00:00:00");
  let best = null;
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const dt = new Date(y, m - 1, d);
    if (dt.getMonth() !== m - 1) continue;   // Feb 30 and friends
    if (!best || Math.abs(dt - today) < Math.abs(best - today)) best = dt;
  }
  return best ? best.toLocaleDateString("en-CA") : undefined;
}
const mdOf = (iso) => (iso ? `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}` : "");
const inp = { border: "1px solid rgba(255,255,255,0.12)", borderRadius: 10, background: "#13161B", color: "#fff", padding: "8px 10px", fontSize: 14, width: "100%", minWidth: 0 };
function BoardForm({ row, athletes, defCoach, onSave, onDelete, onCancel }) {
  const [f, setF] = useState(() => ({ name: row ? (row.athleteName || row.name) : "", format: row ? row.format : "", due: row ? (row.due ? mdOf(row.due) : "TBD") : "", coach: row ? row.coach : defCoach }));
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const due = parseDue(f.due);
  const submit = async (e) => {
    e.preventDefault();
    if (!f.name.trim() || busy || due === undefined) return;
    const hit = athletes.find((a) => a.name.toLowerCase() === f.name.trim().toLowerCase());
    setBusy(true);
    await onSave({ ...(row ? { id: row.id, done: row.done } : {}), name: f.name.trim(), athlete: hit ? hit.id : null, format: f.format.trim(), due, coach: f.coach });
    setBusy(false);
  };
  const lab = { fontSize: 9, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: "#6B7280", display: "grid", gap: 4 };
  const tbdBtn = (k) => (
    <button type="button" aria-pressed={isTbd(f[k])} onClick={() => setF({ ...f, [k]: isTbd(f[k]) ? "" : "TBD" })}
      style={{ border: "1px solid " + (isTbd(f[k]) ? "#4FFFB0" : "rgba(255,255,255,0.14)"), background: isTbd(f[k]) ? "rgba(79,255,176,0.12)" : "transparent", color: isTbd(f[k]) ? "#4FFFB0" : "#8A8F98", borderRadius: 7, padding: "1px 7px", fontSize: 10, fontWeight: 700, letterSpacing: ".04em" }}>TBD</button>
  );
  const head = (text, k) => <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><span>{text}</span>{tbdBtn(k)}</div>;
  return (
    <form onSubmit={submit} style={{ padding: 14, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(79,255,176,0.25)", borderRadius: 12, marginBottom: 8, display: "grid", gap: 10 }}>
      <label style={lab}>Athlete
        <input style={inp} value={f.name} onChange={set("name")} list="rpm-board-athletes" autoFocus placeholder="Name" />
      </label>
      <datalist id="rpm-board-athletes">{athletes.map((a) => <option key={a.id} value={a.name} />)}</datalist>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 10 }}>
        <div style={lab}>{head("Format", "format")}
          <input aria-label="Format" style={{ ...inp, ...(isTbd(f.format) ? { color: "#8A8F98" } : {}) }} value={f.format} onChange={set("format")} placeholder="4x2" />
        </div>
        <div style={lab}>{head("Due", "due")}
          <input aria-label="Due" style={{ ...inp, ...(due === undefined ? { borderColor: "#F97362" } : isTbd(f.due) ? { color: "#8A8F98" } : {}) }} value={f.due} onChange={set("due")} placeholder="9/30" inputMode="text" autoComplete="off" />
        </div>
      </div>
      <div style={{ fontSize: 11, color: "#6B7280", marginTop: -4 }}>{f.format ? fmtFormat(f.format) : "Days a week x days at RPM, like 4x2"}{" · "}{due === undefined ? <span style={{ color: "#F97362" }}>Type the due date like 9/30</span> : due ? new Date(due + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Start date TBD"}</div>
      <div className="seg" role="group" aria-label="Coach">
        {COACHES.map((c) => (
          <button type="button" key={c} aria-pressed={f.coach === c} onClick={() => setF({ ...f, coach: c })}>
            <i style={{ width: 8, height: 8, borderRadius: 2, background: COACH_COLOR[c], display: "inline-block" }} />{c}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="submit" disabled={busy || !f.name.trim() || due === undefined} style={{ padding: "8px 18px", border: "none", borderRadius: 10, background: "#4FFFB0", color: "#0A0C10", fontSize: 13, fontWeight: 700 }}>{row ? "Save" : "Add to board"}</button>
        <button type="button" className="tb" onClick={onCancel}>Cancel</button>
        {row && <button type="button" className="tb" style={{ marginLeft: "auto" }} onClick={() => { if (window.confirm(`Remove ${f.name} from the board?`)) onDelete(row.id); }}>Remove</button>}
      </div>
    </form>
  );
}
function Board({ pw, athletes, onOpen, onLocked }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [edit, setEdit] = useState(null);   // null | "new" | row id
  const [showDone, setShowDone] = useState(false);
  const [coach, setCoach] = useState(() => { try { return localStorage.getItem(BOARD_COACH) || "All"; } catch (e) { return "All"; } });
  const load = () => api(pw, { query: { op: "board" } }).then((d) => { setData(d); setErr(null); }).catch((e) => { if (e.status === 401) onLocked(); else setErr(e.message); });
  useEffect(() => { load(); }, [pw]);
  const call = async (body) => {
    try { await api(pw, { body }); setEdit(null); await load(); }
    catch (e) { if (e.status === 401) onLocked(); else setErr(e.message); }
  };
  const save = (row) => call({ op: "boardPut", row });
  const toggle = (r) => call({ op: "boardPut", row: { id: r.id, name: r.name, athlete: r.athlete, format: r.format, due: r.due, coach: r.coach, done: !r.done } });
  const pick = (c) => { setCoach(c); try { localStorage.setItem(BOARD_COACH, c); } catch (e) {} };
  if (!data) return err ? <div style={{ fontSize: 12, color: "#F97362", marginBottom: 16 }}>{err}</div> : null;
  const rows = data.rows.map((r) => ({ ...r, info: data.status[r.id] || null, athleteName: (data.status[r.id] || {}).name }));
  const mine = rows.filter((r) => coach === "All" || r.coach === coach);
  const open = mine.filter((r) => !r.done).sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999") || a.name.localeCompare(b.name));
  const cutoff = new Date(Date.now() - 45 * 864e5).toISOString();
  const done = mine.filter((r) => r.done && (r.doneAt || "") >= cutoff).sort((a, b) => (b.doneAt || "").localeCompare(a.doneAt || ""));
  const defCoach = coach === "All" ? "Frank" : coach;
  const Row = (r) => {
    if (edit === r.id) return <BoardForm key={r.id} row={r} athletes={athletes} defCoach={defCoach} onSave={save} onDelete={(id) => call({ op: "boardDelete", rowId: id })} onCancel={() => setEdit(null)} />;
    const [due, dueColor] = r.done ? [`Written ${shortDate((r.doneAt || "").slice(0, 10))}`, "#6B7280"] : dueLabel(r.due);
    const i = r.info;
    const ready = i && i.total && i.logged >= i.total;
    return (
      <div key={r.id} style={{ display: "grid", gridTemplateColumns: "4px minmax(0,1fr) auto auto", gap: 10, alignItems: "center", padding: "10px 10px 10px 0", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, marginBottom: 6, overflow: "hidden", opacity: r.done ? 0.6 : 1 }}>
        <div style={{ alignSelf: "stretch", margin: "-10px 0", background: COACH_COLOR[r.coach] || "rgba(255,255,255,0.08)" }} />
        <button onClick={() => setEdit(r.id)} style={{ minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0 }} aria-label={`Edit ${r.athleteName || r.name}`}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textDecoration: r.done ? "line-through" : "none" }}>{r.athleteName || r.name}</div>
          <div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>
            {fmtFormat(r.format)}
            {i && <span style={{ color: ready ? "#4FFFB0" : "#8A8F98" }}>{" · "}{monShort(i.month)} {i.logged}/{i.total} logged{i.next.length ? ` · ${i.next.map(monShort).join(", ")} loaded` : ""}</span>}
          </div>
          {r.draft && !r.done && <div style={{ fontSize: 11, color: "#4FFFB0", marginTop: 3, fontWeight: 600 }}>{r.draft}</div>}
        </button>
        <div style={{ display: "grid", justifyItems: "end", gap: 3 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: dueColor, whiteSpace: "nowrap" }}>{due}</div>
          {i && <button className="tb" style={{ padding: "2px 8px", fontSize: 10 }} onClick={() => onOpen(i.id)}>Log {"›"}</button>}
        </div>
        <button onClick={() => toggle(r)} aria-pressed={!!r.done} title={r.done ? "Mark not written" : "Mark written"} aria-label={r.done ? "Mark not written" : "Mark written"}
          style={{ width: 30, height: 30, borderRadius: 9, border: "1px solid " + (r.done ? "#4FFFB0" : "rgba(255,255,255,0.14)"), background: r.done ? "rgba(79,255,176,0.12)" : "transparent", color: r.done ? "#4FFFB0" : "#4A4F57", fontSize: 15, fontWeight: 800, padding: 0 }}>{"✓"}</button>
      </div>
    );
  };
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Programs due</div>
        {edit !== "new" && <button className="tb" onClick={() => setEdit("new")}>+ Add program</button>}
      </div>
      <div className="tabs" style={{ margin: "10px 0" }}>
        {["All", ...COACHES].map((c) => (
          <button key={c} aria-pressed={coach === c} onClick={() => pick(c)} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {c !== "All" && <i style={{ width: 8, height: 8, borderRadius: 2, background: COACH_COLOR[c], display: "inline-block" }} />}{c}
          </button>
        ))}
      </div>
      {err && <div style={{ fontSize: 12, color: "#F97362", marginBottom: 8 }}>{err}</div>}
      {edit === "new" && <BoardForm athletes={athletes} defCoach={defCoach} onSave={save} onCancel={() => setEdit(null)} />}
      <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 8 }}>{open.length} to write{done.length ? ` · ${done.length} written lately` : ""} · tap a name to edit, {"✓"} when it's written</div>
      {open.length === 0 && edit !== "new" && <div style={{ fontSize: 13, color: "#6B7280", padding: "12px 0" }}>Nothing due. Add the next program with + Add program.</div>}
      {open.map(Row)}
      {done.length > 0 && <button className="tb" style={{ margin: "4px 0 8px" }} onClick={() => setShowDone(!showDone)}>{showDone ? "Hide written" : `Show written (${done.length})`}</button>}
      {showDone && done.map(Row)}
    </div>
  );
}

// ─── Entry ───────────────────────────────────────────────────────────────────
export default function TrainingSection({ ctx }) {
  const [pw, setPwState] = useState(getPw);
  const [index, setIndex] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [start, setStart] = useState(null);
  const lock = (msg) => { setPw(""); setPwState(""); setIndex(null); setSel(null); setErr(msg || null); };
  useEffect(() => {
    if (!pw) return;
    let live = true;
    api(pw, { query: { op: "index" } }).then((d) => { if (live) { setIndex(d.athletes); setErr(null); } })
      .catch((e) => { if (e.status === 401) lock("That password didn't work."); else if (live) setErr(e.message); });
    return () => { live = false; };
  }, [pw]);
  const body = !pw
    ? <Unlock error={err} onUnlock={(v) => { setPw(v); setPwState(v); setErr(null); }} />
    : sel
      ? <AthleteView key={sel + (start ? start.month + start.key : "")} id={sel} start={start} pw={pw} ctx={ctx} onBack={() => { setSel(null); setStart(null); window.scrollTo(0, 0); }} onLocked={() => lock("Your staff password changed. Enter it again.")} />
      : !index
        ? <div style={{ fontSize: 13, color: err ? "#F97362" : "#6B7280", padding: "20px 0" }}>{err || "Loading…"}</div>
        : (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ fontSize: 12, color: "#6B7280" }}>{index.length} athlete{index.length === 1 ? "" : "s"} with a program loaded</div>
              <button onClick={() => lock()} style={{ border: "1px solid rgba(255,255,255,0.08)", background: "none", color: "#6B7280", fontSize: 11, borderRadius: 8, padding: "5px 10px", cursor: "pointer" }}>Lock</button>
            </div>
            <Updates pw={pw} onOpen={(id, s) => { setStart(s || null); setSel(id); window.scrollTo(0, 0); }} onLocked={() => lock("Your staff password changed. Enter it again.")} />
            <Board pw={pw} athletes={index} onOpen={(id) => { setSel(id); window.scrollTo(0, 0); }} onLocked={() => lock("Your staff password changed. Enter it again.")} />
            <div style={{ fontSize: 15, fontWeight: 800, color: "#fff", marginBottom: 8 }}>Training log</div>
            {index.length === 0 && <div style={{ fontSize: 13, color: "#6B7280", padding: "24px 0", textAlign: "center" }}>No programs loaded yet.</div>}
            {[...index].sort((a, b) => a.name.localeCompare(b.name)).map((a) => {
              const ms = a.months || [];
              const range = ms.length ? (ms.length > 1 ? `${monShort(ms[0])} to ${monShort(ms[ms.length - 1])} ${ms[ms.length - 1].slice(0, 4)}` : `${monShort(ms[0])} ${ms[0].slice(0, 4)}`) : "No program";
              return (
                <div key={a.id} role="button" tabIndex={0} onClick={() => { setSel(a.id); window.scrollTo(0, 0); }} onKeyDown={(e) => { if (e.key === "Enter") setSel(a.id); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: 14, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 12, marginBottom: 8, cursor: "pointer" }}>
                  <div><div style={{ fontSize: 15, fontWeight: 700, color: "#fff" }}>{a.name}</div><div style={{ fontSize: 11, color: "#6B7280", marginTop: 2 }}>{range}</div></div>
                  <div style={{ color: "#4A4F57", fontSize: 18 }}>{"›"}</div>
                </div>
              );
            })}
          </div>
        );
  return <div className="tl"><style>{CSS}</style>{body}</div>;
}
