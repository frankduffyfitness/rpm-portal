// ─── Remote intake questionnaire ────────────────────────────────────────────
// The questionnaire new remote athletes fill out before their 15-20 minute call
// (doc: "RPM Remote Coaching Intake Questionnaire"). Coaches make a private link
// in the Training tab; the athlete (with a parent if under 18) fills it out at
// rpmstrength.coach/intake#t=<key>. Answers save as they go and land in the coach's
// "Intakes" panel with the data tier and review flags worked out.
// Two kinds: "remote" = the full 7-part questionnaire; "eval" = one short page of
// basics for in-person evaluation sign-ups (Frank, 10/10/26).
import { useEffect, useRef, useState } from "react";

async function api(key, { query, body }) {
  const r = await fetch("/api/training" + (query ? "?" + new URLSearchParams(query) : ""), {
    method: body ? "POST" : "GET",
    headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "Request failed"), { status: r.status });
  return data;
}

// ─── The questions ───────────────────────────────────────────────────────────
// type: text | long | date | choice | multi | yesno | scale
// yesno + detail: a "yes" opens a follow-up box. showIf: (answers) => bool.
const YES_NO = ["Yes", "No"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const TZ = ["Eastern", "Central", "Mountain", "Pacific", "Alaska", "Hawaii", "Other"];
const guessTz = () => {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/New_York|Detroit|Indiana|Kentucky/.test(z)) return "Eastern";
    if (/Chicago|Winnipeg|Menominee/.test(z)) return "Central";
    if (/Denver|Phoenix|Boise/.test(z)) return "Mountain";
    if (/Los_Angeles|Vancouver/.test(z)) return "Pacific";
    if (/Anchorage/.test(z)) return "Alaska";
    if (/Honolulu/.test(z)) return "Hawaii";
  } catch (e) {}
  return "";
};

