// Pitch Lab: unlinked staff preview (/pitchlab) of pitch movement in 3D.
//
// Stage 1 (2026-11-13): one flight per pitch type from the arsenal averages.
// Stage 2 (2026-11-13): two ways of aiming the pitches, every individual pitch on a
// movement scatter (tap one to throw it), and his real plate locations.
//
//   Shape  : every pitch is aimed at the same spot, so the only differences on
//            screen are release point and movement. Focus a pitch to see its no-spin
//            twin and the break in inches.
//   Tunnel : his fastball is thrown at the top of the zone and every other pitch is
//            thrown down the same lane, crossing the hitter's decision point at the
//            same place, from that pitch's own release point. What happens after the
//            decision point is pure physics. This is what a hitter is up against:
//            the same look early, different pitches late.
//
// Physics: constant acceleration from release to the front of the plate. Gravity, a
// drag deceleration worth about 9% of release speed, and the measured break, which
// TrackMan defines as the deviation from a no-spin flight over that same distance.
// World (scene3d.js): x toward the catcher, y up, +z = third-base side.
// TrackMan signs: release side, horizontal break, and the location plot's x are all
// positive toward the pitcher's right, the third-base side, so they map onto +z.
// (Location orientation checked on the data 2026-11-13: for 51 of 56 right-handers the
// breaking balls sit at more negative x than changeups and sinkers; lefties mirror.)
import { useEffect, useMemo, useRef, useState } from "react";
import { makeCamera, orbitFrom, vlerp } from "./scene3d.js";

const T = { bg: "#0A0C10", card: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.06)",
  text: "#E0E0E0", white: "#fff", muted: "#8A8F98", dim: "#6B7280", faint: "#4a4f57",
  green: "#4FFFB0", blue: "#60A5FA", amber: "#FFB020", orange: "#FF8C42", red: "#FF4D4D", purple: "#A78BFA" };
const FONT = "'DM Sans','Helvetica Neue',sans-serif";
const LEVEL = { hs: "High school", col: "College", pro: "Pro", ms: "Middle school", ml: "Men's league" };

const G = 32.174, MPH_TO_FTS = 1.46667, PLATE_FACTOR = 0.91;
const RUBBER_X = -(60.5 - 17 / 12);      // rubber to the FRONT of the plate
const SHAPE_TARGET = [0, 2.5, 0];        // Shape: every pitch is aimed here
const TUNNEL_TARGET = [0, 3.1, 0];       // Tunnel: the fastball is aimed here, top of the zone
const DECIDE_X = -23.8;                  // the hitter's decision point, 23.8 ft in front of the plate
const ZONE = { half: 17 / 24, lo: 1.5, hi: 3.5 };
const BALL_R = 0.121;
const MIN_PITCHES = 5;
// Session labels kept off the scatter: Low Effort, Rehab, Pitch Design, Short Slope, Mound Drills.
const LOW_INTENT = /low|rehab|design|slope|drill/i;

// One pitch's flight. q = { velo, ivb, hb, ext, relH, relSide }.
// aim = [x, y, z]: the pitch passes through (y, z) as it crosses the plane at x.
function makeFlight(q, aim) {
  const x0 = RUBBER_X + q.ext, D = -x0;
  const v0 = q.velo * MPH_TO_FTS, vf = PLATE_FACTOR * v0;
  const ax = (vf * vf - v0 * v0) / (2 * D), time = (2 * D) / (v0 + vf);
  const ay = -G + (2 * (q.ivb / 12)) / (time * time), az = (2 * (q.hb / 12)) / (time * time);
  const timeAt = (x) => (x >= 0 ? time : (-v0 + Math.sqrt(v0 * v0 + 2 * ax * (x - x0))) / ax);
  const tp = timeAt(aim[0]);
  const vy = (aim[1] - q.relH - 0.5 * ay * tp * tp) / tp, vz = (aim[2] - q.relSide - 0.5 * az * tp * tp) / tp;
  const clampT = (t) => Math.max(0, Math.min(t, time));
  const raw = (s) => [x0 + v0 * s + 0.5 * ax * s * s, q.relH + vy * s + 0.5 * ay * s * s, q.relSide + vz * s + 0.5 * az * s * s];
  const at = (t) => { const p = raw(clampT(t)); return [p[0], Math.max(BALL_R, p[1]), p[2]]; };
  // Same release and the same first move out of the hand, with spin switched off.
  const ghostAt = (t) => { const s = clampT(t); return [x0 + v0 * s + 0.5 * ax * s * s, Math.max(BALL_R, q.relH + vy * s - 0.5 * G * s * s), q.relSide + vz * s]; };
  return { q, time, at, ghostAt, tDecide: timeAt(DECIDE_X), rel: [x0, q.relH, q.relSide], end: raw(time), decide: raw(timeAt(DECIDE_X)) };
}

