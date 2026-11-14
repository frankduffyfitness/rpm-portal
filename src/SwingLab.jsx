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
import { swingModel, TAU_END, FOLLOW, BAT_LEN, UP, rad, vadd, vsub, vmul, vdot, vcross, vnorm } from "./swingModel.js";

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
// One entry per test day. A tester's default view, and his row in every group
// comparison, is his latest session; the page can switch him to an earlier one.
function withSessions(t) {
  const dates = [...new Set(t.swings.map((s) => s.date))].sort();
  const sessions = dates.map((date) => { const swings = t.swings.filter((s) => s.date === date); return { date, swings, sum: summarize({ swings }) }; });
  return { ...t, sessions, ...sessions[sessions.length - 1] };
}
const TESTERS = SWING_DATA.testers.map(withSessions);
const poolWith = (t) => TESTERS.map((x) => (x.name === t.name ? t : x)); // the group, with this hitter as currently shown
const shortDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
  const pool = poolWith(t).filter((x) => x.sum[m.k] != null);
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

// ─── Generic pitch (used by Time to Decide) ─────────────────────────────────
const FLIGHT_FT = 54.5, PLATE_FACTOR = 0.91, MPH_TO_FTS = 1.46667;
function pitch(mph) {
  const v0 = mph * MPH_TO_FTS, vf = PLATE_FACTOR * v0, a = (vf * vf - v0 * v0) / (2 * FLIGHT_FT);
  return { T: (2 * FLIGHT_FT) / (v0 + vf), dist: (t) => Math.min(FLIGHT_FT, v0 * t + 0.5 * a * t * t) };
}
const ms = (t) => Math.round(t * 1000) + " ms";

// ─── Swing path: a full 3D swing from attack angle + vertical bat angle + time to contact ─
// The swing itself comes from swingModel.js (exact at contact, generic shape elsewhere).
// This draws it: the ribbon is everywhere the bat has been, the bright line is the
// sweet spot, and the view can be dragged or snapped to a preset.
const VIEWS = { Angle: { az: 40, el: 16 }, Side: { az: 0, el: 4 }, Catcher: { az: 90, el: 10 }, Top: { az: 0, el: 80 } }; // az as seen for a lefty; mirrored for righties
const SCENE = { w: 360, h: 280, f: 400, dist: 13.5 };
const BAT_PROFILE = [[0, 0.085], [0.07, 0.085], [0.12, 0.045], [1.0, 0.05], [1.9, 0.105], [2.66, 0.108], [BAT_LEN, 0.06]]; // ft from the knob, radius

function makeCamera(az, el, target, scene = SCENE) {
  const pos = vadd(target, vmul([Math.cos(rad(el)) * Math.sin(rad(az)), Math.sin(rad(el)), Math.cos(rad(el)) * Math.cos(rad(az))], scene.dist));
  const fw = vnorm(vsub(target, pos)), rt = vnorm(vcross(fw, UP)), up = vcross(rt, fw);
  const cam = (p) => { const d = vsub(p, pos); return [vdot(d, rt), vdot(d, up), vdot(d, fw)]; };
  const flat = (c) => [scene.w / 2 + (scene.f * c[0]) / c[2], scene.h * 0.56 - (scene.f * c[1]) / c[2], c[2]];
  const proj = (p) => { const c = cam(p); return flat([c[0], c[1], Math.max(c[2], 0.5)]); };
  // Line clipped to what is in front of the camera (the floor grid runs past it).
  const seg = (a, b) => {
    let ca = cam(a), cb = cam(b);
    if (ca[2] < 1 && cb[2] < 1) return null;
    const cut = (p, q) => { const k = (1 - p[2]) / (q[2] - p[2]); return p.map((x, i) => x + (q[i] - x) * k); };
    if (ca[2] < 1) ca = cut(ca, cb); else if (cb[2] < 1) cb = cut(cb, ca);
    return [...flat(ca).slice(0, 2), ...flat(cb).slice(0, 2)];
  };
  return { proj, seg, f: scene.f };
}
const pts = (list) => list.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");

function BatShape({ cam, frame, opacity = 1 }) {
  const a = cam.proj(frame.hands), b = cam.proj(frame.tip);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const left = [], right = [];
  BAT_PROFILE.forEach(([d, r]) => {
    const c = cam.proj(vadd(frame.hands, vmul(frame.dir, d))), px = (r * cam.f) / c[2];
    left.push([c[0] + n[0] * px, c[1] + n[1] * px]); right.unshift([c[0] - n[0] * px, c[1] - n[1] * px]);
  });
  return <polygon points={pts([...left, ...right])} fill="#E3C79B" stroke="#8C6F45" strokeWidth="0.6" strokeLinejoin="round" opacity={opacity} />;
}