export const PARTS = [
  {
    title: "Athlete and contact",
    fields: [
      { key: "name", label: "Athlete full name", type: "text", required: true },
      { key: "dob", label: "Date of birth", type: "date", required: true },
      { key: "gradYear", label: "Graduating class (year)", type: "text", placeholder: "2028" },
      { key: "teams", label: "School and team(s)", type: "long", placeholder: "High school, travel, college, other" },
      { key: "height", label: "Height", type: "text", half: true, placeholder: "5'10\"" },
      { key: "weight", label: "Weight (lb)", type: "text", half: true },
      { key: "athleteEmail", label: "Athlete email", type: "text", half: true },
      { key: "athletePhone", label: "Athlete cell phone", type: "text", half: true },
      { key: "parentName", label: "Parent or guardian name", type: "text", minorRequired: true },
      { key: "parentEmail", label: "Parent or guardian email", type: "text", half: true, minorRequired: true },
      { key: "parentPhone", label: "Parent or guardian cell phone", type: "text", half: true, minorRequired: true },
      { key: "contactPref", label: "Who should get program updates and coach messages?", type: "choice", options: ["Athlete", "Parent", "Both"] },
      { key: "city", label: "City", type: "text", half: true },
      { key: "state", label: "State", type: "text", half: true },
      { key: "zip", label: "ZIP code", type: "text", half: true },
      { key: "timezone", label: "Time zone", type: "choice", options: TZ },
    ],
  },
  {
    title: "Baseball and season",
    fields: [
      { key: "positions", label: "Position(s)", type: "text", placeholder: "RHP / SS" },
      { key: "pitcher", label: "Do you pitch?", type: "choice", options: YES_NO },
      { key: "throws", label: "Throws", type: "choice", options: ["Right", "Left"], half: true },
      { key: "bats", label: "Bats", type: "choice", options: ["Right", "Left", "Switch"], half: true },
      { key: "level", label: "Current level", type: "choice", options: ["Middle school", "High school JV", "High school varsity", "Travel", "College", "Other"] },
      { key: "seasonDates", label: "Season dates for the next 6 months", type: "long", placeholder: "School season, travel or fall ball, showcases, tryouts, other key dates" },
      { key: "inSeason", label: "Are you in season right now?", type: "yesno", detail: "How many innings or pitches per week, and how many days of throwing?" },
      { key: "pitches", label: "What pitches do you throw?", type: "text", showIf: (a) => a.pitcher === "Yes" },
      { key: "veloTop", label: "Top velocity (mph)", type: "text", half: true },
      { key: "veloUsual", label: "Usual velocity (mph)", type: "text", half: true },
      { key: "veloHow", label: "How was it measured?", type: "choice", options: ["Radar gun", "Pocket Radar", "TrackMan", "Rapsodo", "Other", "Not measured"] },
      { key: "veloWhen", label: "When was it measured?", type: "text", showIf: (a) => a.veloHow && a.veloHow !== "Not measured" },
      { key: "throwingWeek", label: "What does your throwing week look like right now?", type: "long", placeholder: "Days throwing, long toss, bullpens, plyo balls, rest days" },
    ],
  },
  {
    title: "Health history",
    note: "A \"yes\" here does not rule you out. It tells us what to plan around and whether we need clearance from your doctor first.",
    fields: [
      { key: "armInjury", label: "Have you ever had an arm injury (shoulder or elbow)?", type: "yesno", detail: "What was it, when did it happen, and did you miss time?" },
      { key: "otherInjuries", label: "Any other injuries in the last 2 years? (back, hip, knee, ankle, hamstring, other)", type: "yesno", detail: "Describe them" },
      { key: "surgeries", label: "Any surgeries?", type: "yesno", detail: "Which, and when?" },
      { key: "currentPain", label: "Do you have pain or discomfort right now, during or after throwing or lifting?", type: "yesno", detail: "Where, and when does it hurt?" },
      { key: "painLevel", label: "How bad is it? (0 = none, 10 = worst)", type: "scale", min: 0, max: 10, showIf: (a) => a.currentPain === "Yes" },
      { key: "provider", label: "Are you currently seeing a doctor, physical therapist, athletic trainer or chiropractor?", type: "yesno", detail: "For what?" },
      { key: "limits", label: "Any activity limits from a doctor or physical therapist right now?", type: "yesno", detail: "What are they?" },
      { key: "conditions", label: "Any medical conditions a coach should know about? (asthma, diabetes, heart conditions, concussion history, other)", type: "yesno", detail: "Describe them" },
      { key: "cardiac", label: "Have you ever fainted, had chest pain, or had trouble breathing during exercise?", type: "yesno", detail: "What happened?" },
      { key: "lastPhysical", label: "When was your last physical exam?", type: "text" },
    ],
  },
  {
    title: "Training history",
    fields: [
      { key: "liftingYears", label: "How long have you been lifting weights?", type: "choice", options: ["Never", "Under 6 months", "6-12 months", "1-2 years", "2+ years"] },
      { key: "programBy", label: "Who writes your program now?", type: "choice", options: ["A coach", "My school", "Myself", "Nobody"] },
      { key: "liftsDone", label: "Which of these have you done with a coach?", type: "multi", options: ["Trap bar deadlift", "Barbell or safety squat bar squat", "Barbell RDL", "Bench press", "Olympic lifts", "Depth jumps"] },
      { key: "plyo", label: "Have you trained with weighted plyo balls before?", type: "yesno", detail: "Which weights?" },
      { key: "daysPerWeek", label: "How many days per week can you train?", type: "choice", options: ["2", "3", "4", "5"] },
      { key: "daysTimes", label: "Which days and times usually work?", type: "text" },
      { key: "sessionLength", label: "How long can a typical session be?", type: "choice", options: ["30 min", "45 min", "60 min", "90 min"] },
      { key: "scheduleNotes", label: "Any school, team or travel commitments that change your schedule week to week?", type: "long" },
    ],
  },
  {
    title: "Data and equipment",
    fields: [
      { key: "throwingData", label: "Which of these can you use at least once a week?", type: "multi", options: ["TrackMan", "Rapsodo", "Pocket Radar", "Radar gun", "Other", "None of these"] },
      { key: "dataWhere", label: "Where is it, and who runs it?", type: "text", placeholder: "Your own, team, school, facility", showIf: (a) => (a.throwingData || []).some((x) => x !== "None of these") },
      { key: "phone", label: "What phone do you have?", type: "text", placeholder: "iPhone 14" },
      { key: "slowmo", label: "Can it record slow motion (240 fps)?", type: "choice", options: ["Yes", "No", "Not sure"], half: true },
      { key: "tripod", label: "Tripod or a way to prop the phone up?", type: "choice", options: YES_NO, half: true },
      { key: "throwingSetup", label: "Throwing setup: check everything you have", type: "multi", options: ["A throwing partner or catcher, most days", "A net", "A mound", "Space for long toss", "Plyo balls", "Resistance bands"] },
      { key: "longTossDist", label: "About how far can you long toss (feet)?", type: "text", showIf: (a) => (a.throwingSetup || []).includes("Space for long toss") },
      { key: "plyoWeights", label: "Which plyo ball weights do you have?", type: "text", showIf: (a) => (a.throwingSetup || []).includes("Plyo balls") },
      { key: "liftWhere", label: "Where will you lift?", type: "choice", options: ["Home", "School weight room", "Commercial gym", "Other"] },
      { key: "gymName", label: "Name of the gym or school", type: "text", showIf: (a) => a.liftWhere && a.liftWhere !== "Home" },
      { key: "liftEquip", label: "Lifting equipment: check everything you have", type: "multi", options: ["Dumbbells", "Barbell and plates", "Squat rack", "Bench", "Trap bar", "Cable machine", "Pull-up bar", "Kettlebells", "Sled", "Medicine balls", "Box or plyo box"] },
      { key: "dbMax", label: "Heaviest dumbbells available (lb)", type: "text", showIf: (a) => (a.liftEquip || []).includes("Dumbbells") },
      { key: "equipOther", label: "Other equipment", type: "text" },
    ],
  },
  {
    title: "Location and space",
    fields: [
      { key: "outdoorMonths", label: "Which months can you throw outside where you live?", type: "multi", options: MONTHS, compact: true },
      { key: "indoorWhere", label: "When you can't throw outside, where do you throw?", type: "choice", options: ["Indoor facility", "Gym", "Garage or basement with a net", "Nowhere"] },
      { key: "indoorSpace", label: "Indoors: about how much room do you have? (length and ceiling height)", type: "text", showIf: (a) => a.indoorWhere && a.indoorWhere !== "Nowhere" },
      { key: "fullEffortNet", label: "Can you throw full effort into a net indoors?", type: "choice", options: YES_NO, showIf: (a) => a.indoorWhere && a.indoorWhere !== "Nowhere" },
      { key: "facility", label: "Access to an indoor facility or turf? How often?", type: "text" },
    ],
  },
  {
    title: "Goals and commitment",
    fields: [
      { key: "goals", label: "Your top 2-3 goals for the next 3 months", type: "long", required: true, placeholder: "Throw harder, get stronger, stay healthy, make varsity, get recruited" },
      { key: "holdingBack", label: "What's the biggest thing holding you back right now?", type: "long" },
      { key: "remoteBefore", label: "Have you worked with a remote coach or online program before? How did it go?", type: "long" },
      { key: "commitment", label: "How committed are you to training on your own for 3 months, filming, and logging every session? (1-10)", type: "scale", min: 1, max: 10, required: true },
      { key: "parentSuccess", label: "Parents: what would make this program a success for your family?", type: "long", minorOnly: true },
      { key: "heardFrom", label: "How did you hear about RPM?", type: "text" },
    ],
  },
];