// Arsenal type row (gen_arsenal_portal.py): [name, n, use%, veloAvg, veloMax, ivb, hb,
// spin, tilt, eff, ext, relH, relSide, shape+, grade, zone%, thin].
// Session type row (_TMR): [name, count, veloAvg, veloMax, ivb, hb, spin, ext, relH, relSide, eff, n].
// Session dots (_TMR): [typeIdx, ivb, hb, relH, relSide, velo, ext].
function buildPitcher(name, a, sessions) {
  const rows = (a.types || []).filter((r) => r[0] !== "Other" && r[1] >= MIN_PITCHES && [3, 5, 6, 11, 12].every((i) => r[i] != null));
  if (!rows.length) return null;
  const exts = rows.map((r) => r[10]).filter((x) => x != null).sort((x, y) => x - y);
  const extFallback = exts.length ? exts[Math.floor(exts.length / 2)] : 6.0;
  const types = rows.map((r) => ({ name: r[0], n: r[1], use: r[2], velo: r[3], vmax: r[4], ivb: r[5], hb: r[6], ext: r[10] ?? extFallback, relH: r[11], relSide: r[12], extAssumed: r[10] == null }))
    .sort((x, y) => y.n - x.n);
  const byName = Object.fromEntries(types.map((t) => [t.name, t]));
  const fb = types.find((t) => t.name === "Fastball" || t.name === "Sinker") || types[0];
  const allNames = (a.types || []).map((r) => r[0]);
  const loc = (a.loc || []).map((l) => ({ type: allNames[l[0]], z: l[1], y: l[2] })).filter((l) => byName[l.type]);
  const pitches = [];
  (sessions || []).forEach((s) => {
    if (LOW_INTENT.test(s.st || "")) return;
    (s.dots || []).forEach((d) => {
      const row = s.types?.[d[0]], type = row?.[0], t = byName[type];
      if (!t || d[1] == null || d[2] == null || d[3] == null || d[4] == null) return;
      const velo = d[5] ?? row[2] ?? t.velo;
      if (velo == null) return;
      pitches.push({ type, ivb: d[1], hb: d[2], relH: d[3], relSide: d[4], velo, ext: d[6] ?? row[7] ?? t.ext, date: s.df || s.d });
    });
  });
  return { name, lvl: a.lvl, n: a.n, types, byName, ref: fb.name, throws: fb.relSide >= 0 ? "R" : "L", loc, pitches };
}

const lastName = (n) => { const p = n.trim().split(/\s+/); return (p[p.length - 1] + " " + p[0]).toLowerCase(); };
const sgn = (v, d = 1) => (v > 0 ? "+" : "") + v.toFixed(d);
const inches = (v) => `${Math.abs(v).toFixed(0)} in`;

// ─── Views: where the camera stands and what it looks at ────────────────────
const SCENE = { w: 360, h: 300, cy: 0.5 };
const viewDefs = (bat) => {
  const s = bat === "R" ? 1 : -1; // a right-handed hitter stands on the third-base side
  return {
    // Catcher and Pitcher are telephoto (stand well back, zoom in): it flattens the
    // perspective so the flights fill the frame and break reads as curvature.
    Catcher: { pos: [40, 4.5, 0], target: [-10, 3.2, 0], f: 1900 },
    // Over the hitter's back shoulder, so the plate stays in the picture and you can
    // watch the pitches arrive. A true eye view loses the ball beside the body.
    Hitter: { pos: [6.5, 6.4, 3.2 * s], target: [-9, 0.8, -1.0 * s], f: 300 },
    Pitcher: { pos: [-100, 11, 0], target: [-24, 3.9, 0], f: 2300 },
  };
};
const toOrbit = (v) => ({ ...orbitFrom(v.pos, v.target), target: v.target, f: v.f });

const Card = ({ children, pad = "18px 16px" }) => <div style={{ background: T.card, border: T.border, borderRadius: 16, padding: pad, marginBottom: 12 }}>{children}</div>;
const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });
const stat = (l, v, s, c = T.white) => (
  <div style={{ flex: "1 1 130px", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
    <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
    <div style={{ fontSize: 19, fontWeight: 700, color: c }}>{v}</div>
    <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.4 }}>{s}</div>
  </div>
);

