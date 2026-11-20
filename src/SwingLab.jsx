// ─── Swing Lab (staff preview, unlinked) ─────────────────────────────────────
// rpmstrength.coach/swinglab (rewrite in vercel.json). Nothing links here yet:
// it's where the bat speed model's hitter-facing visuals get built before they
// go on athlete pages (Frank, 11/13/26). Same look as the Model Portal, behind
// its own staff password (Frank, 11/17/26) and its own session unlock, so opening the
// Model Portal or Pitch Lab does not open this page. Soft gate: the data still ships
// in the bundle.
//
// Data: swing_data.json, built from Bat Speed Model/blast_swings_manual.csv by
// build_swinglab_data.py (counted swings only, facility Baum 33/30). Re-run the
// script and commit the JSON after logging new swings.
//
// Time to decide: generic pitch, 6 ft of extension (54.5 ft of flight) and ~9%
// speed loss from release to plate, the same factor the exit velo card uses.
import { useEffect, useMemo, useRef, useState } from "react";
import SWING_DATA from "./swing_data.json";
import { swingModel, TAU_END, BAT_LEN, SWEET, UP, rad, vadd, vsub, vmul, vdot, vcross, vnorm } from "./swingModel.js";
import { T, FONT, mean, sd, shortDate, fmt, ord, clamp, SCENE_BG, eyebrow, Card, MetricCard, useMeasure, pillStyle, Segmented, AnalysisCard } from "./labKit.jsx";
import { RapsodoTab, RAPSODO_DEFAULT, hasRapsodoHitter } from "./RapsodoLab.jsx";

const GROUP_COLOR = { Hitter: T.green, "2W": T.blue, PO: T.purple, Staff: T.muted };
const GROUP_LABEL = { Hitter: "Hitter", "2W": "Two-way", PO: "Pitcher only", Staff: "Staff" };

// dir: +1 higher is better, -1 lower is better, 0 = shape (no better/worse here; that's a hitting coach's read).
// `mlb` = the big-league reference line under each card (Frank, 11/17/26). Sources:
//  - bat speed, attack angle, swing path tilt: Baseball Savant swing path leaderboard,
//    2026 regular season, 209 qualified hitters' season averages, pulled 11/17/26.
//  - time to contact: Frank's Swing Clock 2026 artifact (208 qualified hitters), an
//    ESTIMATE from swing length and bat speed, not a measured time.
//  - rotational acceleration, on-plane efficiency, HS varsity bat speed: Blast's own
//    published averages (blastmotion.com metrics page and Blast figures on PBR reports).
// MLB numbers are game swings against live pitching; ours are off a tee.
const METRICS = [
  { k: "bs", title: "Bat Speed", unit: " mph", dp: 1, dir: 1, agg: "top5", desc: "Speed of the sweet spot at contact. Average of your top 5 swings.",
    mlb: "MLB hitters average 62 to 79 mph in games (middle of the league: 72). Blast puts high school varsity at 60 to 70." },
  { k: "ttc", title: "Time to Contact", unit: " s", dp: 3, dir: -1, desc: "Start of the downswing to contact. Lower means a quicker swing.",
    mlb: "MLB hitters are estimated at 0.123 to 0.161 s (middle of the league: 0.138). That is worked out from swing length and bat speed, not measured like yours." },
  { k: "ra", title: "Rotational Acceleration", unit: " g", dp: 1, dir: 1, desc: "How fast the bat speeds up at the start of the swing. Higher gets to speed sooner.",
    mlb: "Blast's MLB average is 16.8 g. College is 12.9 and high school varsity is 9.9." },
  { k: "aa", title: "Attack Angle", unit: "°", dp: 0, dir: 0, signed: true, desc: "Up or down path of the bat at contact. Positive means swinging up.",
    mlb: "MLB hitters average +1° to +20° in games (middle of the league: +10°). No qualified hitter swings down on average." },
  { k: "vba", title: "Vertical Bat Angle", unit: "°", dp: 0, dir: 0, desc: "Tilt of the barrel below the hands at contact. More negative means steeper.",
    mlb: "MLB does not publish this exact number. The closest is swing path tilt, 23° to 45° (middle of the league: 33°), which lines up with about -23° to -45° here." },
  { k: "ope", title: "On-Plane Efficiency", unit: "%", dp: 0, dir: 0, desc: "Share of the swing the bat stays on the plane of the pitch.",
    mlb: "Blast's MLB average is 69%. Blast calls 70% or higher the target." },
];

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
// Everyone swings the facility Baum unless the data says otherwise. A hitter on his own bat (Jace Congemi, 11/19/26:
// a drop 5, not wood, so outside the wood-only fit) is shown beside the facility-bat group but is not ranked in it,
// and never counts in anyone else's group.
const FACILITY_BAT = { label: "Baum 33/30", own: false };
function withSessions(t) {
  const dates = [...new Set(t.swings.map((s) => s.date))].sort();
  const sessions = dates.map((date) => { const swings = t.swings.filter((s) => s.date === date); return { date, swings, sum: summarize({ swings }), bat: (t.ownBat && t.ownBat[date]) || FACILITY_BAT }; });
  return { ...t, sessions, ...sessions[sessions.length - 1] };
}
const TESTERS = SWING_DATA.testers.map(withSessions);
const FACILITY = TESTERS.filter((x) => !x.bat.own);
const poolWith = (t) => (t.bat.own ? FACILITY : FACILITY.map((x) => (x.name === t.name ? t : x))); // the group, with this hitter as currently shown