// Eval sign-up: just the basics, one page.
export const EVAL_PARTS = [
  {
    title: "Your info",
    fields: [
      { key: "name", label: "Athlete full name", type: "text", required: true },
      { key: "dob", label: "Date of birth", type: "date", required: true },
      { key: "gradYear", label: "Graduating class (year)", type: "text", half: true, placeholder: "2028" },
      { key: "teams", label: "School and team(s)", type: "text", half: true },
      { key: "positions", label: "Position(s)", type: "text", placeholder: "RHP / SS" },
      { key: "throws", label: "Throws", type: "choice", options: ["Right", "Left"], half: true },
      { key: "bats", label: "Bats", type: "choice", options: ["Right", "Left", "Switch"], half: true },
      { key: "height", label: "Height", type: "text", half: true, placeholder: "5'10\"" },
      { key: "weight", label: "Weight (lb)", type: "text", half: true },
      { key: "athletePhone", label: "Athlete cell phone", type: "text", half: true },
      { key: "athleteEmail", label: "Athlete email", type: "text", half: true },
      { key: "parentName", label: "Parent or guardian name", type: "text", minorRequired: true },
      { key: "parentPhone", label: "Parent or guardian cell phone", type: "text", half: true, minorRequired: true },
      { key: "parentEmail", label: "Parent or guardian email", type: "text", half: true },
      { key: "currentPain", label: "Any pain or injury right now (arm or anywhere else)?", type: "yesno", detail: "Where, and what happened?" },
      { key: "heardFrom", label: "How did you hear about RPM?", type: "text" },
    ],
  },
];
export const partsFor = (kind) => (kind === "eval" ? EVAL_PARTS : PARTS);