function SwingPath({ t }) {
  const groupMean = (k) => mean(TESTERS.map((x) => x.sum[k]).filter((x) => x != null));
  const aa = t.sum.aa, hasVba = t.sum.vba != null, vba = hasVba ? t.sum.vba : groupMean("vba");
  const lefty = t.bats === "L", side = lefty ? -1 : 1;
  const dur = t.sum.ttc ?? groupMean("ttc");
  const N = 72;
  const swing = useMemo(() => { const m = swingModel(aa, vba, lefty); return { m, frames: [...Array(N + 1)].map((_, i) => m.at((TAU_END * i) / N)), contact: m.at(1) }; }, [aa, vba, lefty]);
  // Sweet-spot path of every counted swing, each from its own two angles.
  const each = useMemo(() => t.swings.filter((s) => s.aa != null).map((s) => { const m = swingModel(s.aa, s.vba ?? vba, lefty); return [...Array(17)].map((_, i) => m.at(0.5 + (0.7 * i) / 16).sweet); }), [t, vba, lefty]);

  const home = (name) => ({ az: lefty ? VIEWS[name].az : 180 - VIEWS[name].az, el: VIEWS[name].el });
  const [view, setView] = useState(() => home("Angle"));
  const [viewName, setViewName] = useState("Angle");
  const [tau, setTau] = useState(TAU_END);
  const [speed, setSpeed] = useState(0.07);
  const raf = useRef(null), camRaf = useRef(null), drag = useRef(null);
  useEffect(() => { cancelAnimationFrame(raf.current); cancelAnimationFrame(camRaf.current); setTau(TAU_END); setView(home(viewName || "Angle")); }, [t]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); cancelAnimationFrame(camRaf.current); }, []);

  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (now) => { if (t0 == null) t0 = now; const x = (((now - t0) / 1000) * s) / dur; if (x >= TAU_END) { setTau(TAU_END); return; } setTau(x); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
  };
  const goView = (name) => {
    cancelAnimationFrame(camRaf.current); setViewName(name);
    const from = view, to = home(name), turn = ((((to.az - from.az) % 360) + 540) % 360) - 180;
    let t0 = null;
    const step = (now) => { if (t0 == null) t0 = now; const k = Math.min(1, (now - t0) / 450), e = k * k * (3 - 2 * k); setView({ az: from.az + turn * e, el: from.el + (to.el - from.el) * e }); if (k < 1) camRaf.current = requestAnimationFrame(step); };
    camRaf.current = requestAnimationFrame(step);
  };
  const onDown = (e) => { cancelAnimationFrame(camRaf.current); drag.current = { x: e.clientX, y: e.clientY, ...view }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { const d = drag.current; if (!d) return; setViewName(null); setView({ az: d.az - (e.clientX - d.x) * 0.5, el: Math.min(85, Math.max(2, d.el + (e.clientY - d.y) * 0.3)) }); };
  const onUp = () => { drag.current = null; };

  const cam = makeCamera(view.az, view.el, [-0.6, 3.3, 1.3 * side]);
  const m = swing.m, C = m.contact, hit = tau >= 1;
  const live = m.at(tau);
  const shown = swing.frames.filter((f) => f.tau < tau);
  const before = [...shown.filter((f) => f.tau <= 1), hit ? swing.contact : live];
  const after = hit ? [swing.contact, ...shown.filter((f) => f.tau > 1), live] : [];
  const quad = (a, b) => pts([cam.proj(a.hands), cam.proj(a.tip), cam.proj(b.tip), cam.proj(b.hands)]);

  // Pitch: about 6° downhill into the contact point, arriving with the barrel.
  const pitchAt = (ft) => [C[0] - ft * Math.cos(rad(6)), C[1] + ft * Math.sin(rad(6)), C[2]];
  const ballFt = 126 * dur * Math.max(0, 1 - tau); // ~86 mph at the plate
  const pitchLine = cam.seg(pitchAt(40), C);
  const ballP = cam.proj(pitchAt(ballFt)), sweetP = cam.proj(swing.contact.sweet);

  // Angle marks at contact.
  const arrowTo = cam.proj(vadd(C, vmul(m.travel, 1.9))), cP = cam.proj(C);
  const ah = Math.atan2(arrowTo[1] - cP[1], arrowTo[0] - cP[0]);
  const arrowHead = [arrowTo, [arrowTo[0] - 9 * Math.cos(ah + 0.42), arrowTo[1] - 9 * Math.sin(ah + 0.42)], [arrowTo[0] - 9 * Math.cos(ah - 0.42), arrowTo[1] - 9 * Math.sin(ah - 0.42)]];
  const aaArc = [...Array(9)].map((_, i) => cam.proj(vadd(C, vmul([-Math.cos((rad(aa) * i) / 8), Math.sin((rad(aa) * i) / 8), 0], 1.25))));
  const H = m.handsAtContact, b = m.batAtContact, flatDir = vnorm([b[0], 0, b[2]]), tilt = Math.asin(b[1]);
  const vbaArc = [...Array(9)].map((_, i) => { const g = (tilt * i) / 8; return cam.proj(vadd(H, vmul(vadd(vmul(flatDir, Math.cos(g)), [0, Math.sin(g), 0]), 1.5))); });
  const levelBat = cam.seg(H, vadd(H, vmul(flatDir, BAT_LEN))), levelPath = cam.seg(C, vadd(C, [-1.9, 0, 0]));

  const grid = [];
  for (let x = -16; x <= 6; x += 1) grid.push(cam.seg([x, 0, -7], [x, 0, 7]));
  for (let z = -7; z <= 7; z += 1) grid.push(cam.seg([-16, 0, z], [6, 0, z]));
  const plate = [[-0.71, 0, -0.71], [-0.71, 0, 0.71], [0, 0, 0.71], [0.71, 0, 0], [0, 0, -0.71]].map(cam.proj);
  const box = [[-3, 0, 1.2 * side], [3, 0, 1.2 * side], [3, 0, 5.2 * side], [-3, 0, 5.2 * side]].map(cam.proj);

  const sgn = (x) => (x > 0 ? "+" : "") + Math.round(x);
  const range = (k) => { const v = t.swings.map((s) => s[k]).filter((x) => x != null); return v.length ? `${sgn(Math.min(...v))}° to ${sgn(Math.max(...v))}°` : null; };
  const msTo = Math.round((1 - tau) * dur * 1000);
  const when = Math.abs(tau - 1) < 0.004 ? "Contact" : tau < 1 ? `${msTo} ms to contact` : `${-msTo} ms after contact`;
  const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Swing Path</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>Your swing, built from your attack angle, vertical bat angle and time to contact. The ribbon is everywhere the bat has been. Drag the picture to turn it.</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <button onClick={() => play()} style={{ ...pill(false), background: T.green, color: T.bg, border: "none", fontWeight: 700 }}>Swing</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => <button key={s} style={pill(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>View</span>
        {Object.keys(VIEWS).map((n) => <button key={n} style={pill(viewName === n)} onClick={() => goView(n)}>{n}</button>)}
      </div>
      <svg viewBox={`0 0 ${SCENE.w} ${SCENE.h}`} width="100%" role="img" aria-label={`3D swing path: attack angle ${sgn(aa)} degrees, vertical bat angle ${Math.round(vba)} degrees`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ display: "block", background: "rgba(96,165,250,0.04)", borderRadius: 12, touchAction: "pan-y", cursor: "grab", userSelect: "none" }}>
        {grid.map((g, i) => g && <line key={i} x1={g[0]} y1={g[1]} x2={g[2]} y2={g[3]} stroke="rgba(255,255,255,0.06)" />)}
        <polygon points={pts(box)} fill="none" stroke="rgba(255,255,255,0.14)" />
        <polygon points={pts(plate)} fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.3)" />
        {pitchLine && <line x1={pitchLine[0]} y1={pitchLine[1]} x2={pitchLine[2]} y2={pitchLine[3]} stroke={T.amber} strokeOpacity="0.4" strokeWidth="1.2" />}
        {hit && each.map((path, i) => <polyline key={i} points={pts(path.map(cam.proj))} fill="none" stroke={T.white} strokeOpacity="0.16" strokeWidth="1" />)}
        {before.slice(1).map((f, i) => { const k = (i + 1) / before.length; return <polygon key={i} points={quad(before[i], f)} fill={T.blue} fillOpacity={0.05 + 0.34 * k * k} />; })}
        {after.slice(1).map((f, i) => <polygon key={"a" + i} points={quad(after[i], f)} fill={T.white} fillOpacity={0.07} />)}
        <polyline points={pts([...before, ...after.slice(1)].map((f) => cam.proj(f.hands)))} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1" />
        <polyline points={pts(before.map((f) => cam.proj(f.sweet)))} fill="none" stroke={T.blue} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {after.length > 1 && <polyline points={pts(after.map((f) => cam.proj(f.sweet)))} fill="none" stroke={T.blue} strokeOpacity="0.4" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />}
        {hit && <g fill="none">
          {levelBat && <line x1={levelBat[0]} y1={levelBat[1]} x2={levelBat[2]} y2={levelBat[3]} stroke={T.purple} strokeOpacity="0.7" strokeDasharray="3 3" />}
          <polyline points={pts(vbaArc)} stroke={T.purple} strokeWidth="1.6" />
          {levelPath && <line x1={levelPath[0]} y1={levelPath[1]} x2={levelPath[2]} y2={levelPath[3]} stroke={T.red} strokeOpacity="0.7" strokeDasharray="3 3" />}
          <polyline points={pts(aaArc)} stroke={T.red} strokeWidth="1.6" />
        </g>}
        {hit && tau > 1.02 && <BatShape cam={cam} frame={live} opacity={0.4} />}
        {!hit && <circle cx={ballP[0]} cy={ballP[1]} r={Math.max(2, (0.12 * SCENE.f) / ballP[2])} fill={T.white} />}
        {hit && sweetP[2] < cP[2] + 0.01 && <circle cx={cP[0]} cy={cP[1]} r={(0.12 * SCENE.f) / cP[2]} fill={T.white} />}
        <BatShape cam={cam} frame={hit ? swing.contact : live} />
        <circle cx={cam.proj((hit ? swing.contact : live).hands)[0]} cy={cam.proj((hit ? swing.contact : live).hands)[1]} r="2.5" fill={T.text} />
        {hit && sweetP[2] >= cP[2] + 0.01 && <circle cx={cP[0]} cy={cP[1]} r={(0.12 * SCENE.f) / cP[2]} fill={T.white} />}
        {hit && <g>
          <line x1={cP[0]} y1={cP[1]} x2={arrowTo[0]} y2={arrowTo[1]} stroke={T.red} strokeWidth="3" strokeLinecap="round" />
          <polygon points={pts(arrowHead)} fill={T.red} />
        </g>}
        <g fontFamily={FONT} style={{ pointerEvents: "none" }}>
          <text x="12" y="20" fontSize="10" fill={T.muted}>{when}</text>
          {hit && <text x="12" y={SCENE.h - 26} fontSize="12" fontWeight="800" fill={T.red}>ATTACK ANGLE {sgn(aa)}°</text>}
          {hit && <text x="12" y={SCENE.h - 12} fontSize="9" fill={T.muted}>barrel {aa >= 1 ? "moving up" : aa <= -1 ? "moving down" : "level"} at contact</text>}
          {hit && <text x={SCENE.w - 12} y="20" textAnchor="end" fontSize="12" fontWeight="800" fill={hasVba ? T.purple : T.faint}>VERTICAL BAT ANGLE{hasVba ? ` ${Math.round(vba)}°` : ""}</text>}
          {hit && <text x={SCENE.w - 12} y="34" textAnchor="end" fontSize="9" fill={T.muted}>{hasVba ? "barrel below the hands" : "not captured; drawn at the group average"}</text>}
        </g>
      </svg>
      <input type="range" min="0" max={TAU_END} step="0.005" value={tau} aria-label="Step through the swing"
        onChange={(e) => { cancelAnimationFrame(raf.current); setTau(+e.target.value); }} style={{ width: "100%", accentColor: T.green, margin: "10px 0 2px" }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint }}><span>start of swing</span><span>slide to step through</span><span>follow-through</span></div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {[["Attack angle", `${sgn(aa)}°`, range("aa"), `group avg ${sgn(groupMean("aa"))}°`, T.red], ["Vertical bat angle", hasVba ? `${Math.round(vba)}°` : "–", range("vba"), `group avg ${Math.round(groupMean("vba"))}°`, T.purple]].map(([l, v, r, g, c]) => (
          <div key={l} style={{ flex: 1, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{v}</div>
            <div style={{ fontSize: 10, color: T.faint }}>{r ? `your swings ${r} · ` : ""}{g}</div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 10, color: T.faint, marginTop: 10, lineHeight: 1.5 }}>The bat's angle and the barrel's direction at contact are your Blast numbers. The rest of the swing is a model, not motion capture. Thin white lines are each of your counted swings.</div>
    </Card>
  );
}

// ─── Time to decide: the whole pitch in 3D, with the hitter's modeled swing ──
// Same generic pitch as before (54.5 ft of flight, ~9% speed loss, arriving about
// 6° downhill) and the same swing model as Swing Path. The bat waits at launch until
// the ball reaches the last moment he can start, then swings over his time to contact.
const PITCH_VIEWS = { // az as seen for a lefty, mirrored for righties; target z is toward the hitter's side
  Angle: { az: 72, el: 14, dist: 25, f: 430, target: [-5, 2.4, 1.6] },
  Side: { az: 10, el: 9, dist: 70, f: 385, target: [-24.5, 3.6, 0] },
  Catcher: { az: 90, el: 20, dist: 25, f: 400, target: [-9, 1.6, 0.8] },
};
const PSCENE = { w: 360, h: 250 };
const RELEASE_HT = 5.8;

function TimeToDecide({ t }) {
  const groupMean = (k) => mean(TESTERS.map((x) => x.sum[k]).filter((x) => x != null));
  const ttc = t.sum.ttc, avgTtc = groupMean("ttc");
  const aa = t.sum.aa, vba = t.sum.vba ?? groupMean("vba"), lefty = t.bats === "L";
  const home = (name) => { const v = PITCH_VIEWS[name]; return { ...v, az: lefty ? v.az : 180 - v.az, target: [v.target[0], v.target[1], v.target[2] * (lefty ? -1 : 1)] }; };
  const [mph, setMph] = useState(90);
  const [speed, setSpeed] = useState(0.2);
  const [clock, setClock] = useState(null); // null = finished
  const [view, setView] = useState(() => home("Angle"));
  const [viewName, setViewName] = useState("Angle");
  const raf = useRef(null), camRaf = useRef(null), drag = useRef(null), bar = useRef(null), scrubbing = useRef(false);
  const P = useMemo(() => pitch(mph), [mph]);
  const swing = useMemo(() => { const m = swingModel(aa, vba, lefty), N = 56; return { m, frames: [...Array(N + 1)].map((_, i) => m.at((TAU_END * i) / N)), contact: m.at(1) }; }, [aa, vba, lefty]);
  useEffect(() => { cancelAnimationFrame(raf.current); setClock(null); }, [t, mph]);
  useEffect(() => { cancelAnimationFrame(camRaf.current); setView(home(viewName || "Angle")); }, [t]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); cancelAnimationFrame(camRaf.current); }, []);
  if (ttc == null) return null;

  const tStart = P.T - ttc, total = P.T + FOLLOW * ttc, now = clock == null ? total : clock;
  const tau = now <= tStart ? 0 : Math.min(TAU_END, (now - tStart) / ttc);
  const feels = FLIGHT_FT / (((1 + PLATE_FACTOR) / 2) * MPH_TO_FTS * (tStart + avgTtc));

  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (ts) => { if (t0 == null) t0 = ts; const x = ((ts - t0) / 1000) * s; if (x >= total) { setClock(null); return; } setClock(x); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
  };
  const goView = (name) => {
    cancelAnimationFrame(camRaf.current); setViewName(name);
    const from = view, to = home(name), turn = ((((to.az - from.az) % 360) + 540) % 360) - 180;
    let t0 = null;
    const step = (ts) => {
      if (t0 == null) t0 = ts;
      const k = Math.min(1, (ts - t0) / 500), e = k * k * (3 - 2 * k), mix = (a, b) => a + (b - a) * e;
      setView({ az: from.az + turn * e, el: mix(from.el, to.el), dist: mix(from.dist, to.dist), f: mix(from.f, to.f), target: from.target.map((x, i) => mix(x, to.target[i])) });
      if (k < 1) camRaf.current = requestAnimationFrame(step);
    };
    camRaf.current = requestAnimationFrame(step);
  };
  const onDown = (e) => { cancelAnimationFrame(camRaf.current); drag.current = { x: e.clientX, y: e.clientY, az: view.az, el: view.el }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => { const d = drag.current; if (!d) return; setViewName(null); setView((v) => ({ ...v, az: d.az - (e.clientX - d.x) * 0.5, el: Math.min(85, Math.max(2, d.el + (e.clientY - d.y) * 0.3)) })); };
  const onUp = () => { drag.current = null; };
  const scrub = (e) => { const r = bar.current.getBoundingClientRect(); cancelAnimationFrame(raf.current); setClock(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * total); };

  const cam = makeCamera(view.az, view.el, view.target, { ...PSCENE, dist: view.dist, f: view.f });
  const m = swing.m, C = m.contact, side = lefty ? -1 : 1;
  // Ball flight: straight at the plate, dropping on a curve that arrives ~6° downhill at the contact point.
  const rel = [C[0] - FLIGHT_FT, RELEASE_HT, 0], drop = C[1] - RELEASE_HT;
  const curve = (-Math.tan(rad(6)) * FLIGHT_FT - drop) / (FLIGHT_FT * FLIGHT_FT), slope = drop / FLIGHT_FT - curve * FLIGHT_FT;
  const ballAt = (time) => { const s = P.dist(Math.max(0, Math.min(time, P.T))); return [rel[0] + s, RELEASE_HT + slope * s + curve * s * s, 0]; };
  const K = 48, times = [...Array(K + 1)].map((_, i) => (P.T * i) / K);
  const flown = (from, to) => { const end = Math.min(to, now); if (end <= from) return []; return [from, ...times.filter((x) => x > from && x < end), end].map(ballAt); };
  const gate = ballAt(tStart), ftOut = Math.round(FLIGHT_FT - P.dist(tStart));
  const ghosts = []; for (let g = 0.05; g < Math.min(now, P.T) - 0.01; g += 0.05) ghosts.push(g);

  const hit = tau >= 1, live = m.at(tau), bat = hit ? swing.contact : live;
  const shown = swing.frames.filter((f) => f.tau < tau);
  const before = tau > 0 ? [...shown.filter((f) => f.tau <= 1), bat] : [];
  const after = hit ? [swing.contact, ...shown.filter((f) => f.tau > 1), live] : [];
  const quad = (a, b) => pts([cam.proj(a.hands), cam.proj(a.tip), cam.proj(b.tip), cam.proj(b.hands)]);

  const ballNow = now < P.T ? ballAt(now) : C, ballP = cam.proj(ballNow), ballR = Math.max(1.8, (0.12 * view.f) / ballP[2]);
  const ballInFront = ballP[2] < cam.proj(bat.sweet)[2];
  const ball = <circle cx={ballP[0]} cy={ballP[1]} r={ballR} fill={T.white} />;
  const gateP = cam.proj(gate), gateFoot = cam.seg([gate[0], 0, 0], gate), relPost = cam.seg([rel[0], 0, 0], rel), relP = cam.proj(rel);
  const lane = cam.seg([rel[0], 0, 0], [C[0], 0, 0]);
  const grid = [];
  for (let x = -66; x <= 8; x += 2) grid.push(cam.seg([x, 0, -8], [x, 0, 8]));
  for (let z = -8; z <= 8; z += 2) grid.push(cam.seg([-66, 0, z], [8, 0, z]));
  const marks = [10, 20, 30, 40, 50].map((d) => ({ d, p: cam.proj([C[0] - d, 0, 0]), tick: cam.seg([C[0] - d, 0, -0.8], [C[0] - d, 0, 0.8]) }));
  const plate = [[-0.71, 0, -0.71], [-0.71, 0, 0.71], [0, 0, 0.71], [0.71, 0, 0], [0, 0, -0.71]].map(cam.proj);
  const box = [[-3, 0, 1.2 * side], [3, 0, 1.2 * side], [3, 0, 5.2 * side], [-3, 0, 5.2 * side]].map(cam.proj);
  const mound = [...Array(24)].map((_, i) => cam.proj([rel[0] - 4 + 9 * Math.cos((i * Math.PI) / 12), 0, 9 * Math.sin((i * Math.PI) / 12)]));
  const rubber = [[rel[0] - 6.2, 0, -1], [rel[0] - 5.7, 0, -1], [rel[0] - 5.7, 0, 1], [rel[0] - 6.2, 0, 1]].map(cam.proj);

  const phase = now <= 0 ? "Ready" : now < tStart ? "Seeing and deciding" : now < P.T ? "Swinging" : "Contact";
  const phaseColor = now < tStart ? T.green : now < P.T ? T.orange : T.white;
  const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });
  const stat = (l, v, s, c = T.white) => (
    <div style={{ flex: "1 1 120px", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: c }}>{v}</div>
      <div style={{ fontSize: 10, color: T.faint }}>{s}</div>
    </div>
  );
  const pct = (x) => `${((x / total) * 100).toFixed(1)}%`;
  const labelLeft = gateP[0] > PSCENE.w - 90, labelX = gateP[0] + (labelLeft ? -9 : 9), labelY = Math.max(24, gateP[1] - 4);
  let lastMark = null;
  const shownMarks = marks.filter(({ p, tick }) => { if (!tick || p[2] <= 1 || (lastMark && Math.hypot(p[0] - lastMark[0], p[1] - lastMark[1]) < 17)) return false; lastMark = p; return true; });

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Time to Decide</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 14, lineHeight: 1.45 }}>How much of the pitch you get to see before you have to start your swing. Green is time to see and decide. Orange is your swing. Drag the picture to turn it.</div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: T.muted }}>Fastball</span>
        <input type="range" min="60" max="100" step="1" value={mph} aria-label="Fastball speed" onChange={(e) => setMph(+e.target.value)} style={{ flex: 1, accentColor: T.green }} />
        <span style={{ fontSize: 16, fontWeight: 700, color: T.white, minWidth: 62, textAlign: "right" }}>{mph} mph</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <button onClick={() => play()} style={{ ...pill(false), background: T.green, color: T.bg, border: "none", fontWeight: 700 }}>Pitch</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => <button key={s} style={pill(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>View</span>
        {Object.keys(PITCH_VIEWS).map((n) => <button key={n} style={pill(viewName === n)} onClick={() => goView(n)}>{n}</button>)}
      </div>
      <svg viewBox={`0 0 ${PSCENE.w} ${PSCENE.h}`} width="100%" role="img" aria-label={`A ${mph} mph fastball from release to contact. ${t.name} must start his swing with the ball ${ftOut} feet away.`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ display: "block", background: "rgba(96,165,250,0.04)", borderRadius: 12, touchAction: "pan-y", cursor: "grab", userSelect: "none" }}>
        {grid.map((g, i) => g && <line key={i} x1={g[0]} y1={g[1]} x2={g[2]} y2={g[3]} stroke="rgba(255,255,255,0.05)" />)}
        <polygon points={pts(mound)} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.1)" />
        <polygon points={pts(rubber)} fill="rgba(255,255,255,0.35)" />
        {lane && <line x1={lane[0]} y1={lane[1]} x2={lane[2]} y2={lane[3]} stroke="rgba(255,255,255,0.12)" />}
        <g fontFamily={FONT} style={{ pointerEvents: "none" }}>
          {shownMarks.map(({ d, p, tick }) => <g key={d}><line x1={tick[0]} y1={tick[1]} x2={tick[2]} y2={tick[3]} stroke="rgba(255,255,255,0.3)" /><text x={p[0]} y={p[1] + 11} textAnchor="middle" fontSize="8" fill={T.faint}>{d} ft</text></g>)}
        </g>
        <polygon points={pts(box)} fill="none" stroke="rgba(255,255,255,0.14)" />
        <polygon points={pts(plate)} fill="rgba(255,255,255,0.16)" stroke="rgba(255,255,255,0.3)" />
        {relPost && <line x1={relPost[0]} y1={relPost[1]} x2={relPost[2]} y2={relPost[3]} stroke="rgba(255,255,255,0.25)" />}
        <circle cx={relP[0]} cy={relP[1]} r="2.5" fill="none" stroke={T.muted} />
        <polyline points={pts(times.map(ballAt).map(cam.proj))} fill="none" stroke="rgba(255,255,255,0.14)" strokeDasharray="2 4" />
        <polyline points={pts(flown(0, tStart).map(cam.proj))} fill="none" stroke={T.green} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        <polyline points={pts(flown(tStart, P.T).map(cam.proj))} fill="none" stroke={T.orange} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        {ghosts.map((g) => { const p = cam.proj(ballAt(g)); return <circle key={g} cx={p[0]} cy={p[1]} r={Math.max(1.4, (0.1 * view.f) / p[2])} fill={T.white} opacity="0.5" />; })}
        {gateFoot && <line x1={gateFoot[0]} y1={gateFoot[1]} x2={gateFoot[2]} y2={gateFoot[3]} stroke={T.orange} strokeWidth="1.5" strokeDasharray="3 3" />}
        <circle cx={gateP[0]} cy={gateP[1]} r="4" fill={T.bg} stroke={T.orange} strokeWidth="2" />
        {before.slice(1).map((f, i) => { const k = (i + 1) / before.length; return <polygon key={i} points={quad(before[i], f)} fill={T.orange} fillOpacity={0.05 + 0.3 * k * k} />; })}
        {after.slice(1).map((f, i) => <polygon key={"a" + i} points={quad(after[i], f)} fill={T.white} fillOpacity={0.07} />)}
        {before.length > 1 && <polyline points={pts(before.map((f) => cam.proj(f.sweet)))} fill="none" stroke={T.orange} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {hit && tau > 1.02 && <BatShape cam={cam} frame={live} opacity={0.4} />}
        {!ballInFront && ball}
        <BatShape cam={cam} frame={bat} />
        <circle cx={cam.proj(bat.hands)[0]} cy={cam.proj(bat.hands)[1]} r="2.5" fill={T.text} />
        {ballInFront && ball}
        <g fontFamily={FONT} style={{ pointerEvents: "none" }}>
          <text x={labelX} y={labelY} textAnchor={labelLeft ? "end" : "start"} fontSize="10" fontWeight="700" fill={T.orange}>MUST START</text>
          <text x={labelX} y={labelY + 11} textAnchor={labelLeft ? "end" : "start"} fontSize="9" fill={T.text}>{ftOut} ft out</text>
          <text x={relP[0]} y={relP[1] - 7} textAnchor="middle" fontSize="8" fill={T.faint}>release</text>
          <text x="12" y="20" fontSize="12" fontWeight="700" fill={phaseColor}>{phase}</text>
          <text x={PSCENE.w - 12} y="20" textAnchor="end" fontSize="10" fill={T.muted}>{ms(Math.min(now, P.T))} after release</text>
        </g>
      </svg>
      <div ref={bar} role="slider" aria-label="Step through the pitch" aria-valuemin={0} aria-valuemax={Math.round(total * 1000)} aria-valuenow={Math.round(now * 1000)}
        onPointerDown={(e) => { scrubbing.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); scrub(e); }} onPointerMove={(e) => scrubbing.current && scrub(e)}
        onPointerUp={() => { scrubbing.current = false; }} onPointerCancel={() => { scrubbing.current = false; }}
        style={{ position: "relative", display: "flex", height: 16, borderRadius: 8, overflow: "hidden", marginTop: 10, cursor: "ew-resize", touchAction: "none" }}>
        <div style={{ width: pct(tStart), background: "rgba(79,255,176,0.4)" }} />
        <div style={{ width: pct(ttc), background: "rgba(255,140,66,0.55)" }} />
        <div style={{ flex: 1, background: "rgba(255,255,255,0.08)" }} />
        <div style={{ position: "absolute", left: pct(now), top: 0, bottom: 0, width: 3, background: T.white, transform: "translateX(-50%)" }} />
      </div>
      <div style={{ position: "relative", height: 26, fontSize: 9, color: T.faint, marginTop: 4 }}>
        <span style={{ position: "absolute", left: 0 }}>release</span>
        <span style={{ position: "absolute", left: pct(tStart), transform: "translateX(-50%)", textAlign: "center", color: T.orange, whiteSpace: "nowrap" }}>must start<br />{ms(tStart)}</span>
        <span style={{ position: "absolute", left: pct(P.T), transform: "translateX(-50%)", textAlign: "center", color: T.text, whiteSpace: "nowrap" }}>contact<br />{ms(P.T)}</span>
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        {stat("Time to decide", ms(tStart), "before you start", T.green)}
        {stat("Your swing", ms(ttc), "time to contact", T.orange)}
        {stat("Pitch flight", ms(P.T), "release to plate")}
        {stat("Feels like", Math.round(feels) + " mph", "for an average swing")}
      </div>
    </Card>
  );
}

