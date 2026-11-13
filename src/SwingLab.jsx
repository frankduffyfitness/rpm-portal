// ─── Swing Lab (staff preview, unlinked) ─────────────────────────────────────
// rpmstrength.coach/swinglab (rewrite in vercel.json). Nothing links here yet:
// it's where the bat speed model's hitter-facing visuals get built before they
// go on athlete pages (Frank, 11/13/26). Same look as the Model Portal, behind
// its staff password (shared session unlock; the data still ships in the bundle).
//
// Data: swing_data.json, built from Bat Speed Model/blast_swings_manual.csv by
// build_swinglab_data.py (counted swings only, facility Baum 33/30). Re-run the
// script and commit the JSON after logging new swings.
//
// Time to decide: generic pitch, 6 ft of extension (54.5 ft of flight) and ~9%
// speed loss from release to plate, the same factor the exit velo card uses.
import { useEffect, useMemo, useRef, useState } from "react";
import SWING_DATA from "./swing_data.json";

const T = { bg: "#0A0C10", card: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.06)",
  text: "#E0E0E0", white: "#fff", muted: "#8A8F98", dim: "#6B7280", faint: "#4a4f57",
  green: "#4FFFB0", blue: "#60A5FA", amber: "#FFB020", orange: "#FF8C42", red: "#FF4D4D", purple: "#A78BFA" };
const FONT = "'DM Sans','Helvetica Neue',sans-serif";
const GROUP_COLOR = { Hitter: T.green, "2W": T.blue, PO: T.purple, Staff: T.muted };
const GROUP_LABEL = { Hitter: "Hitter", "2W": "Two-way", PO: "Pitcher only", Staff: "Staff" };

// dir: +1 higher is better, -1 lower is better, 0 = shape (no better/worse here; that's a hitting coach's read).
const METRICS = [
  { k: "bs", title: "Bat Speed", unit: " mph", dp: 1, dir: 1, agg: "top5", desc: "Speed of the sweet spot at contact. Average of your top 5 swings." },
  { k: "ttc", title: "Time to Contact", unit: " s", dp: 3, dir: -1, desc: "Start of the downswing to contact. Lower means a quicker swing." },
  { k: "ra", title: "Rotational Acceleration", unit: " g", dp: 1, dir: 1, desc: "How fast the bat speeds up at the start of the swing. Higher gets to speed sooner." },
  { k: "aa", title: "Attack Angle", unit: "°", dp: 0, dir: 0, desc: "Up or down path of the bat at contact. Positive means swinging up." },
  { k: "vba", title: "Vertical Bat Angle", unit: "°", dp: 0, dir: 0, desc: "Tilt of the barrel below the hands at contact. More negative means steeper." },
  { k: "ope", title: "On-Plane Efficiency", unit: "%", dp: 0, dir: 0, desc: "Share of the swing the bat stays on the plane of the pitch." },
];

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
function summarize(t) {
  const out = {};
  METRICS.forEach((m) => {
    const v = t.swings.map((s) => s[m.k]).filter((x) => x != null);
    out[m.k] = v.length ? (m.agg === "top5" ? mean([...v].sort((a, b) => b - a).slice(0, 5)) : mean(v)) : null;
  });
  out.sdBs = sd(t.swings.map((s) => s.bs));
  return out;
}
const TESTERS = SWING_DATA.testers.map((t) => ({ ...t, sum: summarize(t) }));
const fmt = (v, dp) => (v == null ? "–" : v.toFixed(dp));
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

// ─── Shared bits ─────────────────────────────────────────────────────────────
const Card = ({ children, pad = "18px 16px" }) => <div style={{ background: T.card, border: T.border, borderRadius: 16, padding: pad, marginBottom: 12 }}>{children}</div>;
const Label = ({ children }) => <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>{children}</div>;

