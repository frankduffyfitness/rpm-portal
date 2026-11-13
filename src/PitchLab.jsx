// Pitch Lab: unlinked staff preview (/pitchlab) of pitch movement in 3D.
// Stage 1 (2026-11-13): one flight per pitch type, built from the pitcher's arsenal
// averages (velocity, induced vertical break, horizontal break, extension, release
// height and side). Every pitch is aimed at the same spot, so the only differences on
// screen are release point and movement. The dashed line is the same pitch with no spin.
//
// Physics: constant acceleration from release to the front of the plate. Gravity, a
// drag deceleration worth about 9% of release speed, and the measured break, which
// TrackMan defines as the deviation from a no-spin flight over that same distance.
// World (scene3d.js): x toward the catcher, y up, +z = third-base side.
// TrackMan signs: release side and horizontal break are both positive toward the
// pitcher's right, which is the third-base side, so they map straight onto +z.
import { useEffect, useMemo, useRef, useState } from "react";
import { makeCamera, orbitFrom, vlerp } from "./scene3d.js";

const T = { bg: "#0A0C10", card: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.06)",
  text: "#E0E0E0", white: "#fff", muted: "#8A8F98", dim: "#6B7280", faint: "#4a4f57",
  green: "#4FFFB0", blue: "#60A5FA", amber: "#FFB020", orange: "#FF8C42", red: "#FF4D4D", purple: "#A78BFA" };
const FONT = "'DM Sans','Helvetica Neue',sans-serif";
const LEVEL = { hs: "High school", col: "College", pro: "Pro", ms: "Middle school", ml: "Men's league" };

const G = 32.174, MPH_TO_FTS = 1.46667, PLATE_FACTOR = 0.91;
const RUBBER_X = -(60.5 - 17 / 12);      // rubber to the FRONT of the plate
const TARGET = [0, 2.5, 0];              // every pitch is aimed here
const ZONE = { half: 17 / 24, lo: 1.5, hi: 3.5 };
const BALL_R = 0.121;
const MIN_PITCHES = 5;

// Arsenal type row (gen_arsenal_portal.py): [name, n, use%, veloAvg, veloMax, ivb, hb,
// spin, tilt, eff, ext, relH, relSide, shape+, grade, zone%, thin].
function flight(r, extFallback) {
  const [name, n, use, velo, vmax, ivb, hb, spin, tilt, , extRaw, relH, relSide] = r;
  const ext = extRaw ?? extFallback;
  const x0 = RUBBER_X + ext, D = -x0;
  const v0 = velo * MPH_TO_FTS, vf = PLATE_FACTOR * v0;
  const ax = (vf * vf - v0 * v0) / (2 * D), time = (2 * D) / (v0 + vf);
  const ay = -G + (2 * (ivb / 12)) / (time * time), az = (2 * (hb / 12)) / (time * time);
  const vy = (TARGET[1] - relH - 0.5 * ay * time * time) / time;
  const vz = (TARGET[2] - relSide - 0.5 * az * time * time) / time;
  const clampT = (t) => Math.max(0, Math.min(t, time));
  const at = (t) => { const s = clampT(t); return [x0 + v0 * s + 0.5 * ax * s * s, relH + vy * s + 0.5 * ay * s * s, relSide + vz * s + 0.5 * az * s * s]; };
  // Same release and the same first move out of the hand, with spin switched off.
  const ghostAt = (t) => { const s = clampT(t); return [x0 + v0 * s + 0.5 * ax * s * s, relH + vy * s - 0.5 * G * s * s, relSide + vz * s]; };
  return { name, n, use, velo, vmax, ivb, hb, spin, tilt, ext, relH, relSide, time, at, ghostAt, rel: [x0, relH, relSide], extAssumed: extRaw == null };
}

function buildPitcher(name, a) {
  const rows = (a.types || []).filter((r) => r[0] !== "Other" && r[1] >= MIN_PITCHES && [3, 5, 6, 11, 12].every((i) => r[i] != null));
  if (!rows.length) return null;
  const exts = rows.map((r) => r[10]).filter((x) => x != null).sort((x, y) => x - y);
  const extFallback = exts.length ? exts[Math.floor(exts.length / 2)] : 6.0;
  const types = rows.map((r) => flight(r, extFallback)).sort((x, y) => y.n - x.n);
  const fb = types.find((t) => t.name === "Fastball" || t.name === "Sinker") || types[0];
  return { name, lvl: a.lvl, n: a.n, types, throws: fb.relSide >= 0 ? "R" : "L", tmax: Math.max(...types.map((t) => t.time)) };
}

const lastName = (n) => { const p = n.trim().split(/\s+/); return (p[p.length - 1] + " " + p[0]).toLowerCase(); };
const sgn = (v, d = 1) => (v > 0 ? "+" : "") + v.toFixed(d);