export const ageFrom = (dob) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob || "")) return null;
  const b = new Date(dob + "T00:00:00"), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a >= 0 && a < 100 ? a : null;
};
const isMinor = (a) => { const age = ageFrom(a.dob); return age != null && age < 18; };
const visible = (f, a) => (!f.showIf || f.showIf(a)) && (!f.minorOnly || isMinor(a));
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== "");
function missing(part, a) {
  return part.fields.filter((f) => visible(f, a) && (f.required || (f.minorRequired && isMinor(a))) && !filled(a[f.key])).map((f) => f.label);
}

// Coach-side read of the answers (doc: "How coaches use the answers").
export function intakeTier(a) {
  const d = a.throwingData || [];
  if (d.includes("TrackMan") || d.includes("Rapsodo")) return { n: 1, text: "Tier 1 · TrackMan/Rapsodo" };
  if (d.includes("Pocket Radar") || d.includes("Radar gun")) return { n: 2, text: "Tier 2 · radar" };
  if (d.includes("Other")) return { n: 2, text: "Tier 2? · other device, confirm on call" };
  return { n: 3, text: "Tier 3 · no velo" };
}
export function intakeFlags(a) {
  const f = [];
  if (a.cardiac === "Yes") f.push({ level: "red", text: "Physician clearance required" });
  const med = ["armInjury", "surgeries", "currentPain", "limits", "provider"].filter((k) => a[k] === "Yes");
  if (med.length) f.push({ level: "amber", text: "Check medical clearance" });
  if (a.inSeason === "Yes") f.push({ level: "info", text: "In season" });
  const setup = a.throwingSetup || [];
  if (a.throwingSetup && !setup.some((x) => /partner|net/i.test(x))) f.push({ level: "info", text: "Throws alone" });
  if (["Nowhere", "Garage or basement with a net"].includes(a.indoorWhere)) f.push({ level: "info", text: "Limited indoor space" });
  if (a.commitment != null && Number(a.commitment) < 7) f.push({ level: "amber", text: `Commitment ${a.commitment}/10` });
  if (isMinor(a) && !filled(a.parentName)) f.push({ level: "amber", text: "Parent contact missing" });
  return f;
}