function Spark({ values, color, width = 280, height = 40 }) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const lo = Math.min(...v), hi = Math.max(...v), r = hi - lo || 1;
  const pts = v.map((y, i) => [6 + (i / (v.length - 1)) * (width - 12), height - 6 - ((y - lo) / r) * (height - 12)]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: "block" }}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r="2.6" fill={T.bg} stroke={color} strokeWidth="1.5" />)}
    </svg>
  );
}

function MetricCard({ m, t }) {
  const val = t.sum[m.k];
  const pool = TESTERS.filter((x) => x.sum[m.k] != null);
  if (val == null) {
    return (
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 6 }}>{m.title}</div>
        <div style={{ fontSize: 12, color: T.dim }}>Not captured: this session was before the six-tile Blast layout.</div>
      </Card>
    );
  }
  const vals = pool.map((x) => x.sum[m.k]);
  const lo = Math.min(...vals), hi = Math.max(...vals), avg = mean(vals);
  const pos = hi > lo ? ((val - lo) / (hi - lo)) * 100 : 50;
  const better = (x) => (m.dir === -1 ? x < val : x > val);
  const rank = m.dir ? pool.filter((x) => better(x.sum[m.k])).length + 1 : null;
  const pct = m.dir ? Math.round(((pool.length - rank) / Math.max(1, pool.length - 1)) * 100) : null;
  const c = m.dir ? (pct >= 75 ? T.green : pct >= 50 ? T.blue : pct >= 25 ? T.amber : T.orange) : T.blue;
  const per = t.swings.map((s) => s[m.k]);
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{m.title}</span>
        {m.dir ? <span style={{ fontSize: 9, fontWeight: 700, color: c, background: c + "15", padding: "3px 10px", borderRadius: 10 }}>{ord(rank)} of {pool.length}</span>
          : <span style={{ fontSize: 9, fontWeight: 700, color: T.muted, background: "rgba(255,255,255,0.05)", padding: "3px 10px", borderRadius: 10 }}>SWING SHAPE</span>}
      </div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>{m.desc}</div>
      <div style={{ fontSize: 34, fontWeight: 700, color: T.white, lineHeight: 1, marginBottom: 16 }}>
        {m.k === "aa" && val > 0 ? "+" : ""}{fmt(val, m.dp)}<span style={{ fontSize: 14, fontWeight: 400, color: T.muted }}>{m.unit}</span>
      </div>
      <div style={{ position: "relative", height: 10, background: "rgba(255,255,255,0.04)", borderRadius: 5, marginBottom: 6 }}>
        <div style={{ position: "absolute", left: `${((avg - lo) / (hi - lo || 1)) * 100}%`, top: -3, width: 2, height: 16, background: "rgba(255,255,255,0.25)", transform: "translateX(-50%)" }} />
        <div style={{ position: "absolute", left: `${pos}%`, top: -2, width: 14, height: 14, borderRadius: "50%", background: c, border: "2px solid " + T.bg, transform: "translateX(-50%)", transition: "left 0.8s cubic-bezier(0.16,1,0.3,1)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint, marginBottom: 12 }}>
        <span>{fmt(lo, m.dp)}</span><span>group avg {fmt(avg, m.dp)}</span><span>{fmt(hi, m.dp)}</span>
      </div>
      <div style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <Label>Swing by swing</Label>
          <span style={{ fontSize: 10, color: T.dim }}>{fmt(Math.min(...per.filter((x) => x != null)), m.dp)} to {fmt(Math.max(...per.filter((x) => x != null)), m.dp)}{m.unit.trim() === "s" ? " s" : m.unit}</span>
        </div>
        <Spark values={per} color={c} />
      </div>
    </Card>
  );
}