// ─── Every pitch: horizontal break against vertical break, pitcher's view ───
function MovementScatter({ p, color, focus, sel, onPick }) {
  const W = 340, H = 300, M = { l: 34, r: 12, t: 12, b: 30 };
  const R = Math.min(30, Math.max(20, Math.ceil(p.pitches.reduce((m, d) => Math.max(m, Math.abs(d.hb), Math.abs(d.ivb)), 0) / 10) * 10));
  const X = (v) => M.l + ((v + R) / (2 * R)) * (W - M.l - M.r), Y = (v) => H - M.b - ((v + R) / (2 * R)) * (H - M.t - M.b);
  const ticks = []; for (let v = -R; v <= R; v += 10) ticks.push(v);
  const svg = useRef(null);
  const pick = (e) => {
    const r = svg.current.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    let best = null, bd = 14;
    p.pitches.forEach((d, i) => { if (focus && d.type !== focus) return; const k = Math.hypot(X(d.hb) - x, Y(d.ivb) - y); if (k < bd) { bd = k; best = i; } });
    if (best != null) onPick(best);
  };
  const S = sel != null ? p.pitches[sel] : null;
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Every Pitch</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 10, lineHeight: 1.45 }}>{p.pitches.length} tracked pitches, each dot placed by how far it moved. Tap a dot to throw that pitch above. Rings are the average for each pitch type.</div>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width="100%" onPointerDown={pick} style={{ display: "block", cursor: "pointer", touchAction: "manipulation" }} role="img" aria-label={`Movement of ${p.pitches.length} pitches`}>
        {ticks.map((v) => (<g key={v}>
          <line x1={X(v)} y1={M.t} x2={X(v)} y2={H - M.b} stroke={v === 0 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.05)"} strokeWidth="1" />
          <line x1={M.l} y1={Y(v)} x2={W - M.r} y2={Y(v)} stroke={v === 0 ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.05)"} strokeWidth="1" />
          <text x={X(v)} y={H - M.b + 12} textAnchor="middle" style={{ fontSize: 8, fill: T.faint, fontFamily: FONT }}>{v}</text>
          <text x={M.l - 5} y={Y(v) + 3} textAnchor="end" style={{ fontSize: 8, fill: T.faint, fontFamily: FONT }}>{v}</text>
        </g>))}
        {p.pitches.map((d, i) => <circle key={i} cx={X(d.hb)} cy={Y(d.ivb)} r="2.6" fill={color(d.type)} fillOpacity={focus && d.type !== focus ? 0.08 : 0.55} />)}
        {p.types.map((t) => <circle key={t.name} cx={X(t.hb)} cy={Y(t.ivb)} r="6.5" fill="none" stroke={color(t.name)} strokeWidth="1.8" strokeOpacity={focus && t.name !== focus ? 0.2 : 1} />)}
        {S && <circle cx={X(S.hb)} cy={Y(S.ivb)} r="5.5" fill={color(S.type)} stroke={T.white} strokeWidth="1.8" />}
        <text x={(M.l + W - M.r) / 2} y={H - 4} textAnchor="middle" style={{ fontSize: 8.5, fill: T.dim, letterSpacing: 0.6, fontFamily: FONT }}>HORIZONTAL BREAK (IN), PITCHER&apos;S VIEW</text>
        <text x={9} y={(M.t + H - M.b) / 2} textAnchor="middle" transform={`rotate(-90 9 ${(M.t + H - M.b) / 2})`} style={{ fontSize: 8.5, fill: T.dim, letterSpacing: 0.6, fontFamily: FONT }}>VERTICAL BREAK (IN)</text>
      </svg>
    </Card>
  );
}