// ─── Analysis graphics: shared scene plumbing ────────────────────────────────
// Time to Decide and Swing Path are the two diagrams a coach reads beside a hitter
// (redesign brief, Frank 11/17/26). Each one opens paused on its answer: where the
// ball is when the swing has to start, and what the barrel is doing at contact.
// Scenes are drawn 1 unit = 1 px of the measured panel, so type stays crisp at any width.
const BAT_PROFILE = [[0, 0.085], [0.07, 0.085], [0.12, 0.045], [1.0, 0.05], [1.9, 0.105], [2.66, 0.108], [BAT_LEN, 0.06]]; // ft from the knob, radius
const PLATE = [[-0.71, 0, -0.71], [-0.71, 0, 0.71], [0, 0, 0.71], [0.71, 0, 0], [0, 0, -0.71]]; // point toward the catcher
const pts = (list) => list.map((p) => p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
const signed = (x) => (Math.round(x) > 0 ? "+" : Math.round(x) < 0 ? "−" : "") + Math.abs(Math.round(x)); // +14, −31, 0
const groupMean = (k) => mean(FACILITY.map((x) => x.sum[k]).filter((x) => x != null));
const outward = (az, el) => [Math.cos(rad(el)) * Math.sin(rad(az)), Math.sin(rad(el)), Math.cos(rad(el)) * Math.cos(rad(az))]; // from the target toward the camera


// view = { az, el, dist, target, span: [ft across, ft tall], cy }. `span` is the field that has to fit the panel.
function makeCamera(view, w, h) {
  const { az, el, dist, target, span, cy = 0.5 } = view;
  const f = dist * Math.min(w / span[0], h / span[1]);
  const out = outward(az, el), pos = vadd(target, vmul(out, dist));
  const fw = vmul(out, -1), rt = vnorm(vcross(fw, UP)), up = vcross(rt, fw);
  const cam = (p) => { const d = vsub(p, pos); return [vdot(d, rt), vdot(d, up), vdot(d, fw)]; };
  const flat = (c) => [w / 2 + (f * c[0]) / c[2], h * cy - (f * c[1]) / c[2], c[2]];
  const proj = (p) => { const c = cam(p); return flat([c[0], c[1], Math.max(c[2], 0.5)]); };
  // Line clipped to what is in front of the camera (the ground runs past it).
  const seg = (a, b) => {
    let ca = cam(a), cb = cam(b);
    if (ca[2] < 1 && cb[2] < 1) return null;
    const cut = (p, q) => { const k = (1 - p[2]) / (q[2] - p[2]); return p.map((x, i) => x + (q[i] - x) * k); };
    if (ca[2] < 1) ca = cut(ca, cb); else if (cb[2] < 1) cb = cut(cb, ca);
    return [...flat(ca).slice(0, 2), ...flat(cb).slice(0, 2)];
  };
  return { proj, seg, f, out, w, h, pxPerFt: (p) => f / Math.max(cam(p)[2], 0.5) };
}

// A view from (az, el) framed so every point in `points` fits.
function fitView(az, el, dist, points, pad = 1.12) {
  const lo = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i]))), hi = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
  const target = lo.map((v, i) => (v + hi[i]) / 2);
  const out = outward(az, el), pos = vadd(target, vmul(out, dist)), fw = vmul(out, -1), rt = vnorm(vcross(fw, UP)), up = vcross(rt, fw);
  let ex = 0, ey = 0;
  points.forEach((p) => { const d = vsub(p, pos), z = Math.max(vdot(d, fw), 1); ex = Math.max(ex, (Math.abs(vdot(d, rt)) * dist) / z); ey = Math.max(ey, (Math.abs(vdot(d, up)) * dist) / z); });
  return { az, el, dist, target, span: [2 * ex * pad, 2 * ey * pad] };
}

// Camera state: named presets that glide into place, plus free rotation by drag or arrow keys.
function useOrbit(homeFor, first) {
  const [view, setView] = useState(() => homeFor(first));
  const [name, setName] = useState(first);
  const raf = useRef(null), drag = useRef(null), cur = useRef(view);
  cur.current = view;
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const go = (n, instant) => {
    cancelAnimationFrame(raf.current);
    setName(n);
    const from = cur.current, to = homeFor(n);
    if (instant) { setView(to); return; }
    const turn = ((((to.az - from.az) % 360) + 540) % 360) - 180;
    let t0 = null;
    const step = (ts) => {
      if (t0 == null) t0 = ts;
      const k = Math.min(1, (ts - t0) / 480), e = k * k * (3 - 2 * k), mix = (a, b) => a + (b - a) * e;
      setView({ az: from.az + turn * e, el: mix(from.el, to.el), dist: mix(from.dist, to.dist), cy: mix(from.cy ?? 0.5, to.cy ?? 0.5),
        target: from.target.map((x, i) => mix(x, to.target[i])), span: from.span.map((x, i) => mix(x, to.span[i])) });
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const turnBy = (daz, del) => { cancelAnimationFrame(raf.current); setName(null); setView((v) => ({ ...v, az: v.az + daz, el: clamp(v.el + del, 1, 86) })); };
  const handlers = {
    onPointerDown: (e) => { cancelAnimationFrame(raf.current); drag.current = { x: e.clientX, y: e.clientY, az: cur.current.az, el: cur.current.el, moved: false }; e.currentTarget.setPointerCapture?.(e.pointerId); },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d) return;
      if (!d.moved && Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < 4) return;
      d.moved = true;
      setName(null);
      setView((v) => ({ ...v, az: d.az - (e.clientX - d.x) * 0.5, el: clamp(d.el + (e.clientY - d.y) * 0.3, 1, 86) }));
    },
    onPointerUp: () => { drag.current = null; },
    onPointerCancel: () => { drag.current = null; },
    onKeyDown: (e) => {
      const k = { ArrowLeft: [6, 0], ArrowRight: [-6, 0], ArrowUp: [0, 4], ArrowDown: [0, -4] }[e.key];
      if (k) { e.preventDefault(); turnBy(k[0], k[1]); }
    },
  };
  return { view, name, go, handlers };
}

function BatShape({ cam, frame, opacity = 1, scale = 1 }) {
  // scale > 1 enlarges the bat about its sweet spot (used where the whole pitch is in frame and a true-size bat would be a speck).
  const base = scale === 1 ? frame.hands : vsub(frame.sweet, vmul(frame.dir, SWEET * scale));
  const a = cam.proj(base), b = cam.proj(vadd(base, vmul(frame.dir, BAT_LEN * scale)));
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
  const left = [], right = [];
  BAT_PROFILE.forEach(([d, r]) => {
    const c = cam.proj(vadd(base, vmul(frame.dir, d * scale))), px = (r * scale * cam.f) / c[2];
    left.push([c[0] + n[0] * px, c[1] + n[1] * px]); right.unshift([c[0] - n[0] * px, c[1] - n[1] * px]);
  });
  return <polygon points={pts([...left, ...right])} fill="#E3C79B" stroke="#8C6F45" strokeWidth="0.75" strokeLinejoin="round" opacity={opacity} />;
}

// Scene text with a dark halo, kept inside the panel.
function SceneText({ x, y, w, children, size = 11, weight = 600, fill = T.text, anchor = "middle", opacity = 1 }) {
  const half = (String(children).length * size * 0.56) / 2;
  const cx = anchor === "middle" ? clamp(x, half + 6, w - half - 6) : anchor === "end" ? clamp(x, half * 2 + 6, w - 6) : clamp(x, 6, w - half * 2 - 6);
  return <text x={cx} y={y} textAnchor={anchor} fontSize={size} fontWeight={weight} fill={fill} opacity={opacity} stroke={SCENE_BG} strokeWidth="4" strokeLinejoin="round" paintOrder="stroke" style={{ fontVariantNumeric: "tabular-nums" }}>{children}</text>;
}


function PlayButton({ playing, onClick, label }) {
  return (
    <button type="button" onClick={onClick} style={{ fontSize: 12, fontWeight: 700, lineHeight: 1, padding: "9px 16px", minHeight: 36, minWidth: 74, borderRadius: 9, border: "none", background: T.green, color: T.bg, cursor: "pointer", fontFamily: FONT }}>
      {playing ? "Pause" : label}
    </button>
  );
}

const SPEEDS = [[1, "Real time"], [0.2, "5× slow"], [0.07, "15× slow"]];