// ─── Time to decide ──────────────────────────────────────────────────────────
const FLIGHT_FT = 54.5, PLATE_FACTOR = 0.91, MPH_TO_FTS = 1.46667;
function pitch(mph) {
  const v0 = mph * MPH_TO_FTS, vf = PLATE_FACTOR * v0, a = (vf * vf - v0 * v0) / (2 * FLIGHT_FT);
  return { T: (2 * FLIGHT_FT) / (v0 + vf), dist: (t) => Math.min(FLIGHT_FT, v0 * t + 0.5 * a * t * t) };
}
const ms = (t) => Math.round(t * 1000) + " ms";
const REL = [92, 128], END = [588, 140], HANDS = [628, 139];
const at = (f) => [REL[0] + (END[0] - REL[0]) * f, REL[1] + (END[1] - REL[1]) * f];

function TimeToDecide({ t }) {
  const ttcPool = TESTERS.filter((x) => x.sum.ttc != null);
  const avgTtc = mean(ttcPool.map((x) => x.sum.ttc));
  const ttc = t.sum.ttc;
  const [mph, setMph] = useState(90);
  const [speed, setSpeed] = useState(0.2);
  const [clock, setClock] = useState(0);
  const raf = useRef(null);
  const P = useMemo(() => pitch(mph), [mph]);
  useEffect(() => { cancelAnimationFrame(raf.current); setClock(0); }, [t, mph]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  if (ttc == null) return null;

  const tStart = P.T - ttc, decide = tStart;
  const [cx, cy] = at(P.dist(tStart) / FLIGHT_FT);
  const feels = FLIGHT_FT / (((1 + PLATE_FACTOR) / 2) * MPH_TO_FTS * (decide + avgTtc));
  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (now) => { if (t0 == null) t0 = now; const tt = ((now - t0) / 1000) * s; setClock(tt); if (tt < P.T + 0.9 * s) raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
  };
  const [bx, by] = at(P.dist(Math.max(0, clock)) / FLIGHT_FT);
  const p = clock > tStart ? Math.min(1, (clock - tStart) / ttc) : 0;
  const status = clock <= 0 ? "Press pitch" : clock < tStart ? "Seeing and deciding" : clock < P.T ? "Swinging" : "Contact";
  const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });
  const stat = (l, v, s) => (
    <div style={{ flex: "1 1 120px", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: T.white }}>{v}</div>
      <div style={{ fontSize: 10, color: T.faint }}>{s}</div>
    </div>
  );
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Time to Decide</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 14 }}>How much of the pitch you get to see before you have to start your swing.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: T.muted }}>Fastball</span>
        <input type="range" min="60" max="100" step="1" value={mph} onChange={(e) => setMph(+e.target.value)} style={{ flex: 1, accentColor: T.green }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: T.white, minWidth: 62, textAlign: "right" }}>{mph} mph</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <button onClick={() => play()} style={{ ...pill(false), background: T.green, color: T.bg, border: "none", fontWeight: 700 }}>Pitch</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => <button key={s} style={pill(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>)}
      </div>
      <svg viewBox="0 0 680 230" width="100%" role="img" aria-label="Fastball path from pitcher to hitter, split where the hitter must start his swing" style={{ display: "block", color: T.muted }}>
        <path d="M20 205 Q70 188 120 205 L660 205" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35" />
        <rect x="600" y="203" width="22" height="4" fill="currentColor" opacity=".5" />
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
          <circle cx="70" cy="122" r="8" strokeWidth="2.5" /><line x1="70" y1="130" x2="73" y2="165" /><line x1="73" y1="165" x2="58" y2="196" /><line x1="73" y1="165" x2="92" y2="192" />
          <line x1="71" y1="138" x2="92" y2="129" /><line x1="71" y1="138" x2="55" y2="150" />
        </g>
        <line x1={REL[0]} y1={REL[1]} x2={cx} y2={cy} stroke={T.green} strokeWidth="4" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={END[0]} y2={END[1]} stroke={T.orange} strokeWidth="4" strokeLinecap="round" />
        <line x1={cx} y1="112" x2={cx} y2="152" stroke={T.orange} strokeWidth="1.5" strokeDasharray="3 3" />
        <text x={Math.max(60, Math.min(560, cx))} y="104" textAnchor="middle" fontSize="12" fill={T.text}>must start: {Math.round(FLIGHT_FT - P.dist(tStart))} ft out</text>
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
          <circle cx="641" cy="116" r="8" strokeWidth="2.5" /><line x1="641" y1="124" x2="637" y2="164" /><line x1="637" y1="164" x2="620" y2="200" /><line x1="637" y1="164" x2="654" y2="200" />
          <line x1="639" y1="132" x2="628" y2="139" />
        </g>
        <g transform={`rotate(${-70 - 110 * p * p} ${HANDS[0]} ${HANDS[1]})`}>
          <line x1={HANDS[0]} y1={HANDS[1]} x2={HANDS[0] + 56} y2={HANDS[1]} stroke={T.text} strokeWidth="5" strokeLinecap="round" />
        </g>
        <circle cx={bx} cy={by} r="5" fill={T.white} />
        <text x="340" y="40" textAnchor="middle" fontSize="16" fontWeight="700" fill={T.white}>{status}</text>
        <text x="340" y="60" textAnchor="middle" fontSize="12" fill={T.dim}>{clock > 0 ? ms(Math.min(clock, P.T)) + " after release" : ""}</text>
      </svg>
      <div style={{ display: "flex", gap: 14, fontSize: 11, color: T.muted, margin: "4px 0 12px" }}>
        <span><span style={{ display: "inline-block", width: 14, height: 4, borderRadius: 2, background: T.green, verticalAlign: "middle", marginRight: 6 }} />See and decide</span>
        <span><span style={{ display: "inline-block", width: 14, height: 4, borderRadius: 2, background: T.orange, verticalAlign: "middle", marginRight: 6 }} />Swing</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {stat("Pitch flight", ms(P.T), "release to plate")}
        {stat("Your swing", ms(ttc), "time to contact")}
        {stat("Time to decide", ms(decide), "before you start")}
        {stat("Feels like", Math.round(feels) + " mph", "for an average swing")}
      </div>
    </Card>
  );
}