// ─── Two routes: bat speed vs time to contact ───────────────────────────────
function Routes({ t, onPick }) {
  const pts = poolWith(t).filter((x) => x.sum.ttc != null);
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
  const [day, setDay] = useState(null); // null = latest session
  const base = TESTERS.find((x) => x.name === name) || TESTERS[0];
  const session = base.sessions.find((s) => s.date === day) || base.sessions[base.sessions.length - 1];
  const t = useMemo(() => ({ ...base, ...session }), [base, session]);
  const prev = base.sessions[base.sessions.indexOf(session) - 1];
  const delta = prev ? t.sum.bs - prev.sum.bs : null;
  const pick = (n) => { setName(n); setDay(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const gc = GROUP_COLOR[t.group];
  const d = new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <Shell logo={logo}>
      <select value={name} onChange={(e) => { setName(e.target.value); setDay(null); }}
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
        {base.sessions.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
            <span style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>Session</span>
            {base.sessions.map((s, i) => { const on = s === session; return (
              <button key={s.date} onClick={() => setDay(s.date)} style={{ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontFamily: FONT,
                border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted }}>{i + 1}: {shortDate(s.date)}</button>
            ); })}
            {delta != null && <span style={{ fontSize: 11, color: T.muted, marginLeft: 4 }}>{delta >= 0 ? "+" : ""}{delta.toFixed(1)} mph vs {shortDate(prev.date)}</span>}
          </div>
        )}
      </Card>

      <TimeToDecide t={t} />
      <SwingPath t={t} />
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
