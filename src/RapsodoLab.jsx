// ─── Swing Lab: Rapsodo tab ──────────────────────────────────────────────────
// Batted-ball data from the Rapsodo hitting unit at RPM (Frank, 11/18/26). The Blast
// Motion tab shows what the bat did; this one shows what the ball did. They stay
// separate until enough hitters have both devices on the same swings.
//
// Data: rapsodo_data.json, built from Rapsodo's per-ball CSV export by
// Bat Speed Model/rapsodo/import_rapsodo.py then build_rapsodo_data.py. Tee rounds
// from Nov 10, 2026 on. The export has exit velo, launch angle, direction, distance
// and spin for every ball. It has no contact point, bat or handedness, so the page
// talks about field side (left, middle, right), not pull and opposite field.
//
// Flight arcs are a drawing, not a measurement: each one leaves the tee at the ball's
// launch angle and comes down at Rapsodo's projected distance, with no air drag.
import { useMemo, useState } from "react";
import RAP from "./rapsodo_data.json";
import { T, FONT, mean, sd, shortDate, clamp, SCENE_BG, eyebrow, Card, MetricCard, useMeasure, AnalysisCard } from "./labKit.jsx";

const TEE_FT = 2.5;
const SWEET = [8, 32]; // Statcast's sweet-spot launch angles
const MIDDLE = 15; // degrees either side of center that count as "middle"
const rad = (d) => (d * Math.PI) / 180;
const signed = (x) => (Math.round(x) > 0 ? "+" : Math.round(x) < 0 ? "−" : "") + Math.abs(Math.round(x));
const side = (d) => (Math.round(d) === 0 ? "Up the middle" : Math.abs(Math.round(d)) + "° " + (d < 0 ? "left" : "right"));
const commas = (x) => Math.round(x).toLocaleString("en-US");

// MLB lines: league-wide Statcast figures from games against live pitching. A pitch
// adds its own speed to the ball, so tee numbers always run lower.
const METRICS = [
  { k: "evMax", title: "Peak Exit Velocity", unit: " mph", dp: 1, dir: 1, spark: false, desc: "The hardest ball of the round.",
    mlb: "Statcast counts 95 mph or more as hard hit. That is against a pitch, which adds its own speed to the ball. Off a tee the bat does all the work." },
  { k: "ev", title: "Average Exit Velocity", unit: " mph", dp: 1, dir: 1, desc: "Speed of the ball off the bat, averaged over the round.",
    mlb: "MLB hitters average about 89 mph in games. Tee numbers run lower because the ball starts at rest." },
  { k: "la", title: "Launch Angle", unit: "°", dp: 0, dir: 0, signed: true, tag: "BALL FLIGHT", desc: "Up or down angle of the ball off the bat. Positive is in the air, negative is into the ground.",
    mlb: "The MLB average is about 12°. Statcast calls 8° to 32° the sweet spot." },
  { k: "dist", title: "Distance", unit: " ft", dp: 0, dir: 1, desc: "How far Rapsodo projects the ball to carry, averaged over the round." },
  { k: "spin", title: "Spin Rate", unit: " rpm", dp: 0, dir: 0, tag: "BALL FLIGHT", desc: "Spin on the ball off the bat, averaged over the round." },
];

function summarize(balls) {
  const col = (k) => balls.map((b) => b[k]);
  const ev = col("ev");
  return { evMax: Math.max(...ev), ev: mean(ev), la: mean(col("la")), dist: mean(col("dist")), spin: mean(col("spin")), dir: mean(col("dir")), sdEv: ev.length > 1 ? sd(ev) : 0 };
}
// A hitter's default view, and his row in every group comparison, is his latest round.
const HITTERS = RAP.hitters.map((h) => {
  const sessions = h.sessions.map((s) => ({ ...s, key: s.date + "#" + s.round, swings: s.balls, sum: summarize(s.balls) }));
  return { name: h.name, sessions, ...sessions[sessions.length - 1] };
});
const poolWith = (t) => HITTERS.map((x) => (x.name === t.name ? t : x));
export const hasRapsodoHitter = (n) => HITTERS.some((h) => h.name === n);
export const RAPSODO_DEFAULT = hasRapsodoHitter("Yalexis Mena") ? "Yalexis Mena" : HITTERS[0].name;