// A timeline to drag, click or arrow through. `segments` colour and label the track; `ticks` are jump buttons above it.
function Scrubber({ value, max, onChange, step, label, valueText, segments, ticks = [], tall = false }) {
  const dragging = useRef(false);
  const [ref, { w }, track] = useMeasure();
  const at = (e) => { const r = track.getBoundingClientRect(); onChange(clamp((e.clientX - r.left) / r.width, 0, 1) * max); };
  const key = (e) => {
    const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -step * 5, PageUp: step * 5 }[e.key];
    if (d) { e.preventDefault(); onChange(clamp(value + d, 0, max)); }
    else if (e.key === "Home") { e.preventDefault(); onChange(0); }
    else if (e.key === "End") { e.preventDefault(); onChange(max); }
  };
  const h = tall ? 30 : 10;
  return (
    <div style={{ position: "relative", paddingTop: ticks.length ? 34 : 0 }}>
      {ticks.map((tk) => (
        <div key={tk.label} style={{ position: "absolute", top: 0, left: `${(tk.at / max) * 100}%`, transform: "translateX(-50%)", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <button type="button" onClick={tk.onClick} aria-pressed={tk.on} style={{ fontSize: 11, fontWeight: 700, lineHeight: 1, padding: "7px 10px", borderRadius: 7, cursor: "pointer", fontFamily: FONT, whiteSpace: "nowrap",
            border: "1px solid " + (tk.on ? tk.color : "rgba(255,255,255,0.18)"), background: tk.on ? tk.color : SCENE_BG, color: tk.on ? T.bg : T.text }}>{tk.label}</button>
          <div style={{ width: 2, height: 8, background: tk.on ? tk.color : "rgba(255,255,255,0.3)" }} />
        </div>
      ))}
      <div ref={ref} role="slider" tabIndex={0} aria-label={label} aria-valuemin={0} aria-valuemax={Math.round(max * 1000)} aria-valuenow={Math.round(value * 1000)} aria-valuetext={valueText}
        onKeyDown={key} onPointerDown={(e) => { dragging.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); at(e); }} onPointerMove={(e) => dragging.current && at(e)}
        onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }}
        style={{ position: "relative", padding: tall ? 0 : "11px 0", cursor: "ew-resize", touchAction: "none", outlineOffset: 3 }}>
        <div style={{ display: "flex", height: h, borderRadius: tall ? 8 : 5, overflow: "hidden", background: "rgba(255,255,255,0.1)" }}>
          {(segments || []).map((s) => {
            const px = (s.frac * w) || 0, text = px >= s.label.length * 6.9 + 16 ? s.label : px >= s.short.length * 6.9 + 10 ? s.short : "";
            return <div key={s.label} style={{ width: `${s.frac * 100}%`, background: s.color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: T.white, whiteSpace: "nowrap", overflow: "hidden", fontVariantNumeric: "tabular-nums" }}>{text}</div>;
          })}
          {!segments && <div style={{ width: `${(value / max) * 100}%`, background: "rgba(96,165,250,0.55)" }} />}
        </div>
        <div style={{ position: "absolute", left: `${(value / max) * 100}%`, top: tall ? -4 : 5, width: tall ? 3 : 14, height: tall ? h + 8 : 22, borderRadius: tall ? 2 : 7, background: T.white, transform: "translateX(-50%)", boxShadow: "0 0 0 2px " + SCENE_BG }} />
      </div>
    </div>
  );
}


const sceneBox = { display: "block", background: SCENE_BG, border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, touchAction: "pan-y", cursor: "grab", userSelect: "none", outlineOffset: 3 };
const toolbar = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 10 };

// ─── Generic pitch (used by Time to Decide) ─────────────────────────────────
const FLIGHT_FT = 54.5, PLATE_FACTOR = 0.91, MPH_TO_FTS = 1.46667, RELEASE_HT = 5.8;
function pitch(mph) {
  const v0 = mph * MPH_TO_FTS, vf = PLATE_FACTOR * v0, a = (vf * vf - v0 * v0) / (2 * FLIGHT_FT);
  return { T: (2 * FLIGHT_FT) / (v0 + vf), dist: (t) => Math.min(FLIGHT_FT, v0 * t + 0.5 * a * t * t) };
}
const ms = (t) => Math.round(t * 1000) + " ms";

// ─── Time to decide: where is the pitch when the swing has to start? ─────────
// Opens in Side view, parked on the instant the hitter must start: the ball, and a
// bracket from the ball to contact. Same generic pitch as before (54.5 ft of flight,
// ~9% speed loss, arriving about 6° downhill). Distances along the pitch are to scale;
// the ball, plate and bat are enlarged in the full-length view so they can be seen.
const TTD_VIEWS = {
  Side: { az: 7, el: 8, dist: 90, target: [-27.7, 2.6, 0], span: [66, 17], cy: 0.44, fixed: true }, // pitch runs left to right for everyone, like the timeline under it
  Angle: { az: 64, el: 13, dist: 46 }, // az as seen for a lefty, mirrored for righties; framed to fit the pitch
  Catcher: { az: 90, el: 34, dist: 50 },
};

