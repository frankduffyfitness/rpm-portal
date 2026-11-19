import { useState, useEffect, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════
// BULLPENS
// One mound, Hack watches every pen, 20 minutes each: three pitchers an hour.
// Pitchers pick an hour (not a slot) on the days their plan has mound work, at
// /pen#t=<link key>. Coaches see the week in the Coach Portal's Bullpens tab.
// The plan itself is read from Hack's planner by api/bullpen.js; nothing here
// changes it.
// ═══════════════════════════════════════════════════════════════════════════

const PT_KEY = "rpm_pen_token";

async function bp(secret, { query, body }) {
  const r = await fetch("/api/bullpen" + (query ? "?" + new URLSearchParams(query) : ""), {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + secret, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: r.status });
  return data;
}

const hr = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""}`; };
const ap = (t) => (+t.slice(0, 2) < 12 ? "AM" : "PM");
const span = (a, b) => (ap(a) === ap(b) ? `${hr(a)} to ${hr(b)} ${ap(b)}` : `${hr(a)} ${ap(a)} to ${hr(b)} ${ap(b)}`);
const clock = (t) => { const [h, m] = t.split(":").map(Number); return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ap(t)}`; };
const nth = (n) => n + (["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || "th");
const dayOf = (iso) => new Date(iso + "T12:00:00");
const addDays = (iso, n) => { const d = dayOf(iso); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA"); };
const longDay = (iso) => dayOf(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const relDay = (iso, today) => (iso === today ? "Today" : iso === addDays(today, 1) ? "Tomorrow" : null);

const CSS = `
.bp{--ink:#fff;--ink2:#E0E0E0;--mut:#8A8F98;--dim:#6B7280;--faint:#4A4F57;--rule:rgba(255,255,255,.07);--rule2:rgba(255,255,255,.14);--acc:#4FFFB0;--accd:rgba(79,255,176,.1);--warn:#FF6B6B;--warnd:rgba(255,107,107,.1);--hold:#F2C94C}
.bp *{box-sizing:border-box}
.bp button,.bp input,.bp select,.bp textarea{font:inherit;color:inherit}
.bp button{cursor:pointer}
.bp button:disabled{cursor:default}
.bp :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.bp .eb{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--mut)}
.bp .ghost{border:1px solid var(--rule2);background:none;color:var(--ink2);border-radius:9px;padding:9px 14px;font-size:13px;font-weight:600}
.bp .ghost:hover{border-color:var(--ink2)}
.bp .txt{border:none;background:none;padding:0;color:var(--mut);font-size:13px;text-decoration:underline;text-underline-offset:3px}
.bp .dots{display:inline-flex;gap:4px;vertical-align:middle}
.bp .dots i{width:8px;height:8px;border-radius:50%;border:1.5px solid var(--acc)}
.bp .dots i.t{background:var(--faint);border-color:var(--faint)}
.bp .hour{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:56px;padding:0 16px;border:1px solid var(--rule);border-radius:12px;background:rgba(255,255,255,.02);text-align:left}
.bp .hour + .hour{margin-top:8px}
.bp .hour:not(:disabled):hover,.bp .hour:not(:disabled):active{border-color:var(--acc);background:var(--accd)}
.bp .hour:disabled{opacity:.42}
.bp .hour b{font-size:17px;font-weight:700;color:var(--ink)}
.bp .hour span{font-size:13px;color:var(--mut);display:flex;align-items:center;gap:10px}
.bp .mine{border-left:3px solid var(--acc);padding:2px 0 2px 16px}
.bp .mine .when{font-size:30px;font-weight:800;letter-spacing:-.01em;color:var(--ink);line-height:1.1}
.bp .mine p{margin:8px 0 0;font-size:15px;line-height:1.45;color:var(--ink2)}
.bp .mine p b{color:var(--acc);font-weight:700}
.bp textarea{width:100%;background:rgba(255,255,255,.04);border:1px solid var(--rule2);border-radius:10px;padding:10px 12px;font-size:16px;resize:vertical;min-height:64px;outline:none}
.bp .chips{display:grid;grid-template-columns:repeat(auto-fit,minmax(74px,1fr));gap:6px}
.bp .chip{border:1px solid var(--rule);border-radius:10px;background:rgba(255,255,255,.02);padding:8px 8px 9px;text-align:left}
.bp .chip[aria-pressed=true]{border-color:var(--acc);background:var(--accd)}
.bp .chip .d{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--mut)}
.bp .chip .n{font-size:20px;font-weight:800;color:var(--ink);line-height:1.15;margin-top:2px}
.bp .chip .n small{font-size:11px;font-weight:600;color:var(--dim)}
.bp .chip.over .n{color:var(--warn)}
.bp .row{display:grid;grid-template-columns:92px 1fr auto;gap:10px;align-items:start;padding:11px 0;border-top:1px solid var(--rule)}
.bp .row .t{font-size:14px;font-weight:700;color:var(--ink);padding-top:3px}
.bp .row.closed .t{color:var(--faint);text-decoration:line-through}
.bp .slot{display:inline-flex;align-items:center;gap:7px;margin:0 6px 6px 0;padding:4px 6px 4px 9px;border-radius:8px;background:rgba(255,255,255,.05);font-size:13px;color:var(--ink)}
.bp .slot em{font-style:normal;font-size:11px;color:var(--mut);font-variant-numeric:tabular-nums}
.bp .slot.off{background:var(--warnd)}
.bp .slot button{border:none;background:none;color:var(--dim);font-size:15px;line-height:1;padding:0 2px}
.bp .slot button:hover{color:var(--warn)}
.bp select{background:#13161B;border:1px dashed var(--rule2);border-radius:8px;padding:4px 8px;font-size:12px;color:var(--mut);max-width:150px}
.bp .mini{border:none;background:none;font-size:11px;font-weight:600;color:var(--dim);padding:4px 0}
.bp .mini:hover{color:var(--ink2)}
.bp .who{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--rule);font-size:14px;color:var(--ink)}
.bp .who small{color:var(--mut);font-size:12px;margin-left:8px}
.bp .tag{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--hold);margin-left:8px}
.bp .tag.here{color:var(--acc)}
.bp .note{font-size:13px;line-height:1.45;border-radius:10px;padding:10px 12px}
.bp .note.warn{background:var(--warnd);color:#FFB4B4}
.bp .note.plain{background:rgba(255,255,255,.04);color:var(--ink2)}
`;

function Dots({ cap, left }) {
  return <span className="dots" role="img" aria-label={`${left} of ${cap} open`}>{Array.from({ length: cap }, (_, i) => <i key={i} className={i < cap - left ? "t" : ""} />)}</span>;
}

// ─── Pitcher page (/pen) ─────────────────────────────────────────────────────
function PenDay({ d, today, busy, act }) {
  const [changing, setChanging] = useState(false);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const rel = relDay(d.date, today);
  const pick = async (win) => { if (await act({ op: "book", date: d.date, win })) setChanging(false); };
  const showHours = !d.booking || changing;
  return (
    <section style={{ padding: "26px 0", borderTop: "1px solid var(--rule)" }}>
      <div className="eb" style={{ color: rel ? "var(--acc)" : undefined }}>{rel || dayOf(d.date).toLocaleDateString("en-US", { weekday: "long" })}</div>
      <h2 style={{ margin: "4px 0 0", fontSize: 22, fontWeight: 800, color: "var(--ink)" }}>
        {dayOf(d.date).toLocaleDateString("en-US", { month: "long", day: "numeric" })}
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--mut)", marginLeft: 10 }}>{d.label || "Not on your plan"}</span>
      </h2>
      {d.maybe && <div style={{ fontSize: 13, color: "var(--hold)", marginTop: 6 }}>Hack has this one as a maybe. Book it, and check with him.</div>}
      {d.offPlan && <div style={{ fontSize: 13, color: "var(--warn)", marginTop: 6 }}>Your plan changed and this day no longer has mound work. Cancel this hour.</div>}

      {d.booking && !changing && (
        <div style={{ marginTop: 18 }}>
          <div className="mine">
            <div className="when">{span(d.booking.win, d.booking.end)}</div>
            <p>You're <b>{nth(d.booking.pos)} up</b> this hour. Be warmed up and ready by <b>{clock(d.booking.readyAt)}</b>.{d.booking.pos > 1 ? " If someone ahead of you cancels, you move up 20 minutes." : ""}</p>
          </div>
          {!d.booking.locked && (
            <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
              {!d.offPlan && <button className="ghost" disabled={busy} onClick={() => setChanging(true)}>Change hour</button>}
              <button className="ghost" disabled={busy} onClick={() => act({ op: "cancel", date: d.date })}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {showHours && !d.offPlan && (
        <div style={{ marginTop: 16 }}>
          {d.windows.length === 0 && <div className="note plain">No hours left for this day.</div>}
          {d.windows.map((w) => (
            <button key={w.win} className="hour" disabled={busy || !w.open || w.mine} onClick={() => pick(w.win)}>
              <b>{span(w.win, w.end)}</b>
              <span>{w.mine ? "Your hour" : w.left === 0 ? "Full" : !w.open ? "Closed" : <>{w.left} open <Dots cap={w.cap} left={w.left} /></>}</span>
            </button>
          ))}
          {changing && <button className="txt" style={{ marginTop: 14 }} onClick={() => setChanging(false)}>Keep my hour</button>}
        </div>
      )}

      {!d.booking && !d.offPlan && (
        <div style={{ marginTop: 16 }}>
          {d.request ? (
            <div className="note plain">Sent to Hack. He'll move this pen on your plan, then you can book the new day. <button className="txt" disabled={busy} onClick={() => act({ op: "unrequest", date: d.date })}>Undo</button></div>
          ) : asking ? (
            <div>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Anything Hack should know? Days that work better, a game, a ride." />
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button className="ghost" disabled={busy} style={{ borderColor: "var(--acc)", color: "var(--acc)" }} onClick={async () => { if (await act({ op: "request", date: d.date, note })) setAsking(false); }}>Send to Hack</button>
                <button className="ghost" disabled={busy} onClick={() => setAsking(false)}>Never mind</button>
              </div>
            </div>
          ) : d.full ? (
            <div>
              <div className="note warn" style={{ marginBottom: 12 }}>Every hour this day is full.</div>
              <button className="ghost" style={{ borderColor: "var(--acc)", color: "var(--acc)" }} onClick={() => setAsking(true)}>Ask Hack to move my pen</button>
            </div>
          ) : (
            <button className="txt" onClick={() => setAsking(true)}>None of these work? Ask Hack to move this pen.</button>
          )}
        </div>
      )}
    </section>
  );
}

export function PenPage({ logo }) {
  const [token] = useState(() => {
    let t = "";
    try {
      const m = window.location.hash.match(/t=([A-Za-z0-9_-]+)/);
      if (m) { t = m[1]; localStorage.setItem(PT_KEY, t); window.history.replaceState(null, "", window.location.pathname); }
      else t = localStorage.getItem(PT_KEY) || "";
    } catch (e) {}
    return t;
  });
  const [A, setA] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    if (!token) { setErr("Open the bullpen link Hack or Frank sent you."); return Promise.resolve(); }
    return bp(token, { query: { op: "me" } }).then((d) => { setA(d); setErr(null); })
      .catch((e) => setErr(e.status === 401 ? "This link doesn't work anymore. Ask Hack or Frank for a new one." : e.message));
  }, [token]);
  useEffect(() => { load(); }, [load]);
  // A different pitcher's link opened in the same tab only changes the hash: reload so it takes.
  useEffect(() => {
    const on = () => { if (/t=[A-Za-z0-9_-]+/.test(window.location.hash)) window.location.reload(); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  // Spots move while the page sits open on a phone: re-read when it comes back on screen.
  useEffect(() => {
    const on = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [load]);
  const act = async (body) => {
    setBusy(true);
    try { await bp(token, { body }); await load(); return true; }
    catch (e) { setErr(e.message); await load().then(() => setErr(e.message)); return false; }
    finally { setBusy(false); }
  };
  return (
    <div className="bp" style={{ minHeight: "100vh", background: "#0A0C10", fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: "#E0E0E0", maxWidth: 520, margin: "0 auto", padding: "0 20px 48px" }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <style>{CSS}</style>
      <div style={{ height: 36 }} />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28 }}>
        {logo && <img src={logo} alt="RPM Strength" style={{ height: 30, width: "auto" }} />}
        <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.12)" }} />
        <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>Bullpens</div>
      </div>
      {A && (
        <>
          <div className="eb">{A.name}</div>
          <h1 style={{ margin: "6px 0 10px", fontSize: 32, fontWeight: 800, letterSpacing: "-.02em", color: "#fff", lineHeight: 1.1 }}>Pick your hour.</h1>
          <p style={{ margin: "0 0 26px", fontSize: 15, lineHeight: 1.5, color: "var(--mut)" }}>Three pitchers throw each hour, in the order they booked. Your hour is mound time, so finish your warm-up and catch play before it starts.</p>
        </>
      )}
      {err && <div className="note warn" role="alert" style={{ marginBottom: 18 }}>{err}</div>}
      {!A && !err && <div style={{ fontSize: 14, color: "var(--dim)" }}>Loading…</div>}
      {A && A.days.length === 0 && (
        <div className="note plain">{A.posted ? "No mound days on your plan from today through next week. If that's wrong, tell Hack." : "This week's plan isn't posted yet. Check back soon."}</div>
      )}
      {A && A.days.map((d) => <PenDay key={d.date} d={d} today={A.today} busy={busy} act={act} />)}
      {A && A.stale && <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 18 }}>Showing the last plan we could read. It may be a little behind.</div>}
    </div>
  );
}

// ─── Coach board (Coach Portal, Bullpens tab) ────────────────────────────────
const mondayOf = (iso) => addDays(iso, -((dayOf(iso).getDay() + 6) % 7));
const todayIso = () => new Date().toLocaleDateString("en-CA");
const copy = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch (e) { window.prompt("Copy this link:", text); return false; } };

function LinkBtn({ pid, links }) {
  const [done, setDone] = useState(false);
  if (!links[pid]) return null;
  return <button className="mini" onClick={async () => { if (await copy(`${window.location.origin}/pen#t=${links[pid]}`)) { setDone(true); setTimeout(() => setDone(false), 1600); } }}>{done ? "Copied" : "Copy link"}</button>;
}

export function BullpenBoard({ pw, onLocked }) {
  const [monday, setMonday] = useState(() => mondayOf(todayIso()));
  const [W, setW] = useState(null);
  const [day, setDay] = useState(todayIso);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState("");
  const [allLinks, setAllLinks] = useState(false);
  const load = useCallback((fresh) => bp(pw, { query: { op: "week", monday, ...(fresh ? { fresh: "1" } : {}) } }).then((d) => { setW(d); setErr(null); })
    .catch((e) => { if (e.status === 401) onLocked(); else setErr(e.message); }), [pw, monday]);
  useEffect(() => { setW(null); load(); }, [load]);
  const call = async (body) => {
    setBusy(true);
    try { await bp(pw, { body }); await load(); }
    catch (e) { if (e.status === 401) onLocked(); else { await load(); setErr(e.message); } }
    finally { setBusy(false); }
  };
  const days = W ? W.days.filter((d) => d.windows.length || d.planned.length) : [];
  const cur = days.find((d) => d.date === day) || days.find((d) => d.date >= (W ? W.today : day)) || days[0];
  const weekLabel = `Week of ${dayOf(monday).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const everyone = W ? Object.values(Object.fromEntries(W.days.flatMap((d) => d.planned).map((p) => [p.pid, p]))).sort((a, b) => a.name.localeCompare(b.name)) : [];

  return (
    <div className="bp">
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button className="ghost" style={{ padding: "5px 11px" }} aria-label="Previous week" onClick={() => setMonday(addDays(monday, -7))}>{"‹"}</button>
          <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>{weekLabel}</div>
          <button className="ghost" style={{ padding: "5px 11px" }} aria-label="Next week" onClick={() => setMonday(addDays(monday, 7))}>{"›"}</button>
        </div>
        {W && W.configured && <button className="mini" disabled={busy} onClick={() => load(true)}>Re-read planner</button>}
      </div>

      {err && <div className="note warn" role="alert" style={{ marginBottom: 12 }}>{err}</div>}
      {!W && !err && <div style={{ fontSize: 13, color: "var(--dim)", padding: "16px 0" }}>Loading…</div>}

      {W && !W.configured && (
        <form onSubmit={(e) => { e.preventDefault(); call({ op: "bpConfig", sheet }); }} style={{ display: "grid", gap: 10, padding: "6px 0 14px" }}>
          <div style={{ fontSize: 14, color: "var(--ink2)", lineHeight: 1.45 }}>Paste the link to Hack's pitching planner. The portal only reads it, and it has to stay shared by link.</div>
          <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" style={{ background: "rgba(255,255,255,.04)", border: "1px solid var(--rule2)", borderRadius: 10, padding: "10px 12px", fontSize: 16, outline: "none" }} />
          <div><button className="ghost" disabled={busy || !sheet.trim()} style={{ borderColor: "var(--acc)", color: "var(--acc)" }}>Connect planner</button></div>
        </form>
      )}
      {W && W.configured && !W.posted && <div className="note plain" style={{ marginBottom: 12 }}>This week isn't on the planner yet. Pitchers can book once Hack adds the tab.</div>}
      {W && W.stale && <div className="note warn" style={{ marginBottom: 12 }}>Couldn't reach the planner just now. Showing the last plan that was read.</div>}

      {W && days.length > 0 && cur && (
        <>
          <div className="chips">
            {days.map((d) => {
              const booked = d.windows.reduce((n, w) => n + w.booked.length, 0);
              return (
                <button key={d.date} className={"chip" + (d.planned.length > d.cap ? " over" : "")} aria-pressed={d.date === cur.date} onClick={() => setDay(d.date)}>
                  <div className="d">{dayOf(d.date).toLocaleDateString("en-US", { weekday: "short" })} {dayOf(d.date).getDate()}</div>
                  <div className="n">{d.planned.length}<small> / {d.cap}</small></div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 1 }}>{booked} booked</div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: "var(--dim)", margin: "7px 0 20px" }}>Pens planned / spots Hack has that day.</div>

          <BoardDay d={cur} links={W.links} roster={W.roster || []} busy={busy} call={call} />

          <div style={{ marginTop: 26 }}>
            <button className="mini" onClick={() => setAllLinks(!allLinks)}>{allLinks ? "Hide" : "Show"} all pitcher links ({everyone.length})</button>
            {allLinks && everyone.map((p) => (
              <div key={p.pid} className="who">
                <span>{p.name}</span>
                <span style={{ display: "flex", gap: 14 }}>
                  <LinkBtn pid={p.pid} links={W.links} />
                  <button className="mini" disabled={busy} onClick={() => { if (window.confirm(`Make a new link for ${p.name}? His old link stops working.`)) call({ op: "bpNewLink", pid: p.pid }); }}>New link</button>
                </span>
              </div>
            ))}
            {allLinks && (W.roster || []).some((r) => r.extra) && (
              <div style={{ marginTop: 18 }}>
                <div className="eb" style={{ marginBottom: 6 }}>Typed in, not on the planner</div>
                {W.roster.filter((r) => r.extra).map((r) => (
                  <div key={r.pid} className="who">
                    <span>{r.name}</span>
                    <button className="mini" disabled={busy} onClick={() => { if (window.confirm(`Delete ${r.name}? He leaves the add list and his link stops working.`)) call({ op: "bpForget", pid: r.pid }); }}>Delete</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Put someone on this day's list who the planner doesn't have throwing: anyone on the
// planner, or a typed name for someone who isn't on it at all.
function AddPitcher({ d, roster, busy, call }) {
  const [pick, setPick] = useState("");
  const [name, setName] = useState("");
  const here = new Set(d.planned.map((p) => p.pid));
  const options = roster.filter((r) => !here.has(r.pid));
  const ready = pick === "other" ? name.trim().length > 1 : !!pick;
  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    await call(pick === "other" ? { op: "bpAdd", date: d.date, name: name.trim() } : { op: "bpAdd", date: d.date, pid: pick });
    setPick(""); setName("");
  };
  return (
    <form onSubmit={submit} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 12 }}>
      <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a pitcher to this day" style={{ maxWidth: 220, padding: "7px 9px", fontSize: 13 }}>
        <option value="">+ Add a pitcher to this day</option>
        <option value="other">Someone not on the planner…</option>
        {options.map((r) => <option key={r.pid} value={r.pid}>{r.name}{r.extra ? " (not on planner)" : ""}</option>)}
      </select>
      {pick === "other" && <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="First and last name" autoFocus style={{ flex: "1 1 160px", background: "rgba(255,255,255,.04)", border: "1px solid var(--rule2)", borderRadius: 8, padding: "7px 10px", fontSize: 14, outline: "none" }} />}
      {pick && <button className="ghost" disabled={busy || !ready} style={{ padding: "6px 12px", borderColor: "var(--acc)", color: "var(--acc)" }}>Add</button>}
    </form>
  );
}

function BoardDay({ d, links, roster, busy, call }) {
  const booked = d.windows.reduce((n, w) => n + w.booked.length, 0);
  const waiting = d.planned.filter((p) => !p.win);
  const skipped = d.skipped || [];
  const over = d.planned.length - d.cap;
  return (
    <div>
      <div className="eb">{longDay(d.date)}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: "#fff", margin: "4px 0 2px" }}>{d.planned.length} pen{d.planned.length === 1 ? "" : "s"} planned, {booked} booked</div>
      <div style={{ fontSize: 13, color: "var(--mut)", marginBottom: 12 }}>{d.cap} spots across {d.windows.filter((w) => !w.closed).length} open hour{d.windows.filter((w) => !w.closed).length === 1 ? "" : "s"}.</div>
      {over > 0 && <div className="note warn" style={{ marginBottom: 12 }}>{over} more pen{over === 1 ? "" : "s"} planned than there {over === 1 ? "is" : "are"} room for. {over === 1 ? "It needs" : "They need"} another day.</div>}

      {d.requests.map((r) => (
        <div key={r.pid} className="note plain" style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
          <span><b style={{ color: "#fff" }}>{r.name}</b> asked to move this pen.{r.note ? ` "${r.note}"` : ""}</span>
          <button className="mini" disabled={busy} style={{ color: "var(--acc)", whiteSpace: "nowrap" }} onClick={() => call({ op: "bpReqDone", date: d.date, pid: r.pid })}>Done</button>
        </div>
      ))}

      {d.windows.map((w) => (
        <div key={w.win} className={"row" + (w.closed ? " closed" : "")}>
          <div className="t">{span(w.win, w.end)}</div>
          <div>
            {w.booked.map((b) => (
              <span key={b.pid} className={"slot" + (b.offPlan ? " off" : "")} title={b.offPlan ? "No longer has mound work this day on the planner" : undefined}>
                <em>{clock(b.readyAt).replace(/ [AP]M$/, "")}</em>{b.name}
                <button aria-label={`Remove ${b.name}`} disabled={busy} onClick={() => call({ op: "bpCancel", date: d.date, pid: b.pid })}>{"×"}</button>
              </span>
            ))}
            {!w.closed && w.booked.length < w.cap && waiting.length > 0 && (
              <select value="" disabled={busy} aria-label={`Add a pitcher to ${span(w.win, w.end)}`} onChange={(e) => e.target.value && call({ op: "bpBook", date: d.date, pid: e.target.value, win: w.win })}>
                <option value="">+ add ({w.cap - w.booked.length} open)</option>
                {waiting.map((p) => <option key={p.pid} value={p.pid}>{p.name}</option>)}
              </select>
            )}
            {!w.closed && w.booked.length < w.cap && waiting.length === 0 && <span style={{ fontSize: 12, color: "var(--faint)" }}>{w.cap - w.booked.length} open</span>}
            {w.closed && w.booked.length === 0 && <span style={{ fontSize: 12, color: "var(--faint)" }}>Closed</span>}
          </div>
          <button className="mini" disabled={busy} onClick={() => call({ op: "bpWindow", date: d.date, win: w.win, open: w.closed })}>{w.closed ? "Reopen" : "Close"}</button>
        </div>
      ))}

      <div style={{ marginTop: 22 }}>
        <div className="eb" style={{ marginBottom: 6 }}>Not booked yet ({waiting.length})</div>
        {waiting.length === 0 && <div style={{ fontSize: 13, color: "var(--dim)", padding: "6px 0 2px" }}>{d.planned.length ? "Everyone on this day has an hour." : "No pens on this day."}</div>}
        {waiting.map((p) => (
          <div key={p.pid} className="who">
            <span>{p.name}<small>{p.label}</small>{p.maybe && <span className="tag">maybe</span>}{p.added && <span className="tag here">added here</span>}</span>
            <span style={{ display: "flex", gap: 14 }}>
              <LinkBtn pid={p.pid} links={links} />
              <button className="mini" disabled={busy} aria-label={`Remove ${p.name} from this day`} title={p.added ? "Take him back off this day" : "Not throwing this day. Hack's planner is not changed."} onClick={() => call({ op: "bpRemove", date: d.date, pid: p.pid })}>Remove</button>
            </span>
          </div>
        ))}
        <AddPitcher d={d} roster={roster} busy={busy} call={call} />
      </div>

      {skipped.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="eb" style={{ marginBottom: 6 }}>Removed for this day ({skipped.length})</div>
          {skipped.map((p) => (
            <div key={p.pid} className="who" style={{ color: "var(--mut)" }}>
              <span>{p.name}<small>on Hack's planner, not throwing</small></span>
              <button className="mini" disabled={busy} onClick={() => call({ op: "bpAdd", date: d.date, pid: p.pid })}>Put back</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
