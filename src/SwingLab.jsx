// ─── Swing Lab (staff preview, unlinked) ─────────────────────────────────────
// rpmstrength.coach/swinglab (rewrite in vercel.json). Nothing links here yet:
// it's where the bat speed model's hitter-facing visuals get built before they
// go on athlete pages (Frank, 11/13/26).
// First visual: a fastball travels from release to contact. The path is split at
// the moment the hitter has to start his swing, using his Blast time to contact
// (avg of counted swings off the tee, facility Baum 33/30).
// Generic pitch: 6 ft of extension (54.5 ft of flight) and ~9% speed loss from
// release to plate, the same release-to-plate factor the exit velo card uses.
import { useEffect, useMemo, useRef, useState } from "react";

// Avg Blast time to contact (s) over counted swings, first session per hitter.
// Source: Bat Speed Model/blast_swings_manual.csv. Hand-copied until the swing
// store gets its own sync.
const HITTERS = [
  { name: "Antonio Porcelli", ttc: 0.138, date: "11/11" },
  { name: "Braden Eddy", ttc: 0.171, date: "11/11" },
  { name: "Charlie Troia", ttc: 0.166, date: "10/29" },
  { name: "Jackson Cintron", ttc: 0.146, date: "10/31" },
  { name: "Leland Daniels-Weeks", ttc: 0.189, date: "10/31" },
  { name: "Luke Desjardins", ttc: 0.200, date: "10/31" },
  { name: "Miles Bohn", ttc: 0.188, date: "11/11" },
  { name: "MJ Ramirez", ttc: 0.189, date: "11/11" },
  { name: "Nate Shin", ttc: 0.176, date: "10/31" },
  { name: "Robert Ehrlich", ttc: 0.166, date: "11/11" },
  { name: "Sammy Bolotin", ttc: 0.178, date: "10/31" },
  { name: "Yalexis Mena", ttc: 0.156, date: "10/30" },
];
const AVG_TTC = HITTERS.reduce((a, h) => a + h.ttc, 0) / HITTERS.length;

const FLIGHT_FT = 54.5; // 60.5 ft minus 6 ft generic extension
const PLATE_FACTOR = 0.91; // plate speed / release speed
const MPH_TO_FTS = 1.46667;

const C = { navy: "#1B2A44", orange: "#DD5228", blue: "#2A78D6", gray: "#5B6470", lgray: "#98A0AA", line: "#E3E6EA", bg: "#F5F6F8" };

// Constant deceleration from release speed to plate speed over the flight.
function pitch(mph) {
  const v0 = mph * MPH_TO_FTS, vf = PLATE_FACTOR * v0;
  const a = (vf * vf - v0 * v0) / (2 * FLIGHT_FT);
  const T = (2 * FLIGHT_FT) / (v0 + vf);
  return { T, dist: (t) => Math.min(FLIGHT_FT, v0 * t + 0.5 * a * t * t) };
}
// Release speed at which a hitter with the group-average swing gets this much time to decide.
const feelsLike = (decide) => FLIGHT_FT / (((1 + PLATE_FACTOR) / 2) * MPH_TO_FTS * (decide + AVG_TTC));
const ms = (t) => Math.round(t * 1000) + " ms";

// Scene geometry (SVG units).
const REL = [92, 128], END = [588, 140], HANDS = [628, 139];
const at = (f) => [REL[0] + (END[0] - REL[0]) * f, REL[1] + (END[1] - REL[1]) * f];
const BAT_START = -70, BAT_SWEEP = 110;

function Stat({ label, value, sub }) {
  return (
    <div style={{ background: C.bg, borderRadius: 8, padding: "10px 14px", flex: "1 1 140px" }}>
      <div style={{ fontSize: 12, color: C.gray }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: C.navy, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.lgray }}>{sub}</div>}
    </div>
  );
}