// ─── Look (portal style) ─────────────────────────────────────────────────────
const C = { bg: "#0A0C10", ink: "#fff", ink2: "#E0E0E0", mut: "#8A8F98", mut2: "#6B7280", faint: "#4A4F57", acc: "#4FFFB0", accd: "rgba(79,255,176,0.12)", field: "#13161B", line: "rgba(255,255,255,0.12)", warn: "#FF6B6B" };
const input = { width: "100%", border: `1px solid ${C.line}`, borderRadius: 10, background: C.field, color: C.ink, padding: "11px 12px", fontSize: 15, outline: "none", fontFamily: "inherit" };
const chip = (on) => ({ border: `1px solid ${on ? C.acc : C.line}`, background: on ? C.accd : "transparent", color: on ? C.acc : C.ink2, borderRadius: 10, padding: "9px 12px", fontSize: 14, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" });

function Field({ f, a, set }) {
  const v = a[f.key];
  const label = (
    <div style={{ fontSize: 14, fontWeight: 600, color: C.ink2, marginBottom: 7, lineHeight: 1.35 }}>
      {f.label}{(f.required || (f.minorRequired && isMinor(a))) ? <span style={{ color: C.acc }}> *</span> : null}
    </div>
  );
  if (f.type === "text" || f.type === "date") return <label style={{ display: "block" }}>{label}<input style={{ ...input, colorScheme: "dark" }} type={f.type === "date" ? "date" : "text"} value={v || ""} placeholder={f.placeholder || ""} onChange={(e) => set(f.key, e.target.value)} /></label>;
  if (f.type === "long") return <label style={{ display: "block" }}>{label}<textarea style={{ ...input, minHeight: 84, resize: "vertical", lineHeight: 1.45 }} value={v || ""} placeholder={f.placeholder || ""} onChange={(e) => set(f.key, e.target.value)} /></label>;
  if (f.type === "choice") return <div>{label}<div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>{f.options.map((o) => <button key={o} type="button" aria-pressed={v === o} style={chip(v === o)} onClick={() => set(f.key, v === o ? "" : o)}>{o}</button>)}</div></div>;
  if (f.type === "multi") {
    const cur = Array.isArray(v) ? v : [];
    const toggle = (o) => {
      let next = cur.includes(o) ? cur.filter((x) => x !== o) : [...cur, o];
      if (o === "None of these" && next.includes(o)) next = [o];
      else next = next.filter((x) => x !== "None of these" || o === "None of these");
      set(f.key, next);
    };
    return <div>{label}<div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>{f.options.map((o) => <button key={o} type="button" aria-pressed={cur.includes(o)} style={{ ...chip(cur.includes(o)), ...(f.compact ? { padding: "8px 10px", minWidth: 52 } : {}) }} onClick={() => toggle(o)}>{cur.includes(o) ? "✓ " : ""}{o}</button>)}</div></div>;
  }
  if (f.type === "yesno") return (
    <div>{label}
      <div style={{ display: "flex", gap: 7 }}>{YES_NO.map((o) => <button key={o} type="button" aria-pressed={v === o} style={chip(v === o)} onClick={() => set(f.key, v === o ? "" : o)}>{o}</button>)}</div>
      {v === "Yes" && f.detail ? <textarea style={{ ...input, minHeight: 64, marginTop: 8, resize: "vertical" }} placeholder={f.detail} value={a[f.key + "Detail"] || ""} onChange={(e) => set(f.key + "Detail", e.target.value)} /> : null}
    </div>
  );
  if (f.type === "scale") {
    const opts = Array.from({ length: f.max - f.min + 1 }, (_, i) => f.min + i);
    return <div>{label}<div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{opts.map((o) => <button key={o} type="button" aria-pressed={Number(v) === o} style={{ ...chip(Number(v) === o), minWidth: 40, padding: "9px 0" }} onClick={() => set(f.key, o)}>{o}</button>)}</div></div>;
  }
  return null;
}

// ─── Athlete page: rpmstrength.coach/intake#t=<key> ─────────────────────────
const IK_KEY = "rpm_intake_link";
export function IntakePage({ logo }) {
  const [token] = useState(() => {
    let t = "";
    try {
      const m = window.location.hash.match(/t=([A-Za-z0-9_-]+)/);
      if (m) { t = m[1]; localStorage.setItem(IK_KEY, t); window.history.replaceState(null, "", window.location.pathname); }
      else t = localStorage.getItem(IK_KEY) || "";
    } catch (e) {}
    return t;
  });
  const [a, setA] = useState(null);
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [step, setStep] = useState(0);
  const [saved, setSaved] = useState("");
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState("remote");
  const timer = useRef(null), latest = useRef(null);
  latest.current = a;
  const dead = "This intake link doesn't work anymore. Ask RPM for a new one.";

  useEffect(() => {
    if (!token) { setErr("Open the link RPM sent you to start your questionnaire."); return; }
    api(token, { query: { op: "intake" } }).then((d) => {
      const ans = { ...(d.answers || {}) };
      if (!ans.timezone) ans.timezone = guessTz();
      setA(ans); setStatus(d.status); setKind(d.kind === "eval" ? "eval" : "remote");
    }).catch((e) => setErr(e.status === 401 ? dead : e.message));
  }, [token]);

  const save = async (final) => {
    clearTimeout(timer.current);
    try {
      const r = await api(token, { body: { op: "saveIntake", answers: latest.current, final: !!final } });
      setStatus(r.status); setSaved("Saved"); return true;
    } catch (e) { setSaved(e.status === 401 ? dead : "Not saved yet, check your connection"); return false; }
  };
  const set = (k, v) => {
    setA((x) => ({ ...x, [k]: v }));
    setSaved("Saving…");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(false), 1200);
  };

  const parts = partsFor(kind), isEval = kind === "eval";
  const part = parts[step];
  const miss = a ? missing(part, a) : [];
  const next = async () => {
    setTried(true);
    if (miss.length) return;
    setTried(false);
    if (step < parts.length - 1) { setStep(step + 1); window.scrollTo(0, 0); save(false); return; }
    setBusy(true);
    const ok = await save(true);
    setBusy(false);
    if (ok) { setStatus("submitted"); setEditing(false); setStep(0); window.scrollTo(0, 0); }
  };

  const wrap = (children) => (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Sans','Helvetica Neue',sans-serif", color: C.ink2 }}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "0 18px 60px" }}>
        <div style={{ height: 32 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 22 }}>
          {logo && <img src={logo} alt="RPM Strength" style={{ height: 30, width: "auto" }} />}
          <div style={{ width: 1, height: 22, background: C.line }} />
          <div style={{ fontSize: 14, fontWeight: 700, color: C.ink }}>{isEval ? "Evaluation Sign-Up" : "Remote Coaching Intake"}</div>
        </div>
        {children}
      </div>
    </div>
  );

  if (err) return wrap(<div style={{ fontSize: 15, color: C.mut, lineHeight: 1.5, padding: "24px 0" }}>{err}</div>);
  if (!a) return wrap(<div style={{ fontSize: 14, color: C.mut2, padding: "24px 0" }}>Loading your questionnaire…</div>);
  if (status === "submitted" && !editing) {
    return wrap(
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.acc, textTransform: "uppercase" }}>Submitted</div>
        <div style={{ fontSize: 26, fontWeight: 800, color: C.ink, marginTop: 6, lineHeight: 1.15 }}>Thanks{a.name ? `, ${a.name.split(" ")[0]}` : ""}. We have your answers.</div>
        {isEval
          ? <p style={{ fontSize: 15, color: C.mut, lineHeight: 1.55, marginTop: 12 }}>You're all set. We'll see you at your evaluation.</p>
          : <>
            <p style={{ fontSize: 15, color: C.mut, lineHeight: 1.55, marginTop: 12 }}>An RPM coach will read them and reach out to set up a 15-20 minute video call. We'll explain how the program works and answer your questions there.</p>
            <p style={{ fontSize: 15, color: C.mut, lineHeight: 1.55 }}>Before training starts, we'll also send the informed consent form. Athletes under 18 need a parent or guardian to sign it.</p>
          </>}
        <button type="button" onClick={() => setEditing(true)} style={{ ...chip(false), marginTop: 10 }}>Edit my answers</button>
      </div>,
    );
  }

  return wrap(
    <div>
      {parts.length > 1 && <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: C.acc, textTransform: "uppercase" }}>Part {step + 1} of {parts.length}</div>}
      <div style={{ fontSize: 26, fontWeight: 800, color: C.ink, marginTop: 4 }}>{part.title}</div>
      {parts.length > 1 && <div style={{ display: "flex", gap: 4, margin: "12px 0 6px" }}>{parts.map((_, i) => <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= step ? C.acc : "rgba(255,255,255,0.08)" }} />)}</div>}
      {step === 0 && <p style={{ fontSize: 14, color: C.mut, lineHeight: 1.5, marginTop: 12 }}>{isEval ? "This takes about 2 minutes. Athletes under 18: add a parent or guardian's contact." : "This takes about 15 minutes. Athletes under 18: please fill it out with a parent or guardian."} Your answers save as you go, so you can come back to this link anytime.</p>}
      {part.note && <p style={{ fontSize: 14, color: C.mut, lineHeight: 1.5, marginTop: 12 }}>{part.note}</p>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "20px 12px", marginTop: 18 }}>
        {part.fields.filter((f) => visible(f, a)).map((f) => (
          <div key={f.key} style={{ flex: f.half ? "1 1 200px" : "1 1 100%", minWidth: 0 }}>
            <Field f={f} a={a} set={set} />
          </div>
        ))}
      </div>
      {tried && miss.length > 0 && <div style={{ marginTop: 18, fontSize: 13, color: C.warn, lineHeight: 1.5 }}>Please fill in: {miss.join(", ")}.</div>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 26 }}>
        {step > 0 && <button type="button" onClick={() => { setStep(step - 1); window.scrollTo(0, 0); }} style={chip(false)}>Back</button>}
        <button type="button" disabled={busy} onClick={next} style={{ flex: 1, border: "none", borderRadius: 10, background: C.acc, color: C.bg, fontSize: 15, fontWeight: 800, padding: "13px 16px", cursor: "pointer", fontFamily: "inherit" }}>
          {step < parts.length - 1 ? "Next" : status === "submitted" ? "Save changes" : "Submit"}
        </button>
      </div>
      <div style={{ fontSize: 12, color: C.faint, marginTop: 10, minHeight: 16 }}>{saved}</div>
    </div>,
  );
}