function TimeToDecide({ t }) {
  const ttc = t.sum.ttc, avgTtc = groupMean("ttc");
  const aa = t.sum.aa, vba = t.sum.vba ?? groupMean("vba"), lefty = t.bats === "L";
  const contactFrame = useMemo(() => swingModel(aa, vba, lefty).at(1), [aa, vba, lefty]);
  const homeFor = (n) => {
    const v = TTD_VIEWS[n];
    if (v.fixed) return v;
    const c = contactFrame.sweet;
    return { ...fitView(lefty || n === "Catcher" ? v.az : 180 - v.az, v.el, v.dist, [[c[0] - FLIGHT_FT, RELEASE_HT + 1.5, 0], [c[0] - FLIGHT_FT, 0, 0], c, [2.5, 0, -2.5], [2.5, 0, 2.5], [-2, 0, -3], [-2, 0, 3]], 1.2), cy: 0.52 };
  };
  const orbit = useOrbit(homeFor, "Side");
  const [mph, setMph] = useState(90);
  const [speed, setSpeed] = useState(0.2);
  const [clock, setClock] = useState(null); // null = parked on the swing-start instant (the opening view)
  const [playing, setPlaying] = useState(false);
  const raf = useRef(null), firstRun = useRef(true), speedNow = useRef(speed);
  speedNow.current = speed;
  const [sceneRef, size] = useMeasure();
  const P = useMemo(() => pitch(mph), [mph]);
  const stop = () => { cancelAnimationFrame(raf.current); setPlaying(false); };
  useEffect(() => { stop(); setClock(null); }, [t, mph]); // any new hitter, session or speed returns to the swing-start freeze-frame
  useEffect(() => { if (firstRun.current) { firstRun.current = false; return; } orbit.go(orbit.name || "Side", true); }, [t]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  if (ttc == null) return null;

  const tStart = P.T - ttc, now = clock == null ? tStart : clock, parked = clock == null;
  const feels = FLIGHT_FT / (((1 + PLATE_FACTOR) / 2) * MPH_TO_FTS * (tStart + avgTtc));
  const play = () => {
    if (playing) { stop(); return; }
    cancelAnimationFrame(raf.current);
    setPlaying(true);
    let last = null, x = 0;
    const step = (ts) => {
      if (last != null) x += ((ts - last) / 1000) * speedNow.current;
      last = ts;
      if (x >= P.T) { setClock(P.T); setPlaying(false); return; }
      setClock(x);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const scrub = (v) => { stop(); setClock(v); };

  // Ball flight: straight at the plate, dropping on a curve that arrives ~6° downhill at the contact point.
  const C = contactFrame.sweet, rel = [C[0] - FLIGHT_FT, RELEASE_HT, 0], drop = C[1] - RELEASE_HT;
  const curve = (-Math.tan(rad(6)) * FLIGHT_FT - drop) / (FLIGHT_FT * FLIGHT_FT), slope = drop / FLIGHT_FT - curve * FLIGHT_FT;
  const ballAt = (time) => { const s = P.dist(clamp(time, 0, P.T)); return [rel[0] + s, RELEASE_HT + slope * s + curve * s * s, 0]; };
  const K = 48, times = [...Array(K + 1)].map((_, i) => (P.T * i) / K);
  const flown = (from, to) => { const end = Math.min(to, now); if (end <= from) return []; return [from, ...times.filter((x) => x > from && x < end), end].map(ballAt); };
  const gate = ballAt(tStart), ftOut = Math.round(FLIGHT_FT - P.dist(tStart));
  const first = t.name.split(" ")[0];
  const summary = `At ${mph} mph, ${first}'s swing has to start with the ball ${ftOut} feet from contact, ${Math.round(tStart * 1000)} milliseconds after release. The swing takes ${Math.round(ttc * 1000)} milliseconds and the pitch takes ${Math.round(P.T * 1000)}.`;

  const scene = (wide) => {
    const w = size.w || 340, h = wide ? 240 : 204;
    const cam = makeCamera(orbit.view, w, h);
    const gateP = cam.proj(gate), cP = cam.proj(C), relP = cam.proj(rel), ballP = cam.proj(ballAt(now));
    // Things that would be specks with the whole pitch in frame are drawn larger, by the same factor.
    const big = clamp(24 / (1.42 * cam.pxPerFt([0, 0, 0])), 1, 5);
    const plate = PLATE.map((p) => cam.proj(vmul(p, big))), plateP = cam.proj([0, 0, 0]);
    const ballR = Math.max(6.5, 0.12 * cam.pxPerFt(ballAt(now)));
    const line = (a, b, props) => { const s = cam.seg(a, b); return s && <line x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} {...props} />; };
    const ground = [[rel[0] - 7, 0, -5], [3.5, 0, -5], [3.5, 0, 5], [rel[0] - 7, 0, 5]].map(cam.proj);
    const mound = [...Array(28)].map((_, i) => cam.proj([rel[0] - 4.5 + 9 * Math.cos((i * Math.PI) / 14), 0, 9 * Math.sin((i * Math.PI) / 14)]));
    // Distance bracket: along the ground from under the ball (at swing start) to under the contact point, set off below it.
    const gA = cam.proj([gate[0], 0, 0]), gB = cam.proj([C[0], 0, 0]);
    const dx = gB[0] - gA[0], dy = gB[1] - gA[1], L = Math.hypot(dx, dy) || 1;
    let nx = -dy / L, ny = dx / L;
    if (ny < 0 || (Math.abs(ny) < 0.35 && nx < 0)) { nx = -nx; ny = -ny; }
    const off = 26, A2 = [gA[0] + nx * off, gA[1] + ny * off], B2 = [gB[0] + nx * off, gB[1] + ny * off], mid = [(A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2];
    const bracket = L >= 64, steep = Math.abs(dx) < Math.abs(dy);
    const bracketText = `${ftOut} ft to contact`, tw = bracketText.length * 8.3 + 14;
    const ballR0 = Math.max(6.5, 0.12 * cam.pxPerFt(gate));
    const onLine = bracket && !steep && L >= tw + 56; // room to break the line around the label
    const labelX = clamp(bracket ? (steep ? mid[0] + tw / 2 + 10 : mid[0]) : gateP[0], tw / 2 + 6, w - tw / 2 - 6);
    const labelY = !bracket ? gateP[1] + ballR0 + 26 : onLine || steep ? mid[1] : mid[1] + 21;
    const startY = Math.max(40, gateP[1] - 34);
    const status = playing || !parked ? (now < tStart ? "Seeing and deciding" : now < P.T - 1e-6 ? "Swinging" : "Contact") : "Paused at swing start";
    const statusColor = now < tStart ? T.green : now < P.T - 1e-6 || parked ? T.orange : T.white;
    return (
      <div ref={sceneRef} tabIndex={0} aria-label="Pitch diagram. Drag or use the arrow keys to rotate." {...orbit.handlers} style={{ ...sceneBox, height: h }}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={summary} style={{ display: "block", fontFamily: FONT }}>
          <polygon points={pts(ground)} fill="rgba(255,255,255,0.028)" />
          <polygon points={pts(mound)} fill="rgba(255,255,255,0.035)" />
          {line([rel[0] - 7, 0, 0], [3.5, 0, 0], { stroke: "rgba(255,255,255,0.14)" })}
          {[10, 20, 30, 40, 50].map((d) => <g key={d}>{line([C[0] - d, 0, -0.9], [C[0] - d, 0, 0.9], { stroke: "rgba(255,255,255,0.22)" })}</g>)}
          {line([rel[0], 0, 0], rel, { stroke: "rgba(255,255,255,0.22)" })}
          <circle cx={relP[0]} cy={relP[1]} r="3" fill="none" stroke={T.muted} strokeWidth="1.25" />
          <polygon points={pts(plate)} fill="rgba(255,255,255,0.85)" stroke="rgba(255,255,255,0.95)" strokeWidth="0.75" strokeLinejoin="round" />
          <polyline points={pts(times.map(ballAt).map(cam.proj))} fill="none" stroke="rgba(255,255,255,0.22)" strokeDasharray="2 5" />
          <polyline points={pts(flown(0, tStart).map(cam.proj))} fill="none" stroke={T.green} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points={pts(flown(tStart, P.T).map(cam.proj))} fill="none" stroke={T.orange} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx={cP[0]} cy={cP[1]} r="4" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1.25" />
          {bracket && <g>
            <line x1={gateP[0]} y1={gateP[1] + 12} x2={A2[0] + nx * 5} y2={A2[1] + ny * 5} stroke="rgba(255,255,255,0.4)" strokeDasharray="2 3" />
            <line x1={cP[0]} y1={cP[1] + 7} x2={B2[0] + nx * 5} y2={B2[1] + ny * 5} stroke="rgba(255,255,255,0.4)" strokeDasharray="2 3" />
            <line x1={A2[0]} y1={A2[1]} x2={B2[0]} y2={B2[1]} stroke={T.white} strokeWidth="1.5" />
            <line x1={A2[0] - nx * 5} y1={A2[1] - ny * 5} x2={A2[0] + nx * 5} y2={A2[1] + ny * 5} stroke={T.white} strokeWidth="1.5" />
            <line x1={B2[0] - nx * 5} y1={B2[1] - ny * 5} x2={B2[0] + nx * 5} y2={B2[1] + ny * 5} stroke={T.white} strokeWidth="1.5" />
          </g>}
          <rect x={labelX - tw / 2} y={labelY - 12} width={tw} height="24" rx="6" fill={SCENE_BG} />
          <text x={labelX} y={labelY + 5.5} textAnchor="middle" fontSize="15" fontWeight="700" fill={T.white} style={{ fontVariantNumeric: "tabular-nums" }}>{bracketText}</text>
          <circle cx={gateP[0]} cy={gateP[1]} r={ballR + 4.5} fill="none" stroke={T.orange} strokeWidth="2" />
          <line x1={gateP[0]} y1={gateP[1] - ballR - 7} x2={gateP[0]} y2={startY + 6} stroke={T.orange} strokeWidth="1.25" />
          <SceneText x={gateP[0]} y={startY} w={w} fill={T.orange} weight={700}>{w >= 300 ? "Estimated swing start" : "Swing start"}</SceneText>
          {now >= P.T - 1e-6 && <BatShape cam={cam} frame={contactFrame} scale={big} />}
          <circle cx={ballP[0]} cy={ballP[1]} r={ballR + 3} fill="rgba(255,255,255,0.16)" />
          <circle cx={ballP[0]} cy={ballP[1]} r={ballR} fill={T.white} stroke={SCENE_BG} strokeWidth="1.25" />
          {(Math.abs(relP[0] - gateP[0]) > 120 || Math.abs(relP[1] - 10 - startY) > 18) && <SceneText x={relP[0]} y={relP[1] - 10} w={w} size={10} weight={500} fill={T.muted}>Release</SceneText>}
          <SceneText x={plateP[0] + 14} y={Math.min(h - 8, plateP[1] + (bracket && !steep ? off + (onLine ? 26 : 44) : 20))} w={w} size={10} weight={500} fill={T.muted} anchor="end">Home plate</SceneText>
          <text x="12" y="21" fontSize="12" fontWeight="700" fill={statusColor}>{status}</text>
          <text x={w - 12} y="21" textAnchor="end" fontSize="11" fill={T.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{ms(now)} after release</text>
        </svg>
      </div>
    );
  };

  const segs = [
    { frac: tStart / P.T, color: "rgba(79,255,176,0.30)", label: `${ms(tStart)} to decide`, short: ms(tStart) },
    { frac: ttc / P.T, color: "rgba(255,140,66,0.42)", label: `${ms(ttc)} swing`, short: ms(ttc) },
  ];
  return (
    <AnalysisCard title="Time to Decide" subtitle="Generic pitch model. Where the ball is when the swing has to start."
      lead={(wide) => (
        <div>
          <p style={{ margin: 0, fontSize: wide ? 17 : 15, lineHeight: 1.4, color: T.muted, fontWeight: 500 }}>
            At <b style={{ color: T.white, fontWeight: 700 }}>{mph} mph</b>, {first}'s swing has to start with the ball <b style={{ color: T.white, fontWeight: 700, whiteSpace: "nowrap" }}>{ftOut} ft from contact</b>.
          </p>
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <label htmlFor="ttd-mph" style={eyebrow}>Fastball speed</label>
              <span style={{ fontSize: 22, fontWeight: 700, color: T.white, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{mph}<span style={{ fontSize: 12, fontWeight: 500, color: T.muted }}> mph</span></span>
            </div>
            <input id="ttd-mph" type="range" min="60" max="100" step="1" value={mph} onChange={(e) => setMph(+e.target.value)} style={{ width: "100%", accentColor: T.green, margin: "10px 0 2px", height: 24 }} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.faint }}><span>60</span><span>100</span></div>
          </div>
        </div>
      )}
      diagram={(wide) => (
        <div>
          {scene(wide)}
          <div style={toolbar}>
            <PlayButton playing={playing} onClick={play} label="Play" />
            <Segmented label="Playback speed" options={SPEEDS} value={speed} onChange={setSpeed} />
            <Segmented label="Camera view" options={Object.keys(TTD_VIEWS).map((n) => [n, n])} value={orbit.name} onChange={(n) => orbit.go(n)} />
          </div>
          <div style={{ marginTop: 14 }}>
            <Scrubber tall value={now} max={P.T} step={0.01} onChange={scrub} label="Pitch timeline" valueText={`${ms(now)} after release`} segments={segs}
              ticks={[{ at: tStart, label: "Swing start", color: T.orange, on: parked, onClick: () => { stop(); setClock(null); } }]} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.muted, marginTop: 7, fontVariantNumeric: "tabular-nums" }}>
              <span>Release</span><span>Contact <b style={{ color: T.text, fontWeight: 700 }}>{ms(P.T)}</b> total</span>
            </div>
          </div>
        </div>
      )}
      aux={() => (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
          <div style={{ fontSize: 13, color: T.text, lineHeight: 1.45 }}>Feels like <b style={{ color: T.white, fontVariantNumeric: "tabular-nums" }}>{Math.round(feels)} mph</b> <span style={{ color: T.muted }}>to a hitter with an average swing.</span></div>
          <div style={{ fontSize: 11, color: T.dim, lineHeight: 1.5, marginTop: 8 }}>Estimated from a generic pitch and {first}'s Blast time to contact. Distances along the pitch are to scale; the ball, plate and bat are drawn larger.</div>
        </div>
      )} />
  );
}

// ─── Swing path: what is the barrel doing at contact? ────────────────────────
// The swing comes from swingModel.js: exact at contact for attack angle and vertical
// bat angle, a generic shape elsewhere. Opens paused at contact with one measurement
// called out. Each measurement has the view that shows it true (attack angle from the
// side, vertical bat angle looking square at the bat from behind the plate); its arc
// fades as the camera leaves that view, so a slanted projection never reads as the angle.
const VIEW_ANGLES = { Angle: [40, 16], Side: [0, 4], Catcher: [90, 7], Top: [0, 84] }; // [az, el]; az as seen for a lefty, mirrored for righties
const METRIC_VIEW = { aa: "Side", vba: "Catcher" };

function AngleCard({ on, inView, viewName, disabled, onClick, label, value, meaning, detail, wide }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-pressed={on} style={{ display: "block", width: "100%", textAlign: "left", fontFamily: FONT, cursor: disabled ? "default" : "pointer", borderRadius: 12,
      padding: wide ? "13px 14px" : "11px 12px", background: on ? "rgba(79,255,176,0.07)" : "rgba(255,255,255,0.03)", border: "1px solid " + (on ? "rgba(79,255,176,0.5)" : "rgba(255,255,255,0.08)"), opacity: disabled ? 0.55 : 1 }}>
      <div style={{ ...eyebrow, color: on ? T.green : T.dim }}>{label}</div>
      <div style={{ fontSize: wide ? 30 : 26, fontWeight: 700, color: T.white, lineHeight: 1.1, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: T.text, marginTop: 3, lineHeight: 1.35 }}>{meaning}</div>
      {detail && <div style={{ fontSize: 10.5, color: T.dim, marginTop: 5, lineHeight: 1.4, fontVariantNumeric: "tabular-nums" }}>{detail}</div>}
      {!disabled && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 9, fontSize: 11, fontWeight: 600, color: on ? T.green : T.muted }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, boxSizing: "border-box", background: on ? T.green : "transparent", border: "1.5px solid " + (on ? T.green : T.dim) }} />
          {on ? (inView ? "Shown in the diagram" : `Return to the ${viewName.toLowerCase()} view`) : "Show in the diagram"}
        </div>
      )}
    </button>
  );
}