// Softer balls sit back in slate, harder ones come forward in green.
const LOW = [96, 106, 122], HIGH = [79, 255, 176];
const ramp = (f) => "rgb(" + LOW.map((c, i) => Math.round(c + (HIGH[i] - c) * clamp(f, 0, 1))).join(",") + ")";

// Drag-free arc from the tee to the ground: leaves at the launch angle, lands at the projected distance.
function arc(b) {
  const tan = Math.tan(rad(b.la)), R = Math.max(b.dist, 1);
  const k = Math.max(0, (TEE_FT + R * tan) / (R * R));
  const end = k === 0 && tan < 0 ? Math.min(R, TEE_FT / -tan) : R;
  const out = [];
  for (let i = 0; i <= 28; i++) { const x = (end * i) / 28; out.push([x, Math.max(0, TEE_FT + x * tan - k * x * x)]); }
  return out;
}

const scene = { display: "block", background: SCENE_BG, border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, userSelect: "none" };
const halo = { stroke: SCENE_BG, strokeWidth: 4, strokeLinejoin: "round", paintOrder: "stroke" };

// Side view at one scale both ways, so a 20° ball is drawn at 20°.
function FlightSide({ balls, cur, color, reach, onPick }) {
  const [ref, { w }] = useMeasure();
  const padL = 16, padR = 16, top = 18, base = 26;
  const s = w ? (w - padL - padR) / reach : 0;
  const arcs = useMemo(() => balls.map((b) => ({ b, path: arc(b) })), [balls]);
  const tallest = Math.max(12, ...arcs.map((a) => Math.max(...a.path.map((p) => p[1]))));
  const h = Math.max(104, Math.round(top + tallest * s + base));
  const X = (ft) => padL + ft * s, Y = (ft) => h - base - ft * s;
  const line = (path) => path.map((p) => X(p[0]).toFixed(1) + "," + Y(p[1]).toFixed(1)).join(" ");
  const ordered = [...arcs].sort((a, b) => (a.b === cur) - (b.b === cur) || a.b.ev - b.b.ev);
  const land = cur ? arcs.find((a) => a.b === cur).path.slice(-1)[0][0] : 0;
  return (
    <div ref={ref}>
      {w > 0 && (
        <svg width={w} height={h} style={scene} role="img" aria-label={`Side view of ${balls.length} batted balls. Selected: ball ${cur.n}, ${cur.ev.toFixed(1)} miles per hour at ${signed(cur.la)} degrees, ${Math.round(cur.dist)} feet.`}>
          {[...Array(Math.floor(reach / 50))].map((_, i) => { const ft = (i + 1) * 50; return (
            <g key={ft}>
              <line x1={X(ft)} x2={X(ft)} y1={top - 6} y2={Y(0)} stroke="rgba(255,255,255,0.05)" />
              <text x={X(ft)} y={h - 8} textAnchor={ft === reach ? "end" : "middle"} fontSize="10" fill={T.dim} style={{ fontVariantNumeric: "tabular-nums" }}>{ft} ft</text>
            </g>
          ); })}
          <line x1={X(0) - 8} x2={w - padR + 8} y1={Y(0)} y2={Y(0)} stroke="rgba(255,255,255,0.22)" />
          <line x1={X(0)} x2={X(0)} y1={Y(0)} y2={Y(TEE_FT)} stroke={T.muted} strokeWidth="2" />
          <text x={X(0) - 4} y={h - 8} fontSize="10" fill={T.dim}>Tee</text>
          {ordered.map(({ b, path }) => {
            const on = b === cur, end = path[path.length - 1];
            return (
              <g key={b.n} style={{ cursor: "pointer" }} onClick={() => onPick(b.n)}>
                <polyline points={line(path)} fill="none" stroke="transparent" strokeWidth="14" />
                <polyline points={line(path)} fill="none" stroke={on ? T.white : color(b)} strokeWidth={on ? 2.6 : 1.6} strokeLinecap="round" strokeLinejoin="round" opacity={on ? 1 : 0.8} />
                <circle cx={X(end[0])} cy={Y(0)} r={on ? 5 : 3.2} fill={on ? T.white : color(b)} stroke={SCENE_BG} strokeWidth="1.5" />
              </g>
            );
          })}
          <text x={clamp(X(land), 40, w - 40)} y={Y(0) - 10} textAnchor="middle" fontSize="11" fontWeight="700" fill={T.white} {...halo} style={{ fontVariantNumeric: "tabular-nums" }}>{Math.round(cur.dist)} ft</text>
        </svg>
      )}
    </div>
  );
}

