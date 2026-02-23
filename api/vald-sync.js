/**
 * VALD ForceDecks API Sync — Vercel Serverless Function
 * RPM Strength Athlete Portal
 *
 * Two modes:
 *   ?mode=list  — fetches all test IDs + profiles (paginated, ~25s)
 *   ?mode=process&ids=id1,id2,...  — fetches trials for specific tests (~15 per call)
 *   ?test=auth|tenant|profiles  — diagnostic modes
 *
 * VALD rate limit: 25 requests per 5 seconds.
 * Pacer: 300ms between calls = ~3.3 req/s = ~16.5 per 5s (safe margin).
 */

const AUTH_URL_OLD = "https://auth.prd.vald.com/oauth/token";
const TENANT_URL = "https://prd-use-api-externaltenants.valdperformance.com";
const PROFILE_URL = "https://prd-use-api-externalprofile.valdperformance.com";
const FD_URL = "https://prd-use-api-extforcedecks.valdperformance.com";

const CMJ_MAP = {
  JUMP_HEIGHT_INCHES: "jumpHeight", RSI_MODIFIED: "rsiMod",
  BODYMASS_RELATIVE_TAKEOFF_POWER: "peakPowerBM", ECCENTRIC_BRAKING_RFD: "eccBrakingRFD",
  BODY_WEIGHT_LBS: "bodyweightLbs", COUNTERMOVEMENT_DEPTH: "depth",
  CONCENTRIC_IMPULSE: "conImpulse", ECCENTRIC_BRAKING_IMPULSE: "eccBrakingImpulse",
  PEAK_CONCENTRIC_FORCE: "conPeakForce", CONCENTRIC_RFD: "conRFD",
};
const HOP_MAP = {
  HOP_BEST_RSI: "rsi", HOP_BEST_FLIGHT_TIME: "flightTime",
  HOP_BEST_CONTACT_TIME: "contactTime", BODY_WEIGHT_LBS: "bodyweightLbs",
};
const ASYM_KEYS = ["CONCENTRIC_IMPULSE", "ECCENTRIC_BRAKING_IMPULSE", "PEAK_CONCENTRIC_FORCE"];

// ─── Pacer: 300ms between API calls ───
let lastCall = 0;
async function pace() {
  const gap = Date.now() - lastCall;
  if (gap < 300) await new Promise(r => setTimeout(r, 300 - gap));
  lastCall = Date.now();
}

// ─── Auth ───
let tokenCache = null;
async function getToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.accessToken;
  const cid = process.env.VALD_CLIENT_ID, sec = process.env.VALD_CLIENT_SECRET;
  if (!cid || !sec) throw new Error("Missing VALD credentials");
  await pace();
  const r = await fetch(AUTH_URL_OLD, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials", client_id: cid, client_secret: sec,
      audience: "vald-api-external",
    }).toString(),
  });
  if (!r.ok) throw new Error(`Auth failed: ${r.status}`);
  const d = await r.json();
  tokenCache = { accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
  return d.access_token;
}

async function apiFetch(url) {
  await pace();
  const token = await getToken();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 429) {
    // Single retry after 6s
    await new Promise(res => setTimeout(res, 6000));
    lastCall = Date.now();
    await pace();
    const r2 = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r2.ok) throw new Error(`API ${r2.status} after retry: ${url}`);
    return r2.status === 204 ? null : r2.json();
  }
  if (r.status === 204) return null;
  if (!r.ok) throw new Error(`API ${r.status}: ${url}`);
  return r.json();
}

// ─── Helpers ───
function getTestType(results) {
  const keys = new Set((results || []).map(r => r.definition?.result));
  if (keys.has("HOP_BEST_RSI")) return "hop";
  if (keys.has("RSI_MODIFIED") || keys.has("JUMP_HEIGHT_INCHES")) return "cmj";
  return "unknown";
}

function extract(results, map) {
  const out = {};
  (results || []).forEach(r => {
    if (r.limb === "Trial" && r.repeat === 0 && r.definition && map[r.definition.result])
      out[map[r.definition.result]] = r.value;
  });
  if (out.bodyweightLbs != null) out.bodyweightLbs = +(out.bodyweightLbs * 2.20462).toFixed(1);
  return out;
}

function isSquatJump(m) { return m.depth === 0 || m.depth == null; }

function extractAsym(results) {
  const out = {};
  (results || []).forEach(r => {
    if (r.repeat !== 0 || !r.definition) return;
    const key = r.definition.result;
    if (!ASYM_KEYS.includes(key)) return;
    const s = key === "CONCENTRIC_IMPULSE" ? "conImpulse"
      : key === "ECCENTRIC_BRAKING_IMPULSE" ? "eccBrakingImpulse" : "conPeakForce";
    if (r.limb === "Left") out[s + "L"] = r.value;
    else if (r.limb === "Right") out[s + "R"] = r.value;
  });
  return out;
}