function PitchView({ p, colors }) {
  const color = (n) => colors?.[n] || T.muted;
  const [mode, setMode] = useState("shape");
  const [bat, setBat] = useState("R");
  const [viewName, setViewName] = useState("Catcher");
  const [view, setView] = useState(() => toOrbit(viewDefs("R").Catcher));
  const [focus, setFocus] = useState(null);
  const [sel, setSel] = useState(null);
  const [showLoc, setShowLoc] = useState(false);
  const [speed, setSpeed] = useState(0.2);
  const [clock, setClock] = useState(null); // null = finished, every ball at the plate
  const raf = useRef(null), camRaf = useRef(null), drag = useRef(null), sceneCard = useRef(null);

  useEffect(() => { cancelAnimationFrame(raf.current); setClock(null); setFocus(null); setSel(null); }, [p]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); cancelAnimationFrame(camRaf.current); }, []);

  // Flights for this mode. In Tunnel every pitch crosses the decision point where the fastball does.
  const F = useMemo(() => {
    const ref = makeFlight(p.byName[p.ref], mode === "shape" ? SHAPE_TARGET : TUNNEL_TARGET);
    const lane = [DECIDE_X, ref.decide[1], ref.decide[2]];
    const aim = (name) => (mode === "shape" ? SHAPE_TARGET : name === p.ref ? TUNNEL_TARGET : lane);
    const types = p.types.map((q) => ({ name: q.name, ...makeFlight(q, aim(q.name)) }));
    const S = sel != null ? p.pitches[sel] : null;
    const one = S ? { name: S.type, ...makeFlight(S, mode === "shape" ? SHAPE_TARGET : lane) } : null;
    return { types, ref: types.find((t) => t.name === p.ref), lane, one };
  }, [p, mode, sel]);

  const shown = F.types.filter((t) => !focus || t.name === focus || (mode === "tunnel" && t.name === p.ref));
  const tmax = Math.max(...shown.map((t) => t.time), F.one ? F.one.time : 0);
  const now = clock == null ? tmax : Math.min(clock, tmax);
  const FQ = focus ? p.byName[focus] : null, focusFlight = focus ? F.types.find((t) => t.name === focus) : null;

  const play = (s = speed, until = tmax) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (ts) => { if (t0 == null) t0 = ts; const x = ((ts - t0) / 1000) * s; if (x >= until) { setClock(null); return; } setClock(x); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
  };
  const goView = (name, forBat = bat) => {
    cancelAnimationFrame(camRaf.current);
    setViewName(name);
    const from = view, to = toOrbit(viewDefs(forBat)[name]), turn = ((to.az - from.az + 540) % 360) - 180;
    let t0 = null;
    const step = (ts) => {
      if (t0 == null) t0 = ts;
      const k = Math.min(1, (ts - t0) / 500), e = k * k * (3 - 2 * k);
      setView({ az: from.az + turn * e, el: from.el + (to.el - from.el) * e, dist: from.dist + (to.dist - from.dist) * e, f: from.f + (to.f - from.f) * e, target: vlerp(from.target, to.target, e) });
      if (k < 1) camRaf.current = requestAnimationFrame(step);
    };
    camRaf.current = requestAnimationFrame(step);
  };
  const pickBat = (b) => { setBat(b); goView("Hitter", b); };
  const pickMode = (m) => { cancelAnimationFrame(raf.current); setClock(null); setMode(m); if (m === "tunnel" && viewName !== "Hitter") goView("Hitter"); };
  const onDown = (e) => { cancelAnimationFrame(camRaf.current); drag.current = { x: e.clientX, y: e.clientY, az: view.az, el: view.el }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    setViewName(null);
    setView((v) => ({ ...v, az: d.az - (e.clientX - d.x) * 0.4, el: Math.max(-8, Math.min(85, d.el + (e.clientY - d.y) * 0.3)) }));
  };
  const onUp = () => { drag.current = null; };
  const throwOne = (i) => {
    setFocus(null); setSel(i);
    sceneCard.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    const q = p.pitches[i];
    play(speed, makeFlight(q, SHAPE_TARGET).time);
  };

  const cam = makeCamera(view, SCENE);

  // Field.
  const grid = [];
  for (let x = -70; x <= 10; x += 5) grid.push(cam.seg([x, 0, -10], [x, 0, 10]));
  for (let z = -10; z <= 10; z += 5) grid.push(cam.seg([-70, 0, z], [10, 0, z]));
  const loop = (list) => cam.path([...list, list[0]]);
  const mound = loop([...Array(28)].map((_, i) => [RUBBER_X + 1.5 + 9 * Math.cos((i * Math.PI) / 14), 0, 9 * Math.sin((i * Math.PI) / 14)]));
  const rubber = loop([[RUBBER_X - 0.5, 0, -1], [RUBBER_X, 0, -1], [RUBBER_X, 0, 1], [RUBBER_X - 0.5, 0, 1]]);
  const plate = loop([[0, 0, -ZONE.half], [0, 0, ZONE.half], [ZONE.half, 0, ZONE.half], [2 * ZONE.half, 0, 0], [ZONE.half, 0, -ZONE.half]]);
  const box = (s) => loop([[-2.29, 0, 1.21 * s], [3.71, 0, 1.21 * s], [3.71, 0, 5.21 * s], [-2.29, 0, 5.21 * s]]);
  const batSide = bat === "R" ? 1 : -1;
  const zone = loop([[0, ZONE.lo, -ZONE.half], [0, ZONE.lo, ZONE.half], [0, ZONE.hi, ZONE.half], [0, ZONE.hi, -ZONE.half]]);
  const lane = cam.seg([RUBBER_X, 0, 0], [0, 0, 0]);

  // Flights.
  const K = 44;
  const range = (fn, t0, t1) => { if (t1 <= t0) return []; const out = []; for (let i = 0; i <= K; i++) out.push(fn(t0 + ((t1 - t0) * i) / K)); return out; };
  const draw = (fl) => ({
    fl, pre: cam.path(range(fl.at, 0, mode === "tunnel" ? fl.tDecide : fl.time)), post: mode === "tunnel" ? cam.path(range(fl.at, fl.tDecide, fl.time)) : [],
    flown: clock != null && now > 0 ? cam.path(range(fl.at, 0, Math.min(now, fl.time))) : [],
    rel: cam.depth(fl.rel) > 1 ? cam.proj(fl.rel) : null, end: cam.depth(fl.at(fl.time)) > 1 ? cam.proj(fl.at(fl.time)) : null, ball: fl.at(now),
  });
  const flights = shown.map(draw), one = F.one ? draw(F.one) : null;
  const balls = (one ? [one] : flights).map((d) => ({ d, depth: cam.depth(d.ball), q: cam.proj(d.ball) })).filter((b) => b.depth > 1).sort((a, b) => b.depth - a.depth);
  const dimAll = one ? 0.16 : 1;

  // Shape mode: the no-spin ghost and the break it reveals, for the focused pitch.
  let ghost = null;
  if (mode === "shape" && focusFlight && !one) {
    const end = focusFlight.ghostAt(focusFlight.time), corner = [0, SHAPE_TARGET[1], end[2]];
    ghost = { path: cam.path(range(focusFlight.ghostAt, 0, focusFlight.time)), end: cam.depth(end) > 1 ? cam.proj(end) : null,
      vert: cam.seg(end, corner), horiz: cam.seg(corner, SHAPE_TARGET), labels: cam.depth(end) > 2,
      vMid: cam.proj([0, (end[1] + SHAPE_TARGET[1]) / 2, end[2]]), hMid: cam.proj([0, SHAPE_TARGET[1], end[2] / 2]) };
  }
  // Tunnel mode: the window every pitch passes through.
  let gate = null;
  if (mode === "tunnel") {
    const c = F.lane, ring = [...Array(25)].map((_, i) => [c[0], c[1] + 0.55 * Math.sin((i * Math.PI) / 12), c[2] + 0.55 * Math.cos((i * Math.PI) / 12)]);
    gate = { ring: cam.path(ring), post: cam.seg([c[0], 0, c[2]], [c[0], c[1] - 0.55, c[2]]), at: cam.depth(c) > 2 ? cam.proj([c[0], c[1] + 0.55, c[2]]) : null };
  }
  // His real plate locations (plotted pitches only; TrackMan's plot clips the wild ones).
  const locs = showLoc ? p.loc.filter((l) => !focus || l.type === focus).map((l) => ({ l, d: cam.depth([0, l.y, l.z]), q: cam.proj([0, l.y, l.z]) })).filter((x) => x.d > 1) : [];

  const armSide = (hb, rel) => Math.sign(hb) === Math.sign(rel) || hb === 0;
  const sideWord = (dz) => (Math.sign(dz) === (p.throws === "R" ? 1 : -1) ? "arm side" : "glove side");
  const tunnelRows = mode === "tunnel" ? F.types.filter((t) => t.name !== p.ref).map((t) => {
    const dy = (t.end[1] - F.ref.end[1]) * 12, dz = (t.end[2] - F.ref.end[2]) * 12;
    const rel = Math.hypot(t.rel[1] - F.ref.rel[1], t.rel[2] - F.ref.rel[2]) * 12;
    return { t, dy, dz, apart: Math.hypot(dy, dz), rel };
  }).sort((a, b) => b.apart - a.apart) : [];
  const S = sel != null ? p.pitches[sel] : null;
  const phase = now <= 0 ? "Release" : now < tmax ? "In flight" : "At the plate";

  return (<>
    <div ref={sceneCard} style={{ scrollMarginTop: 12 }}>
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Pitch Movement</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>
        {mode === "shape"
          ? "Each line is one pitch type, thrown from his real release point at his real speed and movement. Every pitch is aimed at the same spot, so what you see is shape, not location."
          : `His ${p.ref.toLowerCase()} is thrown at the top of the zone, and every other pitch is thrown down the same lane from its own release point. They cross the hitter's decision point together. Everything after that is the pitch.`} Drag the picture to turn it.
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {[["shape", "Shape"], ["tunnel", "Tunnel"]].map(([m, l]) => <button key={m} style={{ ...pill(mode === m), flex: 1, padding: "8px 12px", fontSize: 12 }} onClick={() => pickMode(m)}>{l}</button>)}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button style={pill(!focus && !one)} onClick={() => { setFocus(null); setSel(null); }}>All pitches</button>
        {p.types.map((t) => (
          <button key={t.name} onClick={() => { setSel(null); setFocus(focus === t.name ? null : t.name); }}
            style={{ ...pill(false), display: "flex", alignItems: "center", gap: 6, border: "1px solid " + (focus === t.name ? color(t.name) : "rgba(255,255,255,0.1)"), background: focus === t.name ? color(t.name) + "1f" : "transparent", color: focus === t.name ? T.white : T.muted }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: color(t.name) }} />{t.name} <span style={{ color: T.faint, fontWeight: 500 }}>{t.velo.toFixed(1)}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <button onClick={() => play()} style={{ ...pill(false), background: T.green, color: T.bg, border: "none", fontWeight: 700 }}>Pitch</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => <button key={s} style={pill(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>)}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>View</span>
        {["Catcher", "Hitter", "Pitcher"].map((n) => <button key={n} style={pill(viewName === n)} onClick={() => goView(n)}>{n}</button>)}
        {viewName === "Hitter" && (
          <span style={{ display: "flex", gap: 4, marginLeft: 4 }}>
            {[["R", "Righty"], ["L", "Lefty"]].map(([b, l]) => <button key={b} style={{ ...pill(bat === b), padding: "6px 9px" }} onClick={() => pickBat(b)}>{l}</button>)}
          </span>
        )}
        <button style={{ ...pill(showLoc), marginLeft: "auto" }} onClick={() => setShowLoc(!showLoc)}>Locations</button>
      </div>

      <svg viewBox={`0 0 ${SCENE.w} ${SCENE.h}`} width="100%" role="img" aria-label={`3D pitch movement for ${p.name}, ${mode} mode: ${shown.map((t) => t.name).join(", ")}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ display: "block", background: "rgba(255,255,255,0.02)", borderRadius: 12, cursor: "grab", touchAction: "none", userSelect: "none" }}>
        {grid.map((s, i) => s && <line key={i} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} stroke="rgba(255,255,255,0.045)" strokeWidth="1" />)}
        {lane && <line x1={lane[0]} y1={lane[1]} x2={lane[2]} y2={lane[3]} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />}
        {mound.map((d, i) => <polyline key={"m" + i} points={d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />)}
        {rubber.map((d, i) => <polyline key={"r" + i} points={d} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />)}
        {[1, -1].map((s) => box(s).map((d, i) => <polyline key={s + "b" + i} points={d} fill="none" stroke={viewName === "Hitter" && s === batSide ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.12)"} strokeWidth="1" />))}
        {plate.map((d, i) => <polyline key={"p" + i} points={d} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />)}
        {zone.map((d, i) => <polyline key={"z" + i} points={d} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />)}
        {locs.map(({ l, d, q }, i) => <circle key={"l" + i} cx={q[0]} cy={q[1]} r={Math.max(1.2, Math.min(3.2, (0.075 * view.f) / d))} fill={color(l.type)} fillOpacity="0.42" />)}

        {gate && gate.post && <line x1={gate.post[0]} y1={gate.post[1]} x2={gate.post[2]} y2={gate.post[3]} stroke={T.amber} strokeOpacity="0.35" strokeWidth="1" strokeDasharray="3 3" />}
        {gate && gate.ring.map((d, i) => <polyline key={"gate" + i} points={d} fill="rgba(255,176,32,0.07)" stroke={T.amber} strokeWidth="1.3" />)}

        {ghost && ghost.path.map((d, i) => <polyline key={"g" + i} points={d} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeDasharray="4 4" />)}
        {flights.map(({ fl, pre, post }) => (<g key={fl.name + "path"} opacity={dimAll}>
          {pre.map((d, i) => <polyline key={"a" + i} points={d} fill="none" stroke={color(fl.name)} strokeOpacity={clock != null ? 0.2 : mode === "tunnel" ? 0.42 : 0.9} strokeWidth={focus ? 2.4 : 1.9} strokeLinecap="round" strokeLinejoin="round" />)}
          {post.map((d, i) => <polyline key={"b" + i} points={d} fill="none" stroke={color(fl.name)} strokeOpacity={clock != null ? 0.2 : 1} strokeWidth={focus ? 2.6 : 2.2} strokeLinecap="round" strokeLinejoin="round" />)}
        </g>))}
        {clock != null && !one && flights.map(({ fl, flown }) => flown.map((d, i) => <polyline key={fl.name + "n" + i} points={d} fill="none" stroke={color(fl.name)} strokeWidth={focus ? 2.6 : 2.1} strokeLinecap="round" strokeLinejoin="round" />))}
        {flights.map(({ fl, rel }) => rel && <circle key={fl.name + "rel"} cx={rel[0]} cy={rel[1]} r="2.2" fill={color(fl.name)} fillOpacity={0.9 * dimAll} />)}
        {mode === "tunnel" && clock == null && !one && flights.map(({ fl, end }) => end && <circle key={fl.name + "end"} cx={end[0]} cy={end[1]} r="3" fill={color(fl.name)} stroke={T.bg} strokeWidth="1" />)}

        {one && (<>
          {(clock != null ? one.flown : [...one.pre, ...one.post]).map((d, i) => <polyline key={"one" + i} points={d} fill="none" stroke={color(one.fl.name)} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />)}
          {one.rel && <circle cx={one.rel[0]} cy={one.rel[1]} r="2.6" fill={color(one.fl.name)} />}
        </>)}

        {ghost && ghost.vert && <line x1={ghost.vert[0]} y1={ghost.vert[1]} x2={ghost.vert[2]} y2={ghost.vert[3]} stroke={T.white} strokeOpacity="0.75" strokeWidth="1" />}
        {ghost && ghost.horiz && <line x1={ghost.horiz[0]} y1={ghost.horiz[1]} x2={ghost.horiz[2]} y2={ghost.horiz[3]} stroke={T.white} strokeOpacity="0.75" strokeWidth="1" />}
        {ghost && ghost.end && <circle cx={ghost.end[0]} cy={ghost.end[1]} r="3.4" fill="none" stroke={T.white} strokeOpacity="0.8" strokeWidth="1.2" strokeDasharray="2 2" />}
        {ghost && ghost.labels && (<>
          <text x={ghost.vMid[0] + (ghost.vMid[0] > SCENE.w / 2 ? 6 : -6)} y={ghost.vMid[1] + 3} textAnchor={ghost.vMid[0] > SCENE.w / 2 ? "start" : "end"} style={{ fontSize: 9, fill: T.white, fontFamily: FONT, fontWeight: 600 }}>{sgn(FQ.ivb)} in</text>
          <text x={ghost.hMid[0]} y={ghost.hMid[1] - 6} textAnchor="middle" style={{ fontSize: 9, fill: T.white, fontFamily: FONT, fontWeight: 600 }}>{Math.abs(FQ.hb).toFixed(1)} in</text>
        </>)}

        {balls.map(({ d, depth, q }) => <circle key={d.fl.name + "ball"} cx={q[0]} cy={q[1]} r={Math.max(1.8, Math.min(13, (BALL_R * view.f) / depth))} fill={T.white} stroke={color(d.fl.name)} strokeWidth="1.4" />)}
        {gate && gate.at && <text x={gate.at[0]} y={gate.at[1] - 5} textAnchor="middle" style={{ fontSize: 8.5, fill: T.amber, fontFamily: FONT, fontWeight: 700 }}>DECISION POINT</text>}

        <text x="12" y="20" style={{ fontSize: 12, fontWeight: 700, fill: T.white, fontFamily: FONT }}>{phase}</text>
        <text x={SCENE.w - 12} y="20" textAnchor="end" style={{ fontSize: 10, fill: T.muted, fontFamily: FONT }}>{Math.round(now * 1000)} ms after release</text>
        {ghost && <text x="12" y={SCENE.h - 12} style={{ fontSize: 9, fill: T.muted, fontFamily: FONT }}>dashed = the same pitch with no spin</text>}
        {gate && <text x="12" y="34" style={{ fontSize: 9, fill: T.muted, fontFamily: FONT }}>faint = before he has to decide, bright = after</text>}
      </svg>

      <input type="range" min="0" max={Math.round(tmax * 1000)} step="1" value={Math.round(now * 1000)} aria-label="Step through the pitch"
        onChange={(e) => { cancelAnimationFrame(raf.current); setClock(+e.target.value / 1000); }} style={{ width: "100%", accentColor: T.green, marginTop: 10 }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint, marginBottom: 12 }}><span>release</span><span>slide to step through</span><span>plate</span></div>

      {S ? (<>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color(S.type) }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: T.white }}>One {S.type.toLowerCase()}</span>
          <span style={{ fontSize: 11, color: T.dim }}>{S.date}</span>
          <button style={{ ...pill(false), marginLeft: "auto", padding: "4px 10px" }} onClick={() => setSel(null)}>Back to averages</button>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {stat("Velocity", `${S.velo.toFixed(1)} mph`, `his ${S.type.toLowerCase()} averages ${p.byName[S.type].velo.toFixed(1)}`, color(S.type))}
          {stat("Vertical break", `${sgn(S.ivb)} in`, `average ${sgn(p.byName[S.type].ivb)}`)}
          {stat("Horizontal break", `${Math.abs(S.hb).toFixed(1)} in`, armSide(S.hb, S.relSide) ? "toward his arm side" : "toward his glove side")}
          {stat("Release", `${S.relH.toFixed(1)} ft high`, `${Math.abs(S.relSide).toFixed(1)} ft off center · ${S.ext.toFixed(1)} ft extension`)}
        </div>
      </>) : mode === "tunnel" ? (
        <div>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 6, lineHeight: 1.5 }}>
            Thrown down the {p.ref.toLowerCase()}&apos;s lane, this is how far each pitch finishes from it. The hitter has about {Math.round((F.ref.time - F.ref.tDecide) * 1000)} ms left when they split.
          </div>
          {tunnelRows.map(({ t, dy, dz, apart, rel }) => (
            <div key={t.name} onClick={() => setFocus(focus === t.name ? null : t.name)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 4px", borderTop: "1px solid " + T.line, cursor: "pointer" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color(t.name), flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: "0 0 82px" }}>{t.name}</span>
              <span style={{ fontSize: 13, color: T.white, fontWeight: 700, flex: "0 0 58px" }}>{inches(apart)}</span>
              <span style={{ fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0, lineHeight: 1.4 }}>{inches(dy)} {dy < 0 ? "lower" : "higher"} · {inches(dz)} {sideWord(dz)}<br /><span style={{ color: T.faint }}>released {rel.toFixed(0)} in from the {p.ref.toLowerCase()}</span></span>
            </div>
          ))}
          {!tunnelRows.length && <div style={{ fontSize: 11, color: T.dim }}>Only one pitch type on file, so there is nothing to tunnel against yet.</div>}
        </div>
      ) : FQ ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {stat("Velocity", `${FQ.velo.toFixed(1)} mph`, FQ.vmax != null ? `tops out at ${FQ.vmax.toFixed(1)} · ${FQ.n} pitches` : `${FQ.n} pitches`, color(FQ.name))}
          {stat("Vertical break", `${sgn(FQ.ivb)} in`, FQ.ivb >= 0 ? "finishes above a no-spin pitch" : "finishes below a no-spin pitch")}
          {stat("Horizontal break", `${Math.abs(FQ.hb).toFixed(1)} in`, armSide(FQ.hb, FQ.relSide) ? "toward his arm side" : "toward his glove side")}
          {stat("Release", `${FQ.relH.toFixed(1)} ft high`, `${Math.abs(FQ.relSide).toFixed(1)} ft off center · ${FQ.ext.toFixed(1)} ft extension${FQ.extAssumed ? " (assumed)" : ""}`)}
          {stat("Time to the plate", `${Math.round(focusFlight.time * 1000)} ms`, "release to the front of the plate")}
        </div>
      ) : (
        <div>
          {F.types.map((t) => (
            <div key={t.name} onClick={() => setFocus(t.name)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderTop: "1px solid " + T.line, cursor: "pointer" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color(t.name), flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: "0 0 86px" }}>{t.name}</span>
              <span style={{ fontSize: 11, color: T.white, fontWeight: 700, flex: "0 0 62px" }}>{t.q.velo.toFixed(1)} mph</span>
              <span style={{ fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0 }}>{sgn(t.q.ivb)} in vertical · {Math.abs(t.q.hb).toFixed(1)} in {armSide(t.q.hb, t.q.relSide) ? "arm side" : "glove side"}</span>
              <span style={{ fontSize: 10, color: T.faint }}>{Math.round(t.time * 1000)} ms</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: T.faint, marginTop: 12, lineHeight: 1.5 }}>
        {mode === "shape"
          ? "Each line is the average of his tracked pitches of that type. Speed, break, and release point are his TrackMan numbers; the path between release and the plate is physics. Every pitch is aimed at the middle of the zone."
          : "Tunnel assumes he puts every pitch on the fastball's lane through the decision point, 23.8 feet out. Release points, speeds, and movement are his real numbers. Whether he actually throws them down that lane depends on where he aims, which bullpen tracking cannot pair to each pitch."}
        {showLoc ? " Location dots are where his tracked pitches actually crossed the plate. TrackMan's plot leaves out the ones that missed the frame." : ""}
      </div>
    </Card>
    </div>
    {p.pitches.length > 0 && <MovementScatter p={p} color={color} focus={focus} sel={sel} onPick={throwOne} />}
  </>);
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
          <div style={{ fontSize: 14, fontWeight: 700, color: T.white }}>Pitch Lab</div>
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
    if (pw === password) { try { sessionStorage.setItem("dyn_ok", "1"); } catch (e2) {} onOk(); }
    else setErr(true);
  };
  return (
    <Shell logo={logo}>
      <form onSubmit={submit} style={{ marginTop: 44, textAlign: "center" }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.white, marginBottom: 6 }}>Staff access</div>
        <div style={{ fontSize: 12, color: T.dim, marginBottom: 18, lineHeight: 1.5 }}>Enter the password to open the Pitch Lab.</div>
        <input type="password" value={pw} autoFocus onChange={(e) => { setPw(e.target.value); setErr(false); }} placeholder="Password"
          style={{ width: "100%", maxWidth: 280, padding: "12px 14px", border: "1px solid " + (err ? "#F97362" : "rgba(255,255,255,0.1)"), borderRadius: 10, background: "rgba(255,255,255,0.04)", color: T.white, fontSize: 14, outline: "none", textAlign: "center", boxSizing: "border-box", fontFamily: FONT }} />
        <div><button type="submit" style={{ marginTop: 14, padding: "11px 30px", border: "none", borderRadius: 10, background: T.green, color: T.bg, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: FONT }}>Unlock</button></div>
        {err && <div style={{ fontSize: 12, color: "#F97362", marginTop: 12 }}>Incorrect password.</div>}
      </form>
    </Shell>
  );
}

export function PitchLabPage({ logo, password, ars, tmr, colors }) {
  const [ok, setOk] = useState(() => { try { return sessionStorage.getItem("dyn_ok") === "1"; } catch (e) { return false; } });
  if (!ok) return <StaffGate logo={logo} password={password} onOk={() => setOk(true)} />;
  return <PitchLab logo={logo} ars={ars} tmr={tmr} colors={colors} />;
}

function PitchLab({ logo, ars, tmr, colors }) {
  const pitchers = useMemo(() => Object.entries(ars?.athletes || {}).map(([n, a]) => buildPitcher(n, a, tmr?.[n])).filter(Boolean).sort((a, b) => lastName(a.name).localeCompare(lastName(b.name))), [ars, tmr]);
  const [name, setName] = useState(() => (pitchers.find((x) => x.name === "Thomas LoBello") || pitchers[0])?.name);
  const p = pitchers.find((x) => x.name === name) || pitchers[0];
  if (!p) return <Shell logo={logo}><Card><div style={{ fontSize: 12, color: T.dim }}>No tracked arsenals yet.</div></Card></Shell>;
  return (
    <Shell logo={logo}>
      <Card pad="12px 14px">
        <select value={p.name} onChange={(e) => setName(e.target.value)} aria-label="Pitcher"
          style={{ width: "100%", background: "transparent", color: T.white, border: "none", fontSize: 14, fontWeight: 600, fontFamily: FONT, outline: "none", cursor: "pointer" }}>
          {pitchers.map((x) => <option key={x.name} value={x.name} style={{ color: "#000" }}>{x.name}</option>)}
        </select>
      </Card>
      <Card>
        <div style={{ fontSize: 20, fontWeight: 800, color: T.white }}>{p.name}</div>
        <div style={{ fontSize: 11, color: T.dim, marginTop: 3 }}>Throws {p.throws === "R" ? "right" : "left"} · {LEVEL[p.lvl] || p.lvl} · {p.n} tracked pitches · {p.types.length} pitch type{p.types.length === 1 ? "" : "s"}</div>
      </Card>
      <PitchView p={p} colors={colors} />
    </Shell>
  );
}