function PitchScene({ hitter, mph }) {
  const P = useMemo(() => pitch(mph), [mph]);
  const tStart = P.T - hitter.ttc;
  const fStart = P.dist(tStart) / FLIGHT_FT;
  const [cx, cy] = at(fStart);
  const ftOut = Math.round(FLIGHT_FT - P.dist(tStart));

  const [t, setT] = useState(0);
  const [speed, setSpeed] = useState(0.2);
  const raf = useRef(null);
  useEffect(() => { cancelAnimationFrame(raf.current); setT(0); }, [hitter, mph]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const play = (s = speed) => {
    cancelAnimationFrame(raf.current);
    let t0 = null;
    const step = (now) => {
      if (t0 == null) t0 = now;
      const tt = ((now - t0) / 1000) * s;
      setT(tt);
      if (tt < P.T + 0.9 * s) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };

  const [bx, by] = at(P.dist(Math.max(0, t)) / FLIGHT_FT);
  const p = t > tStart ? Math.min(1, (t - tStart) / hitter.ttc) : 0;
  const bat = BAT_START - BAT_SWEEP * p * p; // speeds up through the turn
  const status = t <= 0 ? "Press pitch" : t < tStart ? "Seeing and deciding" : t < P.T ? "Swinging" : "Contact";

  const btn = (on) => ({ fontSize: 12, padding: "5px 10px", borderRadius: 6, cursor: "pointer", border: "1px solid " + (on ? C.navy : C.line), background: on ? C.navy : "#fff", color: on ? "#fff" : C.navy });

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <button onClick={() => play()} style={{ ...btn(false), fontWeight: 700, padding: "6px 14px", border: "1px solid " + C.orange, color: C.orange }}>Pitch</button>
        {[[1, "Real time"], [0.2, "5x slower"], [0.07, "15x slower"]].map(([s, l]) => (
          <button key={s} style={btn(speed === s)} onClick={() => { setSpeed(s); play(s); }}>{l}</button>
        ))}
      </div>
      <svg viewBox="0 0 680 250" width="100%" role="img" aria-label="Fastball path from pitcher to hitter, split where the hitter must start his swing" style={{ color: C.gray, display: "block" }}>
        <path d="M20 205 Q70 188 120 205 L660 205" fill="none" stroke="currentColor" strokeWidth="1" opacity=".5" />
        <rect x="600" y="203" width="22" height="4" fill="currentColor" opacity=".6" />
        <text x="611" y="222" textAnchor="middle" fontSize="11" fill="currentColor">plate</text>
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
          <circle cx="70" cy="122" r="8" strokeWidth="2.5" />
          <line x1="70" y1="130" x2="73" y2="165" /><line x1="73" y1="165" x2="58" y2="196" /><line x1="73" y1="165" x2="92" y2="192" />
          <line x1="71" y1="138" x2="92" y2="129" /><line x1="71" y1="138" x2="55" y2="150" />
        </g>
        <line x1={REL[0]} y1={REL[1]} x2={cx} y2={cy} stroke={C.blue} strokeWidth="4" strokeLinecap="round" />
        <line x1={cx} y1={cy} x2={END[0]} y2={END[1]} stroke={C.orange} strokeWidth="4" strokeLinecap="round" />
        <line x1={cx} y1="112" x2={cx} y2="152" stroke={C.orange} strokeWidth="1.5" strokeDasharray="3 3" />
        <text x={Math.max(60, Math.min(560, cx))} y="104" textAnchor="middle" fontSize="11" fill={C.navy}>must start: {ftOut} ft out</text>
        <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" fill="none">
          <circle cx="641" cy="116" r="8" strokeWidth="2.5" />
          <line x1="641" y1="124" x2="637" y2="164" /><line x1="637" y1="164" x2="620" y2="200" /><line x1="637" y1="164" x2="654" y2="200" />
          <line x1="639" y1="132" x2="628" y2="139" />
        </g>
        <g transform={`rotate(${bat} ${HANDS[0]} ${HANDS[1]})`}>
          <line x1={HANDS[0]} y1={HANDS[1]} x2={HANDS[0] + 56} y2={HANDS[1]} stroke={C.navy} strokeWidth="5" strokeLinecap="round" />
        </g>
        <circle cx={bx} cy={by} r="5" fill="#fff" stroke={C.navy} strokeWidth="1.5" />
        <text x="340" y="40" textAnchor="middle" fontSize="15" fontWeight="700" fill={C.navy}>{status}</text>
        <text x="340" y="60" textAnchor="middle" fontSize="12" fill={C.lgray}>{t > 0 ? ms(Math.min(t, P.T)) + " after release" : ""}</text>
      </svg>
      <div style={{ display: "flex", gap: 16, fontSize: 12, color: C.gray, margin: "2px 0 12px", flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 14, height: 4, background: C.blue, verticalAlign: "middle", marginRight: 6 }} />See and decide</span>
        <span><span style={{ display: "inline-block", width: 14, height: 4, background: C.orange, verticalAlign: "middle", marginRight: 6 }} />Swing (Blast time to contact)</span>
      </div>
    </div>
  );
}

export function SwingLabPage({ logo }) {
  const [name, setName] = useState("Luke Desjardins");
  const [mph, setMph] = useState(90);
  const hitter = HITTERS.find((h) => h.name === name);
  const P = pitch(mph);
  const decide = P.T - hitter.ttc;

  return (
    <div style={{ minHeight: "100vh", background: "#fff", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", color: C.navy }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 48px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          {logo && <img src={logo} alt="RPM" style={{ width: 40, height: 40 }} />}
          <div>
            <div style={{ fontSize: 20, fontWeight: 800 }}>Swing Lab</div>
            <div style={{ fontSize: 12, color: C.lgray }}>Staff preview. Not linked anywhere yet.</div>
          </div>
        </div>
        <div style={{ borderBottom: "3px solid " + C.navy, margin: "10px 0 16px" }} />

        <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 2 }}>Time to decide</div>
        <div style={{ fontSize: 13, color: C.gray, marginBottom: 12 }}>How much of the pitch you get to see before you have to start your swing.</div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
          <select value={name} onChange={(e) => setName(e.target.value)} style={{ fontSize: 14, padding: "6px 8px", borderRadius: 6, border: "1px solid " + C.line, color: C.navy, minWidth: 200 }}>
            {HITTERS.map((h) => <option key={h.name}>{h.name}</option>)}
          </select>
          <span style={{ fontSize: 13, color: C.gray }}>Fastball</span>
          <input type="range" min="60" max="100" step="1" value={mph} onChange={(e) => setMph(+e.target.value)} style={{ flex: 1, minWidth: 160, accentColor: C.orange }} />
          <span style={{ fontSize: 16, fontWeight: 800, minWidth: 64 }}>{mph} mph</span>
        </div>

        <PitchScene hitter={hitter} mph={mph} />

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Stat label="Pitch flight" value={ms(P.T)} sub="release to plate" />
          <Stat label="Time to contact" value={ms(hitter.ttc)} sub={"Blast, " + hitter.date} />
          <Stat label="Time to decide" value={ms(decide)} sub="before the swing starts" />
          <Stat label="Feels like" value={Math.round(feelsLike(decide)) + " mph"} sub="for an average-speed swing" />
        </div>

        <div style={{ fontSize: 11, color: C.lgray, marginTop: 18, lineHeight: 1.5 }}>
          Generic pitch: 6 ft of extension and about 9% speed loss from release to plate. Time to contact is the average of counted Blast swings off a tee,
          measured from the start of the downswing, so real decision time is a little shorter. "Feels like" uses the group's average time to contact ({ms(AVG_TTC)}).
          One session per hitter; time to contact has not passed the reliability check yet.
        </div>
      </div>
    </div>
  );
}