// ─── Bat at contact: attack angle (side view) + vertical bat angle (catcher's view) ─
// Played like the pitch: the swing runs over the hitter's own time to contact
// (group average if he has none), sped up or slowed down, and the angle is drawn
// once the barrel reaches the ball. Each view is built from one Blast number at
// contact; the path before contact is an illustration. Faint lines = every counted
// swing, dashed = group average, shown once the swing finishes.
const deg = (a) => (a * Math.PI) / 180;
const easeIn = (q) => q * q; // the barrel keeps speeding up into contact

function AngleArc({ cx, cy, r, from, to, color }) {
  // Angles in SVG degrees (0 = right, clockwise positive).
  const p = (a) => [cx + r * Math.cos(deg(a)), cy + r * Math.sin(deg(a))];
  const [x0, y0] = p(from), [x1, y1] = p(to);
  return <path d={`M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${r} ${r} 0 0 ${to > from ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}`} fill="none" stroke={color} strokeWidth="1.5" />;
}

function AttackAngleScene({ t, a, q, done, avgGroup }) {
  const C = [196, 112], back = 130, fwd = 46;
  const d = (ang) => [-Math.cos(deg(ang)), -Math.sin(deg(ang))]; // barrel travels toward the pitcher (left)
  const at = (ang, s) => [C[0] + d(ang)[0] * s, C[1] + d(ang)[1] * s];
  const s = -back + easeIn(q) * back; // rests at contact
  const [bx, by] = at(a, s), [sx, sy] = at(a, -back), [fx, fy] = at(a, fwd);
  const pitchStart = [C[0] - 190 * Math.cos(deg(6)), C[1] - 190 * Math.sin(deg(6))];
  const ball = done ? C : [pitchStart[0] + (C[0] - pitchStart[0]) * q, pitchStart[1] + (C[1] - pitchStart[1]) * q];
  const sign = a > 0 ? "+" : "";
  return (
    <svg viewBox="0 0 320 200" width="100%" style={{ display: "block" }} role="img" aria-label={`Side view: the barrel comes through contact at ${sign}${Math.round(a)} degrees`}>
      <line x1="0" y1="176" x2="320" y2="176" stroke={T.line} />
      <rect x={C[0] - 16} y="174" width="32" height="4" fill="rgba(255,255,255,0.18)" />
      <text x="6" y="192" fontSize="9" fill={T.faint}>{"←"} toward the pitcher</text>
      <text x="314" y="192" textAnchor="end" fontSize="9" fill={T.faint}>side view</text>
      <line x1={pitchStart[0]} y1={pitchStart[1]} x2={C[0]} y2={C[1]} stroke={T.muted} strokeWidth="1.2" strokeDasharray="4 4" />
      <text x="6" y={pitchStart[1] - 8} fontSize="9" fill={T.dim}>pitch</text>
      {done && t.swings.map((sw, i) => sw.aa != null && (() => { const [x0, y0] = at(sw.aa, -70), [x1, y1] = at(sw.aa, fwd); return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={T.blue} strokeOpacity="0.3" strokeWidth="1.2" />; })())}
      {done && (() => { const [x0, y0] = at(avgGroup, -70), [x1, y1] = at(avgGroup, fwd); return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(255,255,255,0.5)" strokeWidth="1.3" strokeDasharray="3 3" />; })()}
      <line x1={sx} y1={sy} x2={bx} y2={by} stroke={T.blue} strokeWidth="4" strokeLinecap="round" />
      {done && <line x1={C[0]} y1={C[1]} x2={fx} y2={fy} stroke={T.blue} strokeWidth="4" strokeLinecap="round" strokeDasharray="1 7" />}
      {done && <line x1={C[0] - 70} y1={C[1]} x2={C[0] + 50} y2={C[1]} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />}
      {done && <text x={C[0] + 54} y={C[1] + 3} fontSize="9" fill={T.dim}>level</text>}
      {done && Math.abs(a) >= 1 && <AngleArc cx={C[0]} cy={C[1]} r={62} from={180} to={180 + a} color={T.white} />}
      <circle cx={ball[0]} cy={ball[1]} r="5" fill={T.white} />
      <circle cx={bx} cy={by} r="8" fill={T.blue} stroke={T.bg} strokeWidth="2" />
      {!done && <text x={bx + 12} y={by + 4} fontSize="9" fill={T.dim}>barrel</text>}
      {done && <text x="314" y="26" textAnchor="end" fontSize="22" fontWeight="700" fill={T.white}>{sign}{Math.round(a)}°</text>}
      {done && <text x="314" y="40" textAnchor="end" fontSize="9" fill={T.muted}>{a >= 1 ? "swinging up" : a <= -1 ? "swinging down" : "level"} through contact</text>}
    </svg>
  );
}

function BatAngleScene({ t, v, q, done, avgGroup }) {
  const L = t.bats === "L", X = (x) => (L ? 320 - x : x), sx = L ? -1 : 1; // catcher's view: righties stand on the left
  const H = [X(122), 92], len = 128;
  const ang = done ? v : 42 + (v - 42) * easeIn(q); // from up by the shoulder down to the contact angle
  const end = (g, f = 1) => [H[0] + sx * len * f * Math.cos(deg(g)), H[1] - len * f * Math.sin(deg(g))];
  const [ex, ey] = end(ang), [cx, cy] = end(v, 0.82);
  return (
    <svg viewBox="0 0 320 200" width="100%" style={{ display: "block" }} role="img" aria-label={`Catcher's view: the barrel is ${Math.round(Math.abs(v))} degrees below the hands at contact`}>
      <line x1="0" y1="176" x2="320" y2="176" stroke={T.line} />
      <path d="M140 176 L180 176 L180 171 L160 166 L140 171 Z" fill="rgba(255,255,255,0.18)" />
      <text x="6" y="192" fontSize="9" fill={T.faint}>catcher's view</text>
      <g stroke={T.muted} strokeWidth="3" strokeLinecap="round" fill="none">
        <circle cx={X(98)} cy="40" r="8" strokeWidth="2.5" />
        <line x1={X(98)} y1="48" x2={X(101)} y2="112" /><line x1={X(101)} y1="112" x2={X(84)} y2="174" /><line x1={X(101)} y1="112" x2={X(118)} y2="174" />
        <line x1={X(99)} y1="60" x2={H[0]} y2={H[1]} />
      </g>
      {done && t.swings.map((sw, i) => sw.vba != null && (() => { const [x, y] = end(sw.vba); return <line key={i} x1={H[0]} y1={H[1]} x2={x} y2={y} stroke={T.purple} strokeOpacity="0.32" strokeWidth="1.5" />; })())}
      {done && (() => { const [x, y] = end(avgGroup); return <line x1={H[0]} y1={H[1]} x2={x} y2={y} stroke="rgba(255,255,255,0.5)" strokeWidth="1.3" strokeDasharray="3 3" />; })()}
      {done && <line x1={H[0]} y1={H[1]} x2={H[0] + sx * 112} y2={H[1]} stroke="rgba(255,255,255,0.35)" strokeWidth="1" />}
      {done && <text x={H[0] + sx * 116} y={H[1] + 3} textAnchor={L ? "end" : "start"} fontSize="9" fill={T.dim}>level</text>}
      <line x1={H[0]} y1={H[1]} x2={ex} y2={ey} stroke={T.purple} strokeWidth="7" strokeLinecap="round" />
      {done && <AngleArc cx={H[0]} cy={H[1]} r={46} from={L ? 180 : 0} to={L ? 180 + v : -v} color={T.white} />}
      <circle cx={cx} cy={cy} r={done ? 5 : 1 + 4 * q} fill={T.white} opacity={done ? 1 : 0.4 + 0.6 * q} />
      <circle cx={H[0]} cy={H[1]} r="5" fill={T.text} />
      {done && <text x={L ? 6 : 314} y="26" textAnchor={L ? "start" : "end"} fontSize="22" fontWeight="700" fill={T.white}>{Math.round(v)}°</text>}
      {done && <text x={L ? 6 : 314} y="40" textAnchor={L ? "start" : "end"} fontSize="9" fill={T.muted}>barrel below the hands</text>}
    </svg>
  );
}

function BatAtContact({ t }) {
  const groupMean = (k) => mean(TESTERS.map((x) => x.sum[k]).filter((x) => x != null));
  const aa = t.sum.aa, vba = t.sum.vba;
  const dur = t.sum.ttc ?? groupMean("ttc"); // the swing plays over his own time to contact
  const [speed, setSpeed] = useState(0.07);
  const [clock, setClock] = useState(null); // null = resting at contact
  const raf = useRef(null);
  useEffect(() => { cancelAnimationFrame(raf.current); setClock(null); }, [t]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (now) => {
      if (t0 == null) t0 = now;
      const tt = ((now - t0) / 1000) * s;
      if (tt >= dur) { setClock(null); return; }
      setClock(tt); raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const done = clock == null, q = done ? 1 : clock / dur;
  const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });
  const head = (title, sub) => (<><div style={{ fontSize: 12, fontWeight: 600, color: T.text, marginTop: 6 }}>{title}</div><div style={{ fontSize: 10, color: T.dim, marginBottom: 4 }}>{sub}</div></>);
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Bat at Contact</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>Press swing to watch the barrel come into the ball. The angle shows at contact. Faint lines are each of your swings; dashed is the group average.</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 4 }}>
        <button onClick={() => play()} style={{ ...pill(false), background: T.green, color: T.bg, border: "none", fontWeight: 700 }}>Swing</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => <button key={s} style={pill(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>)}
      </div>
      {head("Attack Angle", "Is the barrel moving up or down when it meets the ball?")}
      <AttackAngleScene t={t} a={aa} q={q} done={done} avgGroup={groupMean("aa")} />
      {head("Vertical Bat Angle", "How far the barrel tilts below the hands at contact")}
      {vba == null
        ? <div style={{ fontSize: 12, color: T.dim, padding: "24px 0 12px" }}>Not captured: this session was before the six-tile Blast layout.</div>
        : <BatAngleScene t={t} v={vba} q={q} done={done} avgGroup={groupMean("vba")} />}
    </Card>
  );
}