function SwingPath({ t }) {
  const aa = t.sum.aa, hasVba = t.sum.vba != null, vba = hasVba ? t.sum.vba : groupMean("vba");
  const lefty = t.bats === "L", side = lefty ? -1 : 1;
  const dur = t.sum.ttc ?? groupMean("ttc");
  const N = 72;
  const swing = useMemo(() => { const m = swingModel(aa, vba, lefty); return { m, frames: [...Array(N + 1)].map((_, i) => m.at((TAU_END * i) / N)), contact: m.at(1) }; }, [aa, vba, lefty]);
  // Sweet-spot path of every counted swing, each from its own two angles.
  const each = useMemo(() => t.swings.filter((s) => s.aa != null).map((s) => { const m = swingModel(s.aa, s.vba ?? vba, lefty); return [...Array(17)].map((_, i) => m.at(0.5 + (0.7 * i) / 16).sweet); }), [t, vba, lefty]);
  const m = swing.m, C = m.contact, H = m.handsAtContact, b = m.batAtContact;
  const flatDir = vnorm([b[0], 0, b[2]]), tilt = Math.asin(b[1]);
  const square = vnorm(vcross(flatDir, UP)); // looking along this, the bat's tilt is seen true
  const homeFor = (n) => {
    const [az0, el] = VIEW_ANGLES[n];
    const az = n === "Catcher" ? (Math.atan2(square[0], square[2]) * 180) / Math.PI + (square[0] < 0 ? 180 : 0) : lefty ? az0 : 180 - az0;
    const frame = [...swing.frames.flatMap((f) => [f.hands, f.tip]), ...PLATE, vadd(C, vmul(m.travel, 2.1)), vadd(C, [-2.1, 0, 0]), vadd(H, vmul(flatDir, BAT_LEN))];
    return fitView(az, el, 14, frame);
  };
  const [sel, setSel] = useState("aa");
  const orbit = useOrbit(homeFor, METRIC_VIEW.aa);
  const [tau, setTau] = useState(1); // 1 = contact
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(0.07);
  const [showAll, setShowAll] = useState(false);
  const raf = useRef(null), back = useRef(null), firstRun = useRef(true), speedNow = useRef(speed);
  speedNow.current = speed;
  const [sceneRef, size] = useMeasure();
  const stop = () => { cancelAnimationFrame(raf.current); clearTimeout(back.current); setPlaying(false); };
  const toContact = () => { stop(); setTau(1); };
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    const keep = sel === "vba" && !hasVba ? "aa" : sel;
    stop(); setTau(1); setSel(keep); setShowAll(false); orbit.go(METRIC_VIEW[keep], true);
  }, [t]);
  useEffect(() => () => { cancelAnimationFrame(raf.current); clearTimeout(back.current); }, []);

  const play = () => {
    if (playing) { stop(); return; }
    stop();
    setPlaying(true);
    let last = null, x = 0;
    const step = (ts) => {
      if (last != null) x += (((ts - last) / 1000) * speedNow.current) / dur;
      last = ts;
      if (x >= TAU_END) { setTau(TAU_END); setPlaying(false); back.current = setTimeout(() => setTau(1), 650); return; } // then settle back on contact
      setTau(x);
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const pick = (k) => { toContact(); setSel(k); orbit.go(METRIC_VIEW[k]); };
  const atContact = Math.abs(tau - 1) < 0.004;
  const vbaText = `${signed(vba)}°`, aaText = `${signed(aa)}°`;
  const range = (k) => { const v = t.swings.map((s) => s[k]).filter((x) => x != null); return v.length ? `${signed(Math.min(...v))}° to ${signed(Math.max(...v))}°` : null; };
  const aaMeaning = aa >= 1 ? "Barrel moving up at contact" : aa <= -1 ? "Barrel moving down at contact" : "Barrel moving level at contact";
  const summary = `Modeled swing path. At contact the barrel is traveling at ${aaText} attack angle (${aaMeaning.toLowerCase()})${hasVba ? ` and the bat is tilted ${vbaText} from level` : ""}.`;

  const scene = (wide) => {
    const w = size.w || 340, h = wide ? 430 : Math.round(clamp(w * 0.92, 280, 340));
    const cam = makeCamera(orbit.view, w, h);
    const live = m.at(tau), hit = tau >= 1;
    const shown = swing.frames.filter((f) => f.tau < tau);
    const before = [...shown.filter((f) => f.tau <= 1), hit ? swing.contact : live];
    const after = hit ? [swing.contact, ...shown.filter((f) => f.tau > 1), live] : [];
    const quad = (a, c) => pts([cam.proj(a.hands), cam.proj(a.tip), cam.proj(c.tip), cam.proj(c.hands)]);
    const line = (a, c, props) => { const s = cam.seg(a, c); return s && <line x1={s[0]} y1={s[1]} x2={s[2]} y2={s[3]} {...props} />; };
    // Pitch: about 6° downhill into the contact point, arriving with the barrel.
    const pitchAt = (ft) => [C[0] - ft * Math.cos(rad(6)), C[1] + ft * Math.sin(rad(6)), C[2]];
    const ballFt = 126 * dur * Math.max(0, 1 - tau) + 0.23; // ~86 mph at the plate; at contact it rests against the barrel
    const ballP = cam.proj(pitchAt(ballFt)), cP = cam.proj(C), batP = cam.proj(live.sweet), handsP = cam.proj(live.hands);
    const ballR = Math.max(3.5, 0.12 * cam.pxPerFt(C));
    const ball = tau <= 1.02 && <circle cx={ballP[0]} cy={ballP[1]} r={ballR} fill={T.white} stroke={SCENE_BG} strokeWidth="1" />;
    const grid = [];
    for (let x = -8; x <= 5; x += 1) grid.push(cam.seg([x, 0, -6], [x, 0, 6]));
    for (let z = -6; z <= 6; z += 1) grid.push(cam.seg([-8, 0, z], [5, 0, z]));
    const box = [[-3, 0, 1.2 * side], [3, 0, 1.2 * side], [3, 0, 5.2 * side], [-3, 0, 5.2 * side]].map(cam.proj);

    // The measurement callout: full strength in its own view at contact, fading as the camera turns away.
    const offAxis = (dir) => (Math.acos(clamp(Math.abs(vdot(cam.out, dir)), 0, 1)) * 180) / Math.PI;
    const seen = clamp(1 - (offAxis(sel === "aa" ? [0, 0, 1] : square) - 10) / 16, 0, 1) * (atContact ? 1 : 0.32);
    const G = T.green;
    let callout = null, refs = null;
    if (sel === "aa" && seen > 0.01) {
      const tip = vadd(C, vmul(m.travel, 1.9)), tipP = cam.proj(tip), levelEnd = cam.proj(vadd(C, [-1.9, 0, 0]));
      const ang = Math.atan2(tipP[1] - cP[1], tipP[0] - cP[0]);
      const head = (k) => [tipP[0] - 10 * Math.cos(ang + k), tipP[1] - 10 * Math.sin(ang + k)];
      const arc = [...Array(13)].map((_, i) => cam.proj(vadd(C, vmul([-Math.cos((rad(aa) * i) / 12), Math.sin((rad(aa) * i) / 12), 0], 1.3))));
      const right = tipP[0] >= cP[0];
      const lx = cP[0] + (right ? 16 : -16), ly = aa >= 0 ? Math.min(cP[1], tipP[1]) - 12 : Math.max(cP[1], tipP[1]) + 24;
      refs = <g opacity={seen}>{line(vadd(C, [0.6, 0, 0]), vadd(C, [-2.1, 0, 0]), { stroke: "rgba(255,255,255,0.7)", strokeDasharray: "4 4", strokeWidth: 1.25 })}</g>;
      callout = (
        <g opacity={seen}>
          {Math.abs(aa) >= 1 && <polyline points={pts(arc)} fill="none" stroke={G} strokeWidth="1.75" />}
          <line x1={cP[0]} y1={cP[1]} x2={tipP[0]} y2={tipP[1]} stroke={G} strokeWidth="3" strokeLinecap="round" />
          <polygon points={pts([tipP, head(0.42), head(-0.42)])} fill={G} stroke={G} strokeWidth="1" strokeLinejoin="round" />
          <SceneText x={lx} y={ly} w={w} size={15} weight={700} fill={T.white} anchor={right ? "start" : "end"}>{`${aaText} attack angle`}</SceneText>
          <SceneText x={levelEnd[0]} y={levelEnd[1] + (aa >= 0 ? 15 : -8)} w={w} size={10} weight={500} fill={T.muted}>level</SceneText>
        </g>
      );
    }
    if (sel === "vba" && seen > 0.01) {
      const refEnd = vadd(H, vmul(flatDir, BAT_LEN)), refP = cam.proj(refEnd), hP = cam.proj(H), tipP = cam.proj(vadd(H, vmul(b, BAT_LEN + 0.35)));
      const arc = [...Array(13)].map((_, i) => { const g = (tilt * i) / 12; return cam.proj(vadd(H, vmul(vadd(vmul(flatDir, Math.cos(g)), [0, Math.sin(g), 0]), 1.55))); });
      const above = vba <= 0 ? -1 : 1; // label on the far side of the level line from the bat
      refs = <g opacity={seen}>{line(H, refEnd, { stroke: "rgba(255,255,255,0.7)", strokeDasharray: "4 4", strokeWidth: 1.25 })}</g>;
      callout = (
        <g opacity={seen}>
          <line x1={hP[0]} y1={hP[1]} x2={tipP[0]} y2={tipP[1]} stroke={G} strokeWidth="1.75" strokeLinecap="round" />
          {Math.abs(vba) >= 1 && <polyline points={pts(arc)} fill="none" stroke={G} strokeWidth="1.75" />}
          <SceneText x={(hP[0] + refP[0]) / 2} y={(hP[1] + refP[1]) / 2 + (above < 0 ? -17 : 27)} w={w} size={15} weight={700} fill={T.white}>{`${vbaText} vertical bat angle`}</SceneText>
          <SceneText x={refP[0]} y={refP[1] + (above < 0 ? 15 : -8)} w={w} size={10} weight={500} fill={T.muted}>level</SceneText>
          <SceneText x={hP[0] + (refP[0] >= hP[0] ? -9 : 9)} y={hP[1] + 4} w={w} size={10} weight={500} fill={T.muted} anchor={refP[0] >= hP[0] ? "end" : "start"}>hands</SceneText>
        </g>
      );
    }
    const msTo = Math.round((1 - tau) * dur * 1000);
    const when = atContact ? "Contact" : tau < 1 ? `${msTo} ms to contact` : `${-msTo} ms after contact`;
    return (
      <div ref={sceneRef} tabIndex={0} aria-label="Swing diagram. Drag or use the arrow keys to rotate." {...orbit.handlers} style={{ ...sceneBox, height: h }}>
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={summary} style={{ display: "block", fontFamily: FONT }}>
          {grid.map((g, i) => g && <line key={i} x1={g[0]} y1={g[1]} x2={g[2]} y2={g[3]} stroke="rgba(255,255,255,0.04)" />)}
          <polygon points={pts(box)} fill="none" stroke="rgba(255,255,255,0.12)" />
          <polygon points={pts(PLATE.map(cam.proj))} fill="rgba(255,255,255,0.8)" stroke="rgba(255,255,255,0.95)" strokeWidth="0.75" strokeLinejoin="round" />
          {line(pitchAt(9), C, { stroke: "rgba(255,255,255,0.2)", strokeDasharray: "2 5" })}
          {showAll && each.map((path, i) => <polyline key={i} points={pts(path.map(cam.proj))} fill="none" stroke={T.white} strokeOpacity="0.3" strokeWidth="1" />)}
          {before.slice(1).map((f, i) => <polygon key={i} points={quad(before[i], f)} fill={T.blue} fillOpacity="0.04" />)}
          {after.slice(1).map((f, i) => <polygon key={"a" + i} points={quad(after[i], f)} fill={T.blue} fillOpacity="0.022" />)}
          <polyline points={pts(before.map((f) => cam.proj(f.sweet)))} fill="none" stroke={T.blue} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          {after.length > 1 && <polyline points={pts(after.map((f) => cam.proj(f.sweet)))} fill="none" stroke={T.blue} strokeOpacity="0.45" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />}
          {refs}
          {tau > 1.02 && <circle cx={cP[0]} cy={cP[1]} r="4" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.25" />}
          {ballP[2] >= batP[2] && ball}
          <BatShape cam={cam} frame={live} />
          <circle cx={handsP[0]} cy={handsP[1]} r="3" fill={T.text} stroke={SCENE_BG} strokeWidth="1" />
          {ballP[2] < batP[2] && ball}
          {callout}
          <text x="12" y="21" fontSize="12" fontWeight="700" fill={atContact ? T.white : T.muted} style={{ fontVariantNumeric: "tabular-nums" }}>{when}</text>
        </svg>
      </div>
    );
  };

  const nAll = each.length;
  return (
    <AnalysisCard title="Swing Path" subtitle="Modeled swing path. What the barrel is doing at contact."
      lead={(wide) => (
        <div style={{ display: "grid", gridTemplateColumns: wide ? "minmax(0, 1fr)" : "minmax(0, 1fr) minmax(0, 1fr)", gap: wide ? 10 : 8 }}>
          <AngleCard wide={wide} on={sel === "aa"} inView={orbit.name === METRIC_VIEW.aa} viewName={METRIC_VIEW.aa} onClick={() => pick("aa")} label="Attack angle" value={aaText} meaning={aaMeaning}
            detail={[range("aa") && `Swings ${range("aa")}`, `group ${signed(groupMean("aa"))}°`].filter(Boolean).join(" · ")} />
          <AngleCard wide={wide} on={sel === "vba"} inView={orbit.name === METRIC_VIEW.vba} viewName={METRIC_VIEW.vba} disabled={!hasVba} onClick={() => pick("vba")} label="Vertical bat angle" value={hasVba ? vbaText : "–"}
            meaning={hasVba ? (vba <= -1 ? "Barrel below the hands" : vba >= 1 ? "Barrel above the hands" : "Bat level") : "Not captured this session"}
            detail={hasVba ? [range("vba") && `Swings ${range("vba")}`, `group ${signed(groupMean("vba"))}°`].filter(Boolean).join(" · ") : "Bat drawn at the group average."} />
        </div>
      )}
      diagram={(wide) => (
        <div>
          {scene(wide)}
          <div style={toolbar}>
            <PlayButton playing={playing} onClick={play} label="Play" />
            <Segmented label="Playback speed" options={SPEEDS} value={speed} onChange={setSpeed} />
            <Segmented label="Camera view" options={Object.keys(VIEW_ANGLES).map((n) => [n, n])} value={orbit.name} onChange={(n) => orbit.go(n)} />
          </div>
          <div style={{ marginTop: 12 }}>
            <Scrubber value={tau} max={TAU_END} step={0.02} onChange={(v) => { stop(); setTau(v); }} label="Swing timeline" valueText={atContact ? "Contact" : tau < 1 ? `${Math.round((1 - tau) * dur * 1000)} milliseconds to contact` : `${Math.round((tau - 1) * dur * 1000)} milliseconds after contact`}
              ticks={[{ at: 1, label: "Contact", color: T.green, on: atContact, onClick: toContact }]} />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.muted }}><span>Start of swing</span><span>Follow-through</span></div>
          </div>
        </div>
      )}
      aux={() => (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 12 }}>
          {nAll > 1 && (
            <button type="button" aria-pressed={showAll} onClick={() => setShowAll((v) => !v)} style={{ ...pillStyle(showAll), border: "1px solid " + (showAll ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.12)"), borderRadius: 9, marginBottom: 10 }}>
              {showAll ? `Hide ${nAll} swings` : `Show all ${nAll} swings`}
            </button>
          )}
          <div style={{ fontSize: 11, color: T.dim, lineHeight: 1.5 }}>Blast measures the angles at contact. The surrounding swing path is reconstructed.</div>
        </div>
      )} />
  );
}

