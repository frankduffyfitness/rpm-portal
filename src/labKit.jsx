// ─── Swing Lab kit ───────────────────────────────────────────────────────────
// Tokens and small shared pieces for the Swing Lab tabs (SwingLab.jsx = Blast Motion,
// RapsodoLab.jsx = Rapsodo). Split out 11/18/26 so both tabs keep one look.
import { useEffect, useState } from "react";

export const T = { bg: "#0A0C10", card: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", line: "rgba(255,255,255,0.06)",
  text: "#E0E0E0", white: "#fff", muted: "#8A8F98", dim: "#6B7280", faint: "#4a4f57",
  green: "#4FFFB0", blue: "#60A5FA", amber: "#FFB020", orange: "#FF8C42", red: "#FF4D4D", purple: "#A78BFA" };
export const FONT = "'DM Sans','Helvetica Neue',sans-serif";

export const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
export const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
export const shortDate = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const fmt = (v, dp) => (v == null ? "–" : v.toFixed(dp));
export const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const SCENE_BG = "#0D1015";
export const eyebrow = { fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.7, fontWeight: 600 };

// ─── Shared bits ─────────────────────────────────────────────────────────────
export const Card = ({ children, pad = "18px 16px" }) => <div style={{ background: T.card, border: T.border, borderRadius: 16, padding: pad, marginBottom: 12 }}>{children}</div>;
export const Label = ({ children }) => <div style={{ fontSize: 10, color: T.dim, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>{children}</div>;

export function Spark({ values, color, width = 280, height = 40 }) {
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

export function MetricCard({ m, t, pool: everyone, perLabel = "Swing by swing", missing = "Not captured in this session." }) {
  const val = t.sum[m.k];
  const pool = everyone.filter((x) => x.sum[m.k] != null);
  if (val == null) {
    return (
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 6 }}>{m.title}</div>
        <div style={{ fontSize: 12, color: T.dim }}>{missing}</div>
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
          : <span style={{ fontSize: 9, fontWeight: 700, color: T.muted, background: "rgba(255,255,255,0.05)", padding: "3px 10px", borderRadius: 10 }}>{m.tag || "SWING SHAPE"}</span>}
      </div>
      <div style={{ fontSize: 11, color: T.dim, marginBottom: 12, lineHeight: 1.45 }}>{m.desc}</div>
      <div style={{ fontSize: 34, fontWeight: 700, color: T.white, lineHeight: 1, marginBottom: 16 }}>
        {m.signed && val > 0 ? "+" : ""}{fmt(val, m.dp)}<span style={{ fontSize: 14, fontWeight: 400, color: T.muted }}>{m.unit}</span>
      </div>
      <div style={{ position: "relative", height: 10, background: "rgba(255,255,255,0.04)", borderRadius: 5, marginBottom: 6 }}>
        <div style={{ position: "absolute", left: `${((avg - lo) / (hi - lo || 1)) * 100}%`, top: -3, width: 2, height: 16, background: "rgba(255,255,255,0.25)", transform: "translateX(-50%)" }} />
        <div style={{ position: "absolute", left: `${pos}%`, top: -2, width: 14, height: 14, borderRadius: "50%", background: c, border: "2px solid " + T.bg, transform: "translateX(-50%)", transition: "left 0.8s cubic-bezier(0.16,1,0.3,1)" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: T.faint, marginBottom: 12 }}>
        <span>{fmt(lo, m.dp)}</span><span>group avg {fmt(avg, m.dp)}</span><span>{fmt(hi, m.dp)}</span>
      </div>
      {m.mlb && (
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 12 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: T.blue, background: "rgba(96,165,250,0.1)", border: "1px solid rgba(96,165,250,0.25)", borderRadius: 6, padding: "2px 6px", flexShrink: 0 }}>MLB</span>
          <span style={{ fontSize: 11, color: T.muted, lineHeight: 1.45 }}>{m.mlb}</span>
        </div>
      )}
      {m.spark !== false && (
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.04)", paddingTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <Label>{perLabel}</Label>
            <span style={{ fontSize: 10, color: T.dim }}>{fmt(Math.min(...per.filter((x) => x != null)), m.dp)} to {fmt(Math.max(...per.filter((x) => x != null)), m.dp)}{m.unit.trim() === "s" ? " s" : m.unit}</span>
          </div>
          <Spark values={per} color={c} />
        </div>
      )}
    </Card>
  );
}

// [ref callback, size in px]. A callback ref, so a panel that unmounts and comes back is measured again.
export function useMeasure() {
  const [el, setEl] = useState(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return undefined;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, size, el];
}

export const pillStyle = (on) => ({ fontSize: 12, fontWeight: 600, lineHeight: 1, padding: "9px 12px", minHeight: 34, cursor: "pointer", border: "none", fontFamily: FONT, whiteSpace: "nowrap",
  background: on ? "rgba(79,255,176,0.12)" : "transparent", color: on ? T.green : T.muted });

// Segmented control: one outlined group, the pressed option tinted.
export function Segmented({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 9, overflow: "hidden" }}>
      {options.map(([v, text], i) => (
        <button key={text} type="button" aria-pressed={value === v} onClick={() => onChange(v)} style={{ ...pillStyle(value === v), borderLeft: i ? "1px solid rgba(255,255,255,0.08)" : "none" }}>{text}</button>
      ))}
    </div>
  );
}

// One layout for both graphics: lead (the answer + its main control), diagram, aux. Side by side when the card is wide.
export function AnalysisCard({ title, subtitle, lead, diagram, aux }) {
  const [ref, size] = useMeasure();
  const wide = size.w >= 720;
  return (
    <div ref={ref} style={{ background: T.card, border: T.border, borderRadius: 16, padding: wide ? "22px 24px 24px" : "18px 16px", marginBottom: 12 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.white, letterSpacing: -0.1 }}>{title}</div>
        <div style={{ fontSize: 12, color: T.muted, marginTop: 3, lineHeight: 1.45 }}>{subtitle}</div>
      </div>
      <div style={wide
        ? { display: "grid", gridTemplateColumns: "minmax(0, 1.95fr) minmax(230px, 1fr)", gridTemplateRows: "auto 1fr", gridTemplateAreas: '"diagram lead" "diagram aux"', columnGap: 26, rowGap: 16 }
        : { display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gridTemplateAreas: '"lead" "diagram" "aux"', rowGap: 14 }}>
        <div style={{ gridArea: "lead", minWidth: 0 }}>{lead(wide)}</div>
        <div style={{ gridArea: "diagram", minWidth: 0 }}>{diagram(wide)}</div>
        <div style={{ gridArea: "aux", minWidth: 0 }}>{aux(wide)}</div>
      </div>
    </div>
  );
}