// Top view: where each ball was headed and how far. Home plate at the bottom, rings every 50 ft.
function SprayFan({ balls, cur, color, reach, onPick }) {
  const [ref, { w }] = useMeasure();
  const R = clamp((w - 104) / Math.SQRT2, 110, 300), top = 30;
  const h = Math.round(top + R + 28), hx = w / 2, hy = top + R;
  const P = (deg, ft) => [hx + (ft / reach) * R * Math.sin(rad(deg)), hy - (ft / reach) * R * Math.cos(rad(deg))];
  const ring = (ft) => { const a = P(-45, ft), b = P(45, ft), r = (ft / reach) * R; return `M${a[0].toFixed(1)} ${a[1].toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${b[0].toFixed(1)} ${b[1].toFixed(1)}`; };
  const rings = [...Array(Math.floor(reach / 50))].map((_, i) => (i + 1) * 50);
  const ordered = [...balls].sort((a, b) => (a === cur) - (b === cur) || a.ev - b.ev);
  const edge = (deg) => P(deg, reach);
  return (
    <div ref={ref}>
      {w > 0 && (
        <svg width={w} height={h} style={scene} role="img" aria-label={`Top view of ${balls.length} batted balls. Selected: ball ${cur.n}, ${side(cur.dir)}, ${Math.round(cur.dist)} feet.`}>
          {[-45, 45].map((d) => <line key={d} x1={hx} y1={hy} x2={edge(d)[0]} y2={edge(d)[1]} stroke="rgba(255,255,255,0.22)" />)}
          {[-MIDDLE, MIDDLE].map((d) => <line key={d} x1={hx} y1={hy} x2={edge(d)[0]} y2={edge(d)[1]} stroke="rgba(255,255,255,0.08)" strokeDasharray="3 5" />)}
          {rings.map((ft) => (
            <g key={ft}>
              <path d={ring(ft)} fill="none" stroke={ft === reach ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.07)"} />
              <text x={P(-45, ft)[0] - 7} y={P(-45, ft)[1] + 3} textAnchor="end" fontSize="10" fill={T.dim} style={{ fontVariantNumeric: "tabular-nums" }}>{ft} ft</text>
            </g>
          ))}
          {[[-30, "Left"], [0, "Middle"], [30, "Right"]].map(([d, text]) => { const p = P(d, reach); return <text key={text} x={p[0]} y={p[1] - 9} textAnchor="middle" fontSize="10" fontWeight="600" fill={T.dim} style={{ textTransform: "uppercase", letterSpacing: 0.7 }}>{text}</text>; })}
          <path d={`M${hx - 5} ${hy + 3}L${hx - 5} ${hy + 8}L${hx} ${hy + 13}L${hx + 5} ${hy + 8}L${hx + 5} ${hy + 3}Z`} fill={T.muted} />
          {ordered.map((b) => {
            const on = b === cur, p = P(clamp(b.dir, -60, 60), b.dist);
            return (
              <g key={b.n} style={{ cursor: "pointer" }} onClick={() => onPick(b.n)}>
                <circle cx={p[0]} cy={p[1]} r="12" fill="transparent" />
                {on && <line x1={hx} y1={hy} x2={p[0]} y2={p[1]} stroke="rgba(255,255,255,0.45)" strokeWidth="1.5" />}
                <circle cx={p[0]} cy={p[1]} r={on ? 6.5 : 5} fill={on ? T.white : color(b)} stroke={SCENE_BG} strokeWidth="1.5" />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

const Fact = ({ label, value }) => (
  <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "9px 11px", minWidth: 0 }}>
    <div style={eyebrow}>{label}</div>
    <div style={{ fontSize: 16, fontWeight: 700, color: T.white, marginTop: 3, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{value}</div>
  </div>
);

// Every ball of the round, from the side and from above. One ball is always selected, the hardest to start.
function BattedBalls({ t, sel, onPick }) {
  const balls = t.balls;
  const evs = balls.map((b) => b.ev), lo = Math.min(...evs), hi = Math.max(...evs);
  const color = (b) => ramp(hi > lo ? (b.ev - lo) / (hi - lo) : 1);
  const hardest = balls.reduce((a, b) => (b.ev > a.ev ? b : a));
  const cur = balls.find((b) => b.n === sel) || hardest;
  const reach = Math.max(150, Math.ceil(Math.max(...balls.map((b) => b.dist)) / 50) * 50);
  const zones = [["Left", balls.filter((b) => b.dir < -MIDDLE).length], ["Middle", balls.filter((b) => Math.abs(b.dir) <= MIDDLE).length], ["Right", balls.filter((b) => b.dir > MIDDLE).length]];
  return (
    <AnalysisCard title="Batted Balls" subtitle="Every ball of the round, from the side and from above. Tap a ball to read it."
      lead={() => (
        <div>
          <div style={eyebrow}>Ball {cur.n} of {balls.length}{cur === hardest ? " · hardest of the round" : ""}</div>
          <div style={{ fontSize: 46, fontWeight: 800, color: T.white, lineHeight: 1, marginTop: 8, letterSpacing: -0.5, fontVariantNumeric: "tabular-nums" }}>
            {cur.ev.toFixed(1)}<span style={{ fontSize: 16, fontWeight: 500, color: T.muted, letterSpacing: 0 }}> mph</span>
          </div>
          <div style={{ fontSize: 12, color: T.muted, marginTop: 5 }}>exit velocity</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 14 }}>
            <Fact label="Launch angle" value={signed(cur.la) + "°"} />
            <Fact label="Direction" value={side(cur.dir)} />
            <Fact label="Distance" value={Math.round(cur.dist) + " ft"} />
            <Fact label="Spin" value={commas(cur.spin) + " rpm"} />
          </div>
        </div>
      )}
      diagram={() => (
        <div>
          <div style={{ ...eyebrow, marginBottom: 6 }}>Side view</div>
          <FlightSide balls={balls} cur={cur} color={color} reach={reach} onPick={onPick} />
          <div style={{ ...eyebrow, margin: "14px 0 6px" }}>Top view</div>
          <SprayFan balls={balls} cur={cur} color={color} reach={reach} onPick={onPick} />
          <div style={{ fontSize: 11, color: T.dim, lineHeight: 1.5, marginTop: 10 }}>Rapsodo measures the ball off the bat. The arcs are drawn from each ball's launch angle and projected distance. Indoors the ball hits the net first.</div>
        </div>
      )}
      aux={() => (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={eyebrow}>Ball by ball</span>
            <span style={{ fontSize: 10, color: T.dim, fontVariantNumeric: "tabular-nums" }}>{lo.toFixed(1)} to {hi.toFixed(1)} mph</span>
          </div>
          <div role="group" aria-label="Pick a ball" style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 68 }}>
            {balls.map((b) => {
              const on = b === cur, f = hi > lo ? (b.ev - lo) / (hi - lo) : 1;
              return <button key={b.n} type="button" aria-pressed={on} aria-label={`Ball ${b.n}: ${b.ev.toFixed(1)} miles per hour`} title={`Ball ${b.n}: ${b.ev.toFixed(1)} mph`} onClick={() => onPick(b.n)}
                style={{ flex: 1, minWidth: 0, height: `${30 + 70 * f}%`, padding: 0, border: "none", borderRadius: 3, cursor: "pointer", background: on ? T.white : color(b), outlineOffset: 2 }} />;
            })}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: T.faint, marginTop: 5 }}><span>First ball</span><span>Last ball</span></div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <span style={{ fontSize: 10, color: T.dim }}>Softer</span>
            <div style={{ flex: 1, maxWidth: 120, height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${ramp(0)}, ${ramp(1)})` }} />
            <span style={{ fontSize: 10, color: T.dim }}>Harder</span>
          </div>
          <div style={{ borderTop: "1px solid rgba(255,255,255,0.05)", marginTop: 16, paddingTop: 14 }}>
            <div style={{ ...eyebrow, marginBottom: 8 }}>Side of the field</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
              {zones.map(([name, n]) => (
                <div key={name} style={{ textAlign: "center", background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "9px 4px" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: n ? T.white : T.faint, fontVariantNumeric: "tabular-nums" }}>{n}</div>
                  <div style={{ fontSize: 10, color: T.dim, marginTop: 1 }}>{name}</div>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: T.dim, lineHeight: 1.5, marginTop: 8 }}>Middle is within {MIDDLE}° of center. Average direction: {side(t.sum.dir).toLowerCase()}.</div>
          </div>
        </div>
      )}
    />
  );
}

// Does the hard contact come with lift, or only on the ground?
function VeloByAngle({ t, sel, onPick }) {
  const balls = t.balls;
  const [ref, size] = useMeasure();
  const W = Math.min(size.w, 640), H = Math.round(clamp(W * 0.5, 230, 300)), L = 44, B = 36, R = 14, TOP = 26;
  const las = balls.map((b) => b.la), evs = balls.map((b) => b.ev);
  const x0 = Math.min(-10, Math.floor((Math.min(...las) - 4) / 5) * 5), x1 = Math.max(40, Math.ceil((Math.max(...las) + 4) / 5) * 5);
  const y0 = Math.floor(Math.min(...evs) - 2), y1 = y0 + Math.ceil((Math.max(...evs) + 2 - y0) / 4) * 4;
  const X = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R), Y = (v) => H - B - ((v - y0) / (y1 - y0)) * (H - B - TOP);
  const sweet = balls.filter((b) => b.la >= SWEET[0] && b.la <= SWEET[1]);
  const top3 = [...balls].sort((a, b) => b.ev - a.ev).slice(0, 3);
  const hardest = top3[0], cur = balls.find((b) => b.n === sel) || hardest;
  const xt = []; for (let v = Math.ceil(x0 / 10) * 10; v <= x1; v += 10) xt.push(v);
  return (
    <Card>
      <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>Exit Velocity by Launch Angle</div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 10, lineHeight: 1.45 }}>Each dot is one ball. Up is harder. Right is higher off the bat.</div>
      <div ref={ref}>{W > 0 && (
      <svg width={W} height={H} style={{ display: "block", margin: "0 auto" }} role="img" aria-label={`Exit velocity against launch angle for ${balls.length} balls. ${sweet.length} were in the sweet spot.`}>
        <rect x={X(SWEET[0])} y={TOP - 8} width={X(SWEET[1]) - X(SWEET[0])} height={H - B - TOP + 8} fill="rgba(79,255,176,0.05)" />
        <text x={(X(SWEET[0]) + X(SWEET[1])) / 2} y={TOP - 13} textAnchor="middle" fontSize="10" fontWeight="600" fill={T.green} opacity="0.8">Sweet spot {SWEET[0]}° to {SWEET[1]}°</text>
        {[...Array(5)].map((_, i) => { const v = y0 + ((y1 - y0) * i) / 4; return <g key={i}><line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke={T.line} /><text x={L - 6} y={Y(v) + 3} textAnchor="end" fontSize="10" fill={T.faint}>{Math.round(v)}</text></g>; })}
        {xt.map((v) => <text key={v} x={X(v)} y={H - B + 16} textAnchor="middle" fontSize="10" fill={T.faint}>{signed(v)}°</text>)}
        {x0 < 0 && <line x1={X(0)} x2={X(0)} y1={TOP - 8} y2={H - B} stroke="rgba(255,255,255,0.12)" strokeDasharray="3 5" />}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="10" fill={T.dim}>Launch angle</text>
        <text x="10" y={(H - B + TOP) / 2} textAnchor="middle" fontSize="10" fill={T.dim} transform={`rotate(-90 10 ${(H - B + TOP) / 2})`}>Exit velocity (mph)</text>
        {[...balls].sort((a, b) => (a === cur) - (b === cur)).map((b) => {
          const on = b === cur;
          return (
            <g key={b.n} style={{ cursor: "pointer" }} onClick={() => onPick(b.n)}>
              <circle cx={X(b.la)} cy={Y(b.ev)} r="13" fill="transparent" />
              <circle cx={X(b.la)} cy={Y(b.ev)} r={on ? 7.5 : 5.5} fill={on ? T.white : "rgba(255,255,255,0.28)"} stroke={T.bg} strokeWidth="2" />
              {on && <text x={X(b.la) + (X(b.la) > W - 110 ? -12 : 12)} y={Y(b.ev) + 4} textAnchor={X(b.la) > W - 110 ? "end" : "start"} fontSize="11" fontWeight="700" fill={T.white} stroke={T.bg} strokeWidth="4" strokeLinejoin="round" paintOrder="stroke">{b.ev.toFixed(1)} at {signed(b.la)}°</text>}
            </g>
          );
        })}
      </svg>
      )}</div>
      <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.5, marginTop: 10 }}>
        <span style={{ color: T.white, fontWeight: 600 }}>{sweet.length} of {balls.length}</span> balls left the bat in the sweet spot. The three hardest averaged <span style={{ color: T.white, fontWeight: 600 }}>{signed(mean(top3.map((b) => b.la)))}°</span>.
      </div>
    </Card>
  );
}

const BOARD_ROW = { display: "grid", gridTemplateColumns: "22px minmax(92px, 1fr) minmax(0, 2.6fr) 84px", alignItems: "center", columnGap: 8 };

// Everyone measured so far: a hollow dot for the round's average, a solid one for the peak.
function Board({ t, onOpen }) {
  const [by, setBy] = useState("evMax");
  const rows = poolWith(t).sort((a, b) => b.sum[by] - a.sum[by]);
  const lo = Math.floor(Math.min(...rows.map((r) => r.sum.ev)) - 2), hi = Math.ceil(Math.max(...rows.map((r) => r.sum.evMax)) + 1);
  const pos = (v) => `${((v - lo) / (hi - lo)) * 100}%`;
  const sortBtn = (k, text) => (
    <button type="button" aria-pressed={by === k} onClick={() => setBy(k)} style={{ fontSize: 11, fontWeight: 600, padding: "6px 10px", borderRadius: 8, cursor: "pointer", fontFamily: FONT,
      border: "1px solid " + (by === k ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: by === k ? "rgba(79,255,176,0.1)" : "transparent", color: by === k ? T.green : T.muted }}>{text}</button>
  );
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Exit Velocity Board</div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}><span style={eyebrow}>Rank by</span>{sortBtn("evMax", "Peak")}{sortBtn("ev", "Average")}</div>
      </div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>Hollow dot is the round's average, solid dot is the hardest ball. Tap a row to open that hitter.</div>
      <div>
        {rows.map((r, i) => {
          const me = r.name === t.name, c = me ? T.green : "rgba(255,255,255,0.5)";
          return (
            <button key={r.name} type="button" onClick={() => onOpen(r.name)} aria-label={`${r.name}: average ${r.sum.ev.toFixed(1)}, peak ${r.sum.evMax.toFixed(1)} miles per hour`}
              style={{ ...BOARD_ROW, width: "100%", minHeight: 34, padding: "0 6px", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: FONT, textAlign: "left",
                background: me ? "rgba(79,255,176,0.07)" : "transparent" }}>
              <span style={{ fontSize: 11, color: T.faint, fontVariantNumeric: "tabular-nums" }}>{i + 1}</span>
              <span style={{ fontSize: 12, fontWeight: me ? 700 : 500, color: me ? T.white : T.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>
              <span style={{ position: "relative", height: 14, margin: "0 7px" }}>
                <span style={{ position: "absolute", left: 0, right: 0, top: 6.5, height: 1, background: "rgba(255,255,255,0.05)" }} />
                <span style={{ position: "absolute", left: pos(r.sum.ev), width: `calc(${pos(r.sum.evMax)} - ${pos(r.sum.ev)})`, top: 6, height: 2, background: c, opacity: 0.55 }} />
                <span style={{ position: "absolute", left: pos(r.sum.ev), top: 2, width: 10, height: 10, borderRadius: "50%", boxSizing: "border-box", border: "2px solid " + c, background: T.bg, transform: "translateX(-50%)" }} />
                <span style={{ position: "absolute", left: pos(r.sum.evMax), top: 2, width: 10, height: 10, borderRadius: "50%", background: c, transform: "translateX(-50%)" }} />
              </span>
              <span style={{ fontSize: 11, color: me ? T.white : T.muted, textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{r.sum.ev.toFixed(1)} / <span style={{ fontWeight: 700 }}>{r.sum.evMax.toFixed(1)}</span></span>
            </button>
          );
        })}
      </div>
      <div style={{ ...BOARD_ROW, padding: "0 6px", marginTop: 4 }}>
        <span /><span />
        <span style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint, margin: "0 7px" }}><span>{lo} mph</span><span>{hi} mph</span></span>
        <span />
      </div>
    </Card>
  );
}

export function RapsodoTab({ name, setName }) {
  const [key, setKey] = useState(null); // null = latest round
  const [picked, setPicked] = useState(null); // { id, n }; anything else means the hardest ball
  const base = HITTERS.find((x) => x.name === name) || HITTERS[0];
  const session = base.sessions.find((s) => s.key === key) || base.sessions[base.sessions.length - 1];
  const t = useMemo(() => ({ name: base.name, ...session }), [base, session]);
  const id = t.name + "|" + t.key;
  const sel = picked && picked.id === id ? picked.n : null;
  const onPick = (n) => setPicked({ id, n });
  const open = (n) => { setName(n); setKey(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const idx = base.sessions.indexOf(session), prev = base.sessions[idx - 1];
  const delta = prev ? t.sum.evMax - prev.sum.evMax : null;
  const sameDay = base.sessions.some((s, i) => base.sessions.findIndex((x) => x.date === s.date) !== i);
  const roundName = (s) => shortDate(s.date) + (sameDay ? ", round " + s.round : "");
  const d = new Date(t.date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <>
      <select value={base.name} aria-label="Hitter" onChange={(e) => { setName(e.target.value); setKey(null); }}
        style={{ width: "100%", padding: "12px 14px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: T.white, fontSize: 14, fontFamily: FONT, marginBottom: 16, outline: "none" }}>
        {HITTERS.map((x) => <option key={x.name} value={x.name} style={{ background: "#14161B" }}>{x.name}</option>)}
      </select>

      <Card pad="20px 18px">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.white, lineHeight: 1.15 }}>{t.name}</div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 4 }}>{d}{sameDay ? ", round " + t.round : ""} {"·"} Rapsodo {"·"} {t.balls.length} balls</div>
          </div>
          <div style={{ fontSize: 9, fontWeight: 700, color: T.blue, background: T.blue + "15", padding: "3px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>{t.type.toUpperCase()}</div>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          {[["Peak exit velo", t.sum.evMax.toFixed(1), "mph, hardest ball"], ["Average exit velo", t.sum.ev.toFixed(1), "mph, all balls"], ["Consistency", "±" + t.sum.sdEv.toFixed(1), "mph ball to ball"]].map(([l, v, s]) => (
            <div key={l} style={{ flex: 1, minWidth: 0, background: "rgba(255,255,255,0.03)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6 }}>{l}</div>
              <div style={{ fontSize: 20, fontWeight: 700, color: T.white, fontVariantNumeric: "tabular-nums" }}>{v}</div>
              <div style={{ fontSize: 10, color: T.faint }}>{s}</div>
            </div>
          ))}
        </div>
        {base.sessions.length > 1 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 12 }}>
            <span style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.6, marginRight: 2 }}>Round</span>
            {base.sessions.map((s) => { const on = s === session; return (
              <button key={s.key} type="button" aria-pressed={on} onClick={() => setKey(s.key)} style={{ fontSize: 11, fontWeight: 600, padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontFamily: FONT,
                border: "1px solid " + (on ? "rgba(79,255,176,0.35)" : "rgba(255,255,255,0.1)"), background: on ? "rgba(79,255,176,0.1)" : "transparent", color: on ? T.green : T.muted }}>{roundName(s)}</button>
            ); })}
            {delta != null && <span style={{ fontSize: 11, color: T.muted, marginLeft: 4 }}>{delta >= 0 ? "+" : "−"}{Math.abs(delta).toFixed(1)} mph peak vs {roundName(prev)}</span>}
          </div>
        )}
      </Card>

      <BattedBalls t={t} sel={sel} onPick={onPick} />
      <VeloByAngle t={t} sel={sel} onPick={onPick} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", columnGap: 12, alignItems: "start" }}>
        {METRICS.map((m) => <MetricCard key={m.k} m={m} t={t} pool={poolWith(t)} perLabel="Ball by ball" />)}
      </div>
      <Board t={t} onOpen={open} />

      <div style={{ fontSize: 10, color: T.faint, lineHeight: 1.6, marginTop: 8 }}>
        Rapsodo hitting unit at RPM, off a tee, rounds from Nov 10, 2026 on. The bat was not recorded and misreads are left out.
        Rankings are among the {HITTERS.length} hitters measured so far, of all ages, each on their latest round. Flight arcs are drawn from launch angle and
        Rapsodo's projected distance with no air drag, so read them as a picture of the round, not a measurement. MLB lines are league-wide Statcast figures from
        games against live pitching. Blast Motion and Rapsodo have not been run on the same swings yet, so the two tabs stand alone for now.
      </div>
    </>
  );
}