// ─── Views: where the camera stands and what it looks at ────────────────────
const SCENE = { w: 360, h: 300, cy: 0.5 };
const viewDefs = (bat) => {
  const s = bat === "R" ? 1 : -1; // a right-handed hitter stands on the third-base side
  return {
    // Catcher and Pitcher are telephoto (stand well back, zoom in): it flattens the
    // perspective so the flights fill the frame and break reads as curvature.
    Catcher: { pos: [40, 4.5, 0], target: [-10, 3.2, 0], f: 1900 },
    Hitter: { pos: [1.6, 5.4, 2.4 * s], target: [-40, 4.2, 0.9 * s], f: 400 },
    Pitcher: { pos: [-100, 11, 0], target: [-24, 3.9, 0], f: 2300 },
  };
};
const toOrbit = (v) => ({ ...orbitFrom(v.pos, v.target), target: v.target, f: v.f });

const Card = ({ children, pad = "18px 16px" }) => <div style={{ background: T.card, border: T.border, borderRadius: 16, padding: pad, marginBottom: 12 }}>{children}</div>;

function PitchScene({ p, colors }) {
  const color = (n) => colors?.[n] || T.muted;
  const [bat, setBat] = useState("R");
  const [viewName, setViewName] = useState("Catcher");
  const [view, setView] = useState(() => toOrbit(viewDefs("R").Catcher));
  const [focus, setFocus] = useState(null);
  const [speed, setSpeed] = useState(0.2);
  const [clock, setClock] = useState(null); // null = finished, every ball at the plate
  const raf = useRef(null), camRaf = useRef(null), drag = useRef(null);

  useEffect(() => { cancelAnimationFrame(raf.current); setClock(null); setFocus(null); }, [p]);
  useEffect(() => { if (viewName === "Hitter") { cancelAnimationFrame(camRaf.current); setView(toOrbit(viewDefs(bat).Hitter)); } }, [bat]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); cancelAnimationFrame(camRaf.current); }, []);

  const now = clock == null ? p.tmax : clock;
  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (ts) => { if (t0 == null) t0 = ts; const x = ((ts - t0) / 1000) * s; if (x >= p.tmax) { setClock(null); return; } setClock(x); raf.current = requestAnimationFrame(step); };
    raf.current = requestAnimationFrame(step);
  };
  const goView = (name) => {
    cancelAnimationFrame(camRaf.current);
    setViewName(name);
    const from = view, to = toOrbit(viewDefs(bat)[name]), turn = ((to.az - from.az + 540) % 360) - 180;
    let t0 = null;
    const step = (ts) => {
      if (t0 == null) t0 = ts;
      const k = Math.min(1, (ts - t0) / 500), e = k * k * (3 - 2 * k);
      setView({ az: from.az + turn * e, el: from.el + (to.el - from.el) * e, dist: from.dist + (to.dist - from.dist) * e, f: from.f + (to.f - from.f) * e, target: vlerp(from.target, to.target, e) });
      if (k < 1) camRaf.current = requestAnimationFrame(step);
    };
    camRaf.current = requestAnimationFrame(step);
  };
  const onDown = (e) => { cancelAnimationFrame(camRaf.current); drag.current = { x: e.clientX, y: e.clientY, az: view.az, el: view.el }; e.currentTarget.setPointerCapture?.(e.pointerId); };
  const onMove = (e) => {
    const d = drag.current; if (!d) return;
    setViewName(null);
    setView((v) => ({ ...v, az: d.az - (e.clientX - d.x) * 0.4, el: Math.max(-8, Math.min(85, d.el + (e.clientY - d.y) * 0.3)) }));
  };
  const onUp = () => { drag.current = null; };

  const cam = makeCamera(view, SCENE);
  const shown = focus ? p.types.filter((t) => t.name === focus) : p.types;
  const F = focus ? shown[0] : null;

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
  const K = 48;
  const sample = (fn, upTo, total) => { const out = []; for (let i = 0; i <= K; i++) { const t = (total * i) / K; if (t >= upTo) break; out.push(fn(t)); } out.push(fn(Math.min(upTo, total))); return out; };
  const flights = shown.map((t) => ({ t, full: cam.path(sample(t.at, t.time, t.time)), flown: now > 0 ? cam.path(sample(t.at, Math.min(now, t.time), t.time)) : [], rel: cam.depth(t.rel) > 1 ? cam.proj(t.rel) : null, ball: t.at(now) }));
  const balls = flights.map((fl) => ({ fl, d: cam.depth(fl.ball), q: cam.proj(fl.ball) })).filter((b) => b.d > 1).sort((a, b) => b.d - a.d);

  // No-spin ghost and the break it reveals, for the focused pitch.
  let ghost = null;
  if (F) {
    const end = F.ghostAt(F.time), corner = [0, TARGET[1], end[2]];
    const ok = cam.depth(end) > 2 && cam.depth(TARGET) > 2;
    ghost = { path: cam.path(sample(F.ghostAt, F.time, F.time)), end: cam.depth(end) > 1 ? cam.proj(end) : null,
      vert: cam.seg(end, corner), horiz: cam.seg(corner, TARGET), labels: ok,
      vMid: cam.proj([0, (end[1] + TARGET[1]) / 2, end[2]]), hMid: cam.proj([0, TARGET[1], end[2] / 2]) };
  }

  const armSide = (t) => Math.sign(t.hb) === Math.sign(t.relSide) || t.hb === 0;
  const hbText = (t) => `${Math.abs(t.hb).toFixed(1)} in ${armSide(t) ? "arm side" : "glove side"}`;
  const pill = (on) => ({ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted, fontFamily: FONT });
  const stat = (l, v, s, c = T.white) => (
    <div style={{ flex: "1 1 130px", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
      <div style={{ fontSize: 19, fontWeight: 700, color: c }}>{v}</div>
      <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.4 }}>{s}</div>
    </div>
  );
  const phase = now <= 0 ? "Release" : now < p.tmax ? "In flight" : "At the plate";

  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Pitch Movement</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>Each line is one pitch type, thrown from his real release point at his real speed and movement. Every pitch is aimed at the same spot, so what you see is shape, not location. Drag the picture to turn it.</div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
        <button style={pill(!focus)} onClick={() => setFocus(null)}>All pitches</button>
        {p.types.map((t) => (
          <button key={t.name} onClick={() => setFocus(focus === t.name ? null : t.name)}
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
          <span style={{ display: "flex", gap: 4, marginLeft: 6 }}>
            {[["R", "Righty"], ["L", "Lefty"]].map(([b, l]) => <button key={b} style={{ ...pill(bat === b), padding: "6px 9px" }} onClick={() => setBat(b)}>{l}</button>)}
          </span>
        )}
      </div>

      <svg viewBox={`0 0 ${SCENE.w} ${SCENE.h}`} width="100%" role="img" aria-label={`3D pitch movement for ${p.name}: ${shown.map((t) => t.name).join(", ")}`}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        style={{ display: "block", background: "rgba(255,255,255,0.02)", borderRadius: 12, cursor: "grab", touchAction: "none", userSelect: "none" }}>
        {grid.map((s, i) => s && <line key={i} x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} stroke="rgba(255,255,255,0.045)" strokeWidth="1" />)}
        {lane && <line x1={lane[0]} y1={lane[1]} x2={lane[2]} y2={lane[3]} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />}
        {mound.map((d, i) => <polyline key={"m" + i} points={d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />)}
        {rubber.map((d, i) => <polyline key={"r" + i} points={d} fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.2" />)}
        {[1, -1].map((s) => box(s).map((d, i) => <polyline key={s + "b" + i} points={d} fill="none" stroke={viewName === "Hitter" && s === batSide ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.12)"} strokeWidth="1" />))}
        {plate.map((d, i) => <polyline key={"p" + i} points={d} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.4)" strokeWidth="1" />)}
        {zone.map((d, i) => <polyline key={"z" + i} points={d} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.2" />)}

        {ghost && ghost.path.map((d, i) => <polyline key={"g" + i} points={d} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeDasharray="4 4" />)}
        {flights.map(({ t, full }) => full.map((d, i) => <polyline key={t.name + "f" + i} points={d} fill="none" stroke={color(t.name)} strokeOpacity={clock == null ? 0.9 : 0.22} strokeWidth={focus ? 2.4 : 1.9} strokeLinecap="round" strokeLinejoin="round" />))}
        {clock != null && flights.map(({ t, flown }) => flown.map((d, i) => <polyline key={t.name + "n" + i} points={d} fill="none" stroke={color(t.name)} strokeWidth={focus ? 2.6 : 2.1} strokeLinecap="round" strokeLinejoin="round" />))}
        {flights.map(({ t, rel }) => rel && <circle key={t.name + "rel"} cx={rel[0]} cy={rel[1]} r="2.2" fill={color(t.name)} fillOpacity="0.9" />)}

        {ghost && ghost.vert && <line x1={ghost.vert[0]} y1={ghost.vert[1]} x2={ghost.vert[2]} y2={ghost.vert[3]} stroke={T.white} strokeOpacity="0.75" strokeWidth="1" />}
        {ghost && ghost.horiz && <line x1={ghost.horiz[0]} y1={ghost.horiz[1]} x2={ghost.horiz[2]} y2={ghost.horiz[3]} stroke={T.white} strokeOpacity="0.75" strokeWidth="1" />}
        {ghost && ghost.end && <circle cx={ghost.end[0]} cy={ghost.end[1]} r="3.4" fill="none" stroke={T.white} strokeOpacity="0.8" strokeWidth="1.2" strokeDasharray="2 2" />}
        {ghost && ghost.labels && (<>
          <text x={ghost.vMid[0] + (ghost.vMid[0] > SCENE.w / 2 ? 6 : -6)} y={ghost.vMid[1] + 3} textAnchor={ghost.vMid[0] > SCENE.w / 2 ? "start" : "end"} style={{ fontSize: 9, fill: T.white, fontFamily: FONT, fontWeight: 600 }}>{sgn(F.ivb)} in</text>
          <text x={ghost.hMid[0]} y={ghost.hMid[1] - 6} textAnchor="middle" style={{ fontSize: 9, fill: T.white, fontFamily: FONT, fontWeight: 600 }}>{Math.abs(F.hb).toFixed(1)} in</text>
        </>)}

        {balls.map(({ fl, d, q }) => <circle key={fl.t.name + "ball"} cx={q[0]} cy={q[1]} r={Math.max(1.8, Math.min(13, (BALL_R * view.f) / d))} fill={T.white} stroke={color(fl.t.name)} strokeWidth="1.4" />)}

        <text x="12" y="20" style={{ fontSize: 12, fontWeight: 700, fill: T.white, fontFamily: FONT }}>{phase}</text>
        <text x={SCENE.w - 12} y="20" textAnchor="end" style={{ fontSize: 10, fill: T.muted, fontFamily: FONT }}>{Math.round(Math.min(now, p.tmax) * 1000)} ms after release</text>
        {F && <text x="12" y={SCENE.h - 12} style={{ fontSize: 9, fill: T.muted, fontFamily: FONT }}>dashed = the same pitch with no spin</text>}
      </svg>

      <input type="range" min="0" max={Math.round(p.tmax * 1000)} step="1" value={Math.round(Math.min(now, p.tmax) * 1000)} aria-label="Step through the pitch"
        onChange={(e) => { cancelAnimationFrame(raf.current); setClock(+e.target.value / 1000); }} style={{ width: "100%", accentColor: T.green, marginTop: 10 }} />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint, marginBottom: 12 }}><span>release</span><span>slide to step through</span><span>plate</span></div>

      {F ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {stat("Velocity", `${F.velo.toFixed(1)} mph`, F.vmax != null ? `tops out at ${F.vmax.toFixed(1)} · ${F.n} pitches` : `${F.n} pitches`, color(F.name))}
          {stat("Vertical break", `${sgn(F.ivb)} in`, F.ivb >= 0 ? "finishes above a no-spin pitch" : "finishes below a no-spin pitch")}
          {stat("Horizontal break", `${Math.abs(F.hb).toFixed(1)} in`, armSide(F) ? "toward his arm side" : "toward his glove side")}
          {stat("Release", `${F.relH.toFixed(1)} ft high`, `${Math.abs(F.relSide).toFixed(1)} ft off center · ${F.ext.toFixed(1)} ft extension${F.extAssumed ? " (assumed)" : ""}`)}
          {stat("Time to the plate", `${Math.round(F.time * 1000)} ms`, "release to the front of the plate")}
        </div>
      ) : (
        <div>
          {p.types.map((t) => (
            <div key={t.name} onClick={() => setFocus(t.name)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderTop: "1px solid " + T.line, cursor: "pointer" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: color(t.name), flexShrink: 0 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: T.text, flex: "0 0 86px" }}>{t.name}</span>
              <span style={{ fontSize: 11, color: T.white, fontWeight: 700, flex: "0 0 62px" }}>{t.velo.toFixed(1)} mph</span>
              <span style={{ fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0 }}>{sgn(t.ivb)} in vertical · {hbText(t)}</span>
              <span style={{ fontSize: 10, color: T.faint }}>{Math.round(t.time * 1000)} ms</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, color: T.faint, marginTop: 12, lineHeight: 1.5 }}>
        Each line is the average of his tracked pitches of that type. Speed, break, and release point are his TrackMan numbers; the path between release and the plate is physics. Every pitch is aimed at the middle of the zone, so where his pitches actually crossed the plate is not shown here.
      </div>
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

export function PitchLabPage({ logo, password, ars, colors }) {
  const [ok, setOk] = useState(() => { try { return sessionStorage.getItem("dyn_ok") === "1"; } catch (e) { return false; } });
  if (!ok) return <StaffGate logo={logo} password={password} onOk={() => setOk(true)} />;
  return <PitchLab logo={logo} ars={ars} colors={colors} />;
}

function PitchLab({ logo, ars, colors }) {
  const pitchers = useMemo(() => Object.entries(ars?.athletes || {}).map(([n, a]) => buildPitcher(n, a)).filter(Boolean).sort((a, b) => lastName(a.name).localeCompare(lastName(b.name))), [ars]);
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
      <PitchScene p={p} colors={colors} />
    </Shell>
  );
}