// ─── Two routes: bat speed vs time to contact ───────────────────────────────
function Routes({ t, onPick }) {
  const pts = (t.bat.own ? [...poolWith(t), t] : poolWith(t)).filter((x) => x.sum.ttc != null);
  if (t.sum.ttc == null) return null;
  const W = 520, H = 260, L = 44, B = 34, R = 14, TOP = 12;
  const xs = pts.map((x) => x.sum.ttc), ys = pts.map((x) => x.sum.bs);
  const x0 = Math.min(...xs) - 0.008, x1 = Math.max(...xs) + 0.008, y0 = Math.floor(Math.min(...ys) - 2), y1 = Math.ceil(Math.max(...ys) + 2);
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - B - TOP);
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Two Routes to Bat Speed</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 10 }}>Up is more bat speed. Left is a quicker swing. Tap a dot to open that hitter.</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 640, margin: "0 auto" }}>
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
      <div style={{ maxWidth: 940, margin: "0 auto", padding: "0 18px" }}>
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

const SWING_LAB_PASSWORD = "Blast";
const UNLOCK_KEY = "swing_ok";

function StaffGate({ logo, onOk }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(false);
  const submit = (e) => {
    e.preventDefault();
    if (pw.trim() === SWING_LAB_PASSWORD) { try { sessionStorage.setItem(UNLOCK_KEY, "1"); } catch (e) {} onOk(); }
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

export function SwingLabPage({ logo }) {
  const [ok, setOk] = useState(() => { try { return sessionStorage.getItem(UNLOCK_KEY) === "1"; } catch (e) { return false; } });
  if (!ok) return <StaffGate logo={logo} onOk={() => setOk(true)} />;
  return <SwingLab logo={logo} />;
}

function BlastTab({ name, setName }) {
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
    <>
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
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>Bats {t.bats === "L" ? "left" : t.bats === "S" ? "switch" : "right"} {"·"} {d} {"·"} {t.bat.label}{t.bat.own ? ` (${t.bat.whose || "own bat"})` : ""}</div>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", columnGap: 12, alignItems: "start" }}>
        {METRICS.map((m) => <MetricCard key={m.k} m={m} t={t} pool={poolWith(t)} rankNote={t.bat.own ? "OTHER BAT, NOT RANKED" : null} missing="Not captured: this session was before the six-tile Blast layout." />)}
      </div>
      <Routes t={t} onPick={pick} />

      <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.6, marginTop: 8 }}>
        Blast Motion, facility Baum 33/30, off a tee, cue "swing as hard as you can and hit it hard up the middle." Counted swings only; the first max swing is a settle swing.
        Rankings are among the {FACILITY.length} people tested on the facility bat so far, including pitchers-only and staff. A hitter swinging any other bat is shown with that bat beside the group and is not ranked in it. Time to decide uses a generic pitch (6 ft extension, ~9% speed loss to the plate)
        and time to contact measured from the start of the downswing, so real decision time is a little shorter. None of these numbers have passed the reliability check yet. MLB lines are 2026 season averages from games against live pitching (Statcast, 209 qualified hitters) or Blast's published averages. Yours are off a tee, so read them as a reference, not a target.
      </div>
    </>
  );
}