function fmtDate(utc, offset) {
  if (!utc) return "";
  const d = new Date(utc);
  if (offset != null) d.setMinutes(d.getMinutes() + offset);
  return `${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}/${d.getFullYear()}`;
}

// ═══════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════
module.exports = async function handler(req, res) {
  const startTime = Date.now();
  lastCall = 0;

  try {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (req.method === "OPTIONS") return res.status(200).end();
    const { mode, test, ids, since } = req.query;

    // ─── Diagnostic modes ───
    if (test === "auth") {
      const t = await getToken();
      return res.status(200).json({ success: true, preview: t.substring(0, 20) + "..." });
    }
    if (test === "tenant") {
      const d = await apiFetch(`${TENANT_URL}/tenants`);
      return res.status(200).json({ success: true, tenantId: (d?.tenants || d)[0].id });
    }
    if (test === "profiles") {
      const tid = (await apiFetch(`${TENANT_URL}/tenants`))?.tenants?.[0]?.id;
      const d = await apiFetch(`${PROFILE_URL}/profiles?tenantId=${tid}`);
      const p = d?.profiles || d;
      return res.status(200).json({ success: true, count: p.length, sample: p.slice(0,10).map(x=>({id:x.profileId,name:x.givenName+" "+x.familyName})) });
    }

    // ═══ MODE: LIST ═══
    // Returns all test IDs + profiles. Client uses this to plan batch processing.
    if (mode === "list") {
      const tid = (await apiFetch(`${TENANT_URL}/tenants`))?.tenants?.[0]?.id;

      // Fetch profiles
      const pd = await apiFetch(`${PROFILE_URL}/profiles?tenantId=${tid}`);
      const profiles = pd?.profiles || pd || [];
      const profileMap = {};
      profiles.forEach(p => {
        profileMap[p.profileId || p.id] = {
          name: [p.givenName, p.familyName].filter(Boolean).join(" ").trim(),
          given: p.givenName || "", family: p.familyName || "",
        };
      });

      // Paginate all tests
      const allTests = [];
      let cursor = since || "2025-06-01T00:00:00Z";
      for (let i = 0; i < 200; i++) {
        if (Date.now() - startTime > 50000) break;
        const d = await apiFetch(`${FD_URL}/tests?tenantId=${tid}&modifiedFromUtc=${encodeURIComponent(cursor)}`);
        const tests = d?.tests || d;
        if (!tests?.length) break;
        for (const t of tests) {
          allTests.push({
            id: t.testId,
            pid: t.profileId,
            rec: t.recordedDateUtc,
            off: t.recordedDateOffset,
          });
        }
        cursor = tests[tests.length - 1].modifiedDateUtc;
        if (tests.length < 50) break;
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.status(200).json({
        success: true, mode: "list", elapsed: `${elapsed}s`,
        testCount: allTests.length,
        profileCount: profiles.length,
        tenantId: tid,
        profileMap,
        tests: allTests,
      });
    }

    // ═══ MODE: PROCESS ═══
    // Takes comma-separated test IDs + tenantId, fetches trials, returns extracted metrics.
    if (mode === "process") {
      const tid = req.query.tid;
      const testIds = (ids || "").split(",").filter(Boolean);
      if (!tid || !testIds.length) return res.status(400).json({ success: false, error: "Need tid and ids params" });

      // Also need the recorded dates + offsets — passed as parallel arrays
      const recs = (req.query.recs || "").split(",");
      const offs = (req.query.offs || "").split(",").map(Number);

      const cmj = {}, hop = {};
      let processed = 0, skipped = 0, errors = 0;

      for (let i = 0; i < testIds.length; i++) {
        if (Date.now() - startTime > 50000) break;
        try {
          const trials = await apiFetch(`${FD_URL}/v2019q3/teams/${tid}/tests/${testIds[i]}/trials`);
          if (!trials?.length) { errors++; continue; }
          const trial = trials[0];
          const type = getTestType(trial.results);
          const date = fmtDate(recs[i], offs[i]);

          if (type === "cmj") {
            const m = extract(trial.results, CMJ_MAP);
            if (isSquatJump(m)) { skipped++; processed++; continue; }
            const a = extractAsym(trial.results);
            const pid = req.query[`p${i}`] || trial.athleteId || "unknown";
            if (!cmj[pid]) cmj[pid] = [];
            cmj[pid].push({ date, ...m, ...a });
          } else if (type === "hop") {
            const m = extract(trial.results, HOP_MAP);
            const pid = req.query[`p${i}`] || trial.athleteId || "unknown";
            if (!hop[pid]) hop[pid] = [];
            hop[pid].push({ date, ...m });
          }
          processed++;
        } catch { errors++; }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.status(200).json({
        success: true, mode: "process", elapsed: `${elapsed}s`,
        processed, skipped, errors,
        cmj, hop,
      });
    }

    return res.status(400).json({ success: false, error: "Use ?mode=list or ?mode=process&ids=..." });

  } catch (err) {
    console.error("VALD sync error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