// ─── Two routes: bat speed vs time to contact ───────────────────────────────
function Routes({ t, onPick }) {
  const pts = TESTERS.filter((x) => x.sum.ttc != null);
  if (t.sum.ttc == null) return null;
  const W = 520, H = 260, L = 44, B = 34, R = 14, TOP = 12;
  const xs = pts.map((x) => x.sum.ttc), ys = pts.map((x) => x.sum.bs);
  const x0 = Math.min(...xs) - 0.008, x1 = Math.max(...xs) + 0.008, y0 = Math.floor(Math.min(...ys) - 2), y1 = Math.ceil(Math.max(...ys) + 2);
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - B - TOP);
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Two Routes to Bat Speed</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 10 }}>Up is more bat speed. Left is a quicker swing. Tap a dot to open that hitter.</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        {[...Array(5)].map((_, i) => { const v = y0 + ((y1 - y0) * i) / 4; return <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={T.line} /><text x={L - 6} y={Y(v) + 3} textAnchor="end" fontSize="10" fill={T.faint}>{Math.round(v)}</text></g>; })}
        {[0.14, 0.16, 0.18, 0.2].filter((v) => v > x0 && v < x1).map((v) => <text key={v} x={X(v)} y={H - B + 16} textAnchor="middle" fontSize="10" fill={T.faint}>{v.toFixed(2)}</text>)}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill={T.dim}>Time to contact (s)</text>
        <text x="10" y={(H - B) / 2} textAnchor="middle" fontSize="10" fill={T.dim} transform={`rotate(-90 10 ${(H - B) / 2})`}>Bat speed (mph)</text>
        {pts.map((x) => {
          const me = x.name === t.name;
          return (
            <g key={x.name} style={{ cursor: "pointer" }} onClick={() => onPick(x.name)}>
              <circle cx={X(x.sum.ttc)} cy={Y(x.sum.bs)} r={me ? 8 : 6} fill={me ? T.green : "rgba(255,255,255,0.18)"} stroke={me ? T.bg : "none"} strokeWidth="2" />
              {me && <text x={X(x.sum.ttc) + 12} y={Y(x.sum.bs) + 4} fontSize="11" fontWeight="700" fill={T.white}>{x.name.split(" ")[0]}</text>}
            </g>
          );
        })}
      </svg>
    </Card>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