// Two devices, two tabs (Frank, 11/18/26). They stay separate until enough hitters have
// both on the same swings; then the page can join them. /swinglab#rapsodo opens the second tab.
const TABS = [["blast", "Blast Motion"], ["rapsodo", "Rapsodo"]];

function SwingLab({ logo }) {
  const [tab, setTab] = useState(() => { try { return window.location.hash === "#rapsodo" ? "rapsodo" : "blast"; } catch (e) { return "blast"; } });
  const [blastName, setBlastName] = useState("Luke Desjardins");
  const [rapName, setRapName] = useState(RAPSODO_DEFAULT);
  const go = (next) => {
    if (next === tab) return;
    // Keep the same hitter open when the other device has him too.
    if (next === "rapsodo" && hasRapsodoHitter(blastName)) setRapName(blastName);
    if (next === "blast" && TESTERS.some((x) => x.name === rapName)) setBlastName(rapName);
    setTab(next);
    try { window.history.replaceState(null, "", window.location.pathname + (next === "rapsodo" ? "#rapsodo" : "")); } catch (e) {}
  };
  return (
    <Shell logo={logo}>
      <div role="tablist" aria-label="Device" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, overflow: "hidden", marginBottom: 16 }}>
        {TABS.map(([v, text], i) => (
          <button key={v} type="button" role="tab" id={"tab-" + v} aria-selected={tab === v} onClick={() => go(v)}
            style={{ ...pillStyle(tab === v), fontSize: 13, fontWeight: 700, minHeight: 44, borderLeft: i ? "1px solid rgba(255,255,255,0.08)" : "none" }}>{text}</button>
        ))}
      </div>
      <div role="tabpanel" aria-labelledby={"tab-" + tab}>
        {tab === "blast" ? <BlastTab name={blastName} setName={setBlastName} /> : <RapsodoTab name={rapName} setName={setRapName} />}
      </div>
    </Shell>
  );
}