// ─── Coach panel (Training tab) ──────────────────────────────────────────────
const flagColor = { red: "#FF6B6B", amber: "#F2C94C", info: "#8A8F98" };
function answerText(f, a) {
  const v = a[f.key];
  if (!filled(v)) return null;
  let t = Array.isArray(v) ? v.join(", ") : String(v);
  if (f.type === "yesno" && v === "Yes" && filled(a[f.key + "Detail"])) t += ": " + a[f.key + "Detail"];
  if (f.key === "dob") { const age = ageFrom(v); if (age != null) t += ` (age ${age})`; }
  return t;
}

export function IntakesPanel({ pw, onLocked }) {
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [making, setMaking] = useState(false);
  const [label, setLabel] = useState("");
  const [newKind, setNewKind] = useState("eval");
  const [link, setLink] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = () => api(pw, { query: { op: "intakes" } }).then((d) => setList(d.intakes)).catch((e) => { if (e.status === 401) onLocked(); });
  useEffect(() => { load(); }, [pw]);
  if (!list) return null;

  const create = async (e) => {
    e.preventDefault();
    try {
      const d = await api(pw, { body: { op: "createIntake", label: label.trim(), kind: newKind } });
      setLink({ url: `${window.location.origin}/intake#t=${d.token}`, label: label.trim() || "New athlete" });
      setLabel(""); setMaking(false); load();
    } catch (err) { if (err.status === 401) onLocked(); else setMsg(err.message); }
  };
  const remove = async (it) => {
    if (!window.confirm(`Delete ${it.answers?.name || it.label}'s intake? Their link stops working and the answers are removed.`)) return;
    try { await api(pw, { body: { op: "deleteIntake", intakeId: it.id } }); setOpen(null); load(); } catch (err) { setMsg(err.message); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(link.url); setMsg("Copied. Text or email it to the athlete or parent."); } catch (e) { setMsg("Press and hold the link to copy it."); } };
  const fresh = list.filter((i) => i.status === "submitted").length;
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");

  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: "#fff" }}>Intakes {fresh ? <span style={{ fontSize: 11, color: C.acc, fontWeight: 700 }}> · {fresh} submitted</span> : null}</div>
        {!making && <button className="tb" onClick={() => { setMaking(true); setLink(null); setMsg(null); }}>+ New intake link</button>}
      </div>
      {making && (
        <form onSubmit={create} style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <div className="seg" role="group" aria-label="Form" style={{ flex: "1 1 100%" }}>
            {[["eval", "Eval sign-up (short)"], ["remote", "Remote client (full)"]].map(([k, t]) => <button type="button" key={k} aria-pressed={newKind === k} onClick={() => setNewKind(k)}>{t}</button>)}
          </div>
          <input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Athlete or family name" style={{ ...input, flex: "1 1 180px", padding: "8px 10px", fontSize: 14 }} />
          <button type="submit" style={{ border: "none", borderRadius: 10, background: C.acc, color: C.bg, fontWeight: 700, padding: "8px 14px", cursor: "pointer" }}>Make link</button>
          <button type="button" className="tb" onClick={() => setMaking(false)}>Cancel</button>
        </form>
      )}
      {link && (
        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          <div style={{ fontSize: 11, color: C.mut }}>Intake link for {link.label}. Shown once, copy it now:</div>
          <div style={{ fontSize: 11, color: C.ink2, background: C.field, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 10px", wordBreak: "break-all", userSelect: "all" }}>{link.url}</div>
          <div><button className="tb" onClick={copy}>Copy link</button></div>
        </div>
      )}
      {msg && <div style={{ fontSize: 11, color: C.mut, marginTop: 8 }}>{msg}</div>}
      <div style={{ marginTop: 10 }}>
        {list.length === 0 && <div style={{ fontSize: 12, color: C.mut2 }}>No intakes yet. Make a link for your next athlete.</div>}
        {list.map((it) => {
          const a = it.answers || {};
          const isEvalIt = it.kind === "eval";
          const tier = it.answers && !isEvalIt ? intakeTier(a) : null;
          const flags = it.answers ? intakeFlags(a) : [];
          const age = ageFrom(a.dob);
          const isOpen = open === it.id;
          return (
            <div key={it.id} style={{ border: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)", borderRadius: 12, padding: "10px 12px", marginBottom: 6 }}>
              <div role="button" tabIndex={0} onClick={() => setOpen(isOpen ? null : it.id)} onKeyDown={(e) => { if (e.key === "Enter") setOpen(isOpen ? null : it.id); }} style={{ cursor: "pointer" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>{a.name || it.label}{age != null ? <span style={{ fontSize: 12, color: C.mut2, fontWeight: 500 }}> · {age}</span> : null}<span style={{ fontSize: 10, fontWeight: 700, color: C.mut2, marginLeft: 6, textTransform: "uppercase", letterSpacing: ".06em" }}>{isEvalIt ? "Eval" : "Remote"}</span></div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: it.status === "submitted" ? C.acc : C.mut2, whiteSpace: "nowrap" }}>
                    {it.status === "submitted" ? `Submitted ${when(it.submittedAt)}` : it.status === "draft" ? "In progress" : `Sent ${when(it.created)}`}
                  </div>
                </div>
                {(tier || flags.length > 0) && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 6 }}>
                    {tier && <span style={{ fontSize: 10, fontWeight: 700, color: C.acc, border: `1px solid rgba(79,255,176,0.35)`, borderRadius: 6, padding: "2px 6px" }}>{tier.text}</span>}
                    {flags.map((fl) => <span key={fl.text} style={{ fontSize: 10, fontWeight: 700, color: flagColor[fl.level], border: `1px solid ${flagColor[fl.level]}55`, borderRadius: 6, padding: "2px 6px" }}>{fl.text}</span>)}
                  </div>
                )}
              </div>
              {isOpen && (
                <div style={{ marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
                  {!it.answers && <div style={{ fontSize: 12, color: C.mut2 }}>Not started yet.</div>}
                  {it.answers && partsFor(it.kind).map((p) => {
                    const rows = p.fields.filter((f) => visible(f, a)).map((f) => [f, answerText(f, a)]).filter(([, t]) => t);
                    if (!rows.length) return null;
                    return (
                      <div key={p.title} style={{ marginBottom: 10 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: C.mut, margin: "6px 0 4px" }}>{p.title}</div>
                        {rows.map(([f, t]) => (
                          <div key={f.key} style={{ fontSize: 12, lineHeight: 1.45, marginBottom: 4 }}>
                            <span style={{ color: C.mut2 }}>{f.label}</span><br /><span style={{ color: C.ink2 }}>{t}</span>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <button className="tb" onClick={() => remove(it)} style={{ marginTop: 4 }}>Delete intake</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