function Shell({ logo, children }) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, fontFamily: FONT, color: T.text }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 18px" }}>
        <div style={{ height: 40 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <img src={logo} alt="RPM Strength" onClick={() => { window.location.href = "/"; }} style={{ height: 30, width: "auto", cursor: "pointer" }} />
          <div style={{ width: 1, height: 22, background: "rgba(255,255,255,0.12)" }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: T.white }}>Swing Lab</div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: T.green, background: "rgba(79,255,176,0.1)", border: "1px solid rgba(79,255,176,0.25)", borderRadius: 6, padding: "2px 6px" }}>STAFF</div>
        </div>
        {children}
        <div style={{ height: 48 }} />
      </div>
    </div>
  );
}

function StaffGate({ logo, password, onOk }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    if (pw === password) { try { sessionStorage.setItem("dyn_ok", "1"); } catch (e) {} onOk(); }
    else setErr(true);
  };
  return (
    <Shell logo={logo}>
      <form onSubmit={submit} style={{ marginTop: 44, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.white, marginBottom: 6 }}>Staff access</div>
        <div style={{ fontSize: 12, color: T.dim, marginBottom: 18, lineHeight: 1.5 }}>Enter the password to open the Swing Lab.</div>
        <input type="password" value={pw} autoFocus onChange={(e) => { setPw(e.target.value); setErr(false); }} placeholder="Password"
          style={{ width: "100%", maxWidth: 280, padding: "12px 14px", border: "1px solid " + (err ? "#F97362" : "rgba(255,255,255,0.1)"), borderRadius: 10, background: "rgba(255,255,255,0.04)", color: T.white, fontSize: 14, outline: "none", textAlign: "center", boxSizing: "border-box", fontFamily: FONT }} />
        <div><button type="submit" style={{ marginTop: 14, padding: "11px 30px", border: "none", borderRadius: 10, background: T.green, color: T.bg, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>Unlock</button></div>
        {err && <div style={{ fontSize: 12, color: "#F97362", marginTop: 12 }}>Incorrect password.</div>}
      </form>
    </Shell>
  );
}

export function SwingLabPage({ logo, password }) {
  const [ok, setOk] = useState(() => { try { return sessionStorage.getItem("dyn_ok") === "1"; } catch (e) { return false; } });
  if (!ok) return <StaffGate logo={logo} password={password} onOk={() => setOk(true)} />;
  return <SwingLab logo={logo} />;
}

function SwingLab({ logo }) {
  const [name, setName] = useState("Luke Desjardins");
  const t = TESTERS.find((x) => x.name === name) || TESTERS[0];
  const pick = (n) => { setName(n); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const gc = GROUP_COLOR[t.group];
  const d = new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <Shell logo={logo}>
      <select value={name} onChange={(e) => setName(e.target.value)}
        style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: T.white, fontSize: 14, fontFamily: FONT, marginBottom: 16, outline: "none" }}>
        {["Hitter", "2W", "PO", "Staff"].map((g) => (
          <optgroup key={g} label={GROUP_LABEL[g]} style={{ background: "#14161B" }}>
            {TESTERS.filter((x) => x.group === g).map((x) => <option key={x.name} value={x.name} style={{ background: "#14161B" }}>{x.name}</option>)}
          </optgroup>
        ))}
      </select>

      <Card pad="20px 18px">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.white, lineHeight: 1.15 }}>{t.name}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>Bats {t.bats === "L" ? "left" : t.bats === "S" ? "switch" : "right"} {"·"} {d} {"·"} Baum 33/30</div>
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, color: gc, background: gc + "15", padding: "3px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>{GROUP_LABEL[t.group].toUpperCase()}</div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {[["Bat speed", fmt(t.sum.bs, 1), "mph, top 5"], ["Counted swings", String(t.swings.length), "max effort"], ["Consistency", "±" + fmt(t.sum.sdBs, 1), "mph swing to swing"]].map(([l, v, s]) => (
            <div key={l} style={{ flex: 1, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.white }}>{v}</div>
              <div style={{ fontSize: 10, color: T.faint }}>{s}</div>
            </div>
          ))}
        </div>
      </Card>

      <TimeToDecide t={t} />
      <BatAtContact t={t} />
      {METRICS.map((m) => <MetricCard key={m.k} m={m} t={t} />)}
      <Routes t={t} onPick={pick} />

      <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.6, marginTop: 8 }}>
        Blast Motion, facility Baum 33/30, off a tee, cue "swing as hard as you can and hit it hard up the middle." Counted swings only; the first max swing is a settle swing.
        Rankings are among the {TESTERS.length} people tested so far, including pitchers-only and staff. Time to decide uses a generic pitch (6 ft extension, ~9% speed loss to the plate)
        and time to contact measured from the start of the downswing, so real decision time is a little shorter. One session per hitter; none of these numbers have passed the reliability check yet.
      </div>
    </Shell>
  );
}
