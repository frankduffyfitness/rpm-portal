/**
 * VALD ForceDecks API Sync — Vercel Serverless Function
 * RPM Strength Athlete Portal
 *
 * Environment variables (set in Vercel dashboard):
 *   VALD_CLIENT_ID, VALD_CLIENT_SECRET
 */

const AUTH_URL = "https://security.valdperformance.com/connect/token";
const AUTH_URL_OLD = "https://auth.prd.vald.com/oauth/token";
const TENANT_URL = "https://prd-use-api-externaltenants.valdperformance.com";
const PROFILE_URL = "https://prd-use-api-externalprofile.valdperformance.com";
const FD_URL = "https://prd-use-api-extforcedecks.valdperformance.com";
const DEFAULT_START = "2025-06-01T00:00:00Z";

// Metric mapping: VALD key -> portal key
const CMJ_MAP = {
  JUMP_HEIGHT_INCHES: "jumpHeight",
  RSI_MODIFIED: "rsiMod",
  BODYMASS_RELATIVE_TAKEOFF_POWER: "peakPowerBM",
  ECCENTRIC_BRAKING_RFD: "eccBrakingRFD",
  BODY_WEIGHT_LBS: "bodyweightLbs",
  COUNTERMOVEMENT_DEPTH: "depth",
  CONCENTRIC_IMPULSE: "conImpulse",
  ECCENTRIC_BRAKING_IMPULSE: "eccBrakingImpulse",
  PEAK_CONCENTRIC_FORCE: "conPeakForce",
  CONCENTRIC_RFD: "conRFD",
};

const HOP_MAP = {
  HOP_BEST_RSI: "rsi",
  HOP_BEST_FLIGHT_TIME: "flightTime",
  HOP_BEST_CONTACT_TIME: "contactTime",
  BODY_WEIGHT_LBS: "bodyweightLbs",
};

// Asymmetry metrics (need L/R limb values)
const ASYM_KEYS = ["CONCENTRIC_IMPULSE", "ECCENTRIC_BRAKING_IMPULSE", "PEAK_CONCENTRIC_FORCE"];

let tokenCache = { accessToken: null, expiresAt: 0 };

async function getToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken;
  }
  const cid = process.env.VALD_CLIENT_ID;
  const sec = process.env.VALD_CLIENT_SECRET;
  if (!cid || !sec) throw new Error("Missing VALD_CLIENT_ID or VALD_CLIENT_SECRET environment variables");

  for (const url of [AUTH_URL, AUTH_URL_OLD]) {
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: cid,
        client_secret: sec,
        audience: "vald-api-external",
      });
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!r.ok) continue;
      const d = await r.json();
      tokenCache = { accessToken: d.access_token, expiresAt: Date.now() + (d.expires_in || 3600) * 1000 };
      return d.access_token;
    } catch { continue; }
  }
  throw new Error("Authentication failed on all endpoints");
}

async function apiFetch(url) {
  const token = await getToken();
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 204) return null;
  if (!r.ok) { const t = await r.text(); throw new Error(`API ${r.status}: ${url} — ${t}`); }
  return r.json();
}

async function getTenantId() {
  const d = await apiFetch(`${TENANT_URL}/tenants`);
  const t = d?.tenants || d;
  if (!t?.length) throw new Error("No tenants found");
  return t[0].id;
}

async function getProfiles(tenantId) {
  const d = await apiFetch(`${PROFILE_URL}/profiles?tenantId=${tenantId}`);
  return d?.profiles || (Array.isArray(d) ? d : []);
}

async function getAllTests(tenantId, fromUtc) {
  const all = [];
  let cursor = fromUtc;
  for (let i = 0; i < 100; i++) {
    const d = await apiFetch(`${FD_URL}/tests?tenantId=${tenantId}&modifiedFromUtc=${encodeURIComponent(cursor)}`);
    const tests = d?.tests || d;
    if (!tests?.length) break;
    all.push(...tests);
    cursor = tests[tests.length - 1].modifiedDateUtc;
    if (tests.length < 50) break;
  }
  return all;
}

async function getTrials(tenantId, testId) {
  try {
    return await apiFetch(`${FD_URL}/v2019q3/teams/${tenantId}/tests/${testId}/trials`) || [];
  } catch { return []; }
}

function getTestType(results) {
  const keys = new Set((results || []).map(r => r.definition?.result));
  if (keys.has("HOP_BEST_RSI")) return "hop";
  if (keys.has("RSI_MODIFIED") || keys.has("JUMP_HEIGHT_INCHES")) return "cmj";
  return "unknown";
}

function extract(results, map) {
  const out = {};
  (results || []).forEach(r => {
    if (r.limb === "Trial" && r.repeat === 0 && r.definition && map[r.definition.result]) {
      out[map[r.definition.result]] = r.value;
    }
  });
  // VALD returns kg in BODY_WEIGHT_LBS field — convert to actual lbs
  if (out.bodyweightLbs != null) out.bodyweightLbs = +(out.bodyweightLbs * 2.20462).toFixed(1);
  return out;
}

// Check if CMJ trial is actually a squat jump (no countermovement)
function isSquatJump(metrics) {
  return metrics.depth === 0 || metrics.depth == null;
}

function extractAsym(results) {
  const out = {};
  (results || []).forEach(r => {
    if (r.repeat !== 0 || !r.definition) return;
    const key = r.definition.result;
    if (!ASYM_KEYS.includes(key)) return;
    const short = key === "CONCENTRIC_IMPULSE" ? "conImpulse" : key === "ECCENTRIC_BRAKING_IMPULSE" ? "eccBrakingImpulse" : "conPeakForce";
    if (r.limb === "Left") out[short + "L"] = r.value;
    else if (r.limb === "Right") out[short + "R"] = r.value;
  });
  return out;
}

function fmtDate(utc, offset) {
  if (!utc) return "";
  const d = new Date(utc);
  if (offset != null) d.setMinutes(d.getMinutes() + offset);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

// ─── Main Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Increase timeout awareness
  const startTime = Date.now();

  try {
    const { test, since } = req.query || {};

    if (test === "auth") {
      const token = await getToken();
      return res.status(200).json({
        success: true, message: "Authentication successful",
        tokenPreview: token.substring(0, 20) + "...",
        expiresAt: new Date(tokenCache.expiresAt).toISOString(),
      });
    }

    if (test === "tenant") {
      const tenantId = await getTenantId();
      return res.status(200).json({ success: true, tenantId });
    }

    if (test === "profiles") {
      const tenantId = await getTenantId();
      const profiles = await getProfiles(tenantId);
      return res.status(200).json({
        success: true, count: profiles.length,
        sample: profiles.slice(0, 10).map(p => ({
          id: p.profileId || p.id,
          name: [p.givenName, p.familyName].filter(Boolean).join(" "),
        })),
      });
    }

    if (test === "explore") {
      const tenantId = await getTenantId();
      const testSince = since || "2026-02-20T00:00:00Z";
      const tests = await getAllTests(tenantId, testSince);
      const firstTest = tests[0];
      
      // Try various bulk/alternative endpoints
      const endpoints = [
        `${FD_URL}/v2019q3/teams/${tenantId}/tests/${firstTest.testId}/trials`,
        `${FD_URL}/v2019q3/teams/${tenantId}/tests?testType=CMJ`,
        `${FD_URL}/tests/${firstTest.testId}`,
        `${FD_URL}/tests/${firstTest.testId}/results`,
        `${FD_URL}/v2019q3/teams/${tenantId}/results`,
        `${FD_URL}/testresults?tenantId=${tenantId}&modifiedFromUtc=${encodeURIComponent(testSince)}`,
        `${FD_URL}/tests/results?tenantId=${tenantId}&modifiedFromUtc=${encodeURIComponent(testSince)}`,
      ];
      
      const results = [];
      for (const url of endpoints) {
        try {
          const token = await getToken();
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
          const body = await r.text();
          results.push({
            url: url.replace(tenantId, "TENANT"),
            status: r.status,
            preview: body.substring(0, 300),
          });
        } catch (err) {
          results.push({ url: url.replace(tenantId, "TENANT"), error: err.message });
        }
      }
      return res.status(200).json({ success: true, results });
    }

    if (test === "tests") {
      const tenantId = await getTenantId();
      const tests = await getAllTests(tenantId, since || "2026-02-01T00:00:00Z");
      return res.status(200).json({
        success: true, testCount: tests.length,
        sample: tests.slice(0, 5).map(t => ({
          testId: t.testId, profileId: t.profileId, recorded: t.recordedDateUtc,
        })),
      });
    }

    if (test === "trials") {
      const tenantId = await getTenantId();
      const tests = await getAllTests(tenantId, since || "2026-02-20T00:00:00Z");
      const profiles = await getProfiles(tenantId);
      const pMap = {};
      profiles.forEach(p => { pMap[p.profileId || p.id] = [p.givenName, p.familyName].filter(Boolean).join(" "); });

      const samples = [];
      for (const t of tests.slice(0, 5)) {
        const trials = await getTrials(tenantId, t.testId);
        if (!trials.length) continue;
        const trial = trials[0];
        const type = getTestType(trial.results);
        const metrics = extract(trial.results, type === "hop" ? HOP_MAP : CMJ_MAP);
        // Flag squat jumps
        const squat = type === "cmj" && isSquatJump(metrics);
        samples.push({
          athlete: pMap[t.profileId] || t.profileId,
          recorded: fmtDate(t.recordedDateUtc, t.recordedDateOffset),
          testType: squat ? "squat_jump_SKIPPED" : type,
          metrics,
          asymmetry: type === "cmj" ? extractAsym(trial.results) : undefined,
        });
      }
      return res.status(200).json({ success: true, samples });
    }

    // ─── Full sync: process all data with parallel trial fetching ───
    const modifiedFrom = since || DEFAULT_START;
    const until = req.query.until || null; // optional end date for chunking
    const tenantId = await getTenantId();

    console.log(`Fetching profiles...`);
    const profiles = await getProfiles(tenantId);
    const pMap = {};
    profiles.forEach(p => {
      pMap[p.profileId || p.id] = {
        name: [p.givenName, p.familyName].filter(Boolean).join(" ").trim(),
        given: p.givenName || "",
        family: p.familyName || "",
      };
    });

    console.log(`Fetching tests since ${modifiedFrom}...`);
    let tests = await getAllTests(tenantId, modifiedFrom);
    
    // Filter by until date if provided
    if (until) {
      const untilDate = new Date(until);
      tests = tests.filter(t => new Date(t.recordedDateUtc) < untilDate);
    }
    
    console.log(`Found ${tests.length} tests, processing trials in parallel...`);

    const cmj = {}; // pid -> [{date, ...metrics, asym}]
    const hop = {}; // pid -> [{date, ...metrics}]
    let processed = 0, errors = 0, skipped = 0;
    const BATCH_SIZE = 15; // parallel requests per batch

    for (let i = 0; i < tests.length; i += BATCH_SIZE) {
      // Timeout safety: Vercel hobby has 60s limit
      if (Date.now() - startTime > 52000) {
        console.warn(`Approaching timeout at ${processed} of ${tests.length} tests`);
        break;
      }

      const batch = tests.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(t => getTrials(tenantId, t.testId).then(trials => ({ t, trials })))
      );

      for (const result of results) {
        if (result.status !== "fulfilled" || !result.value.trials.length) {
          errors++;
          continue;
        }
        const { t, trials } = result.value;
        const trial = trials[0];
        const type = getTestType(trial.results);
        const date = fmtDate(t.recordedDateUtc, t.recordedDateOffset);

        if (type === "cmj") {
          const m = extract(trial.results, CMJ_MAP);
          if (isSquatJump(m)) { skipped++; processed++; continue; }
          const a = extractAsym(trial.results);
          if (!cmj[t.profileId]) cmj[t.profileId] = [];
          cmj[t.profileId].push({ date, ...m, ...a });
        } else if (type === "hop") {
          const m = extract(trial.results, HOP_MAP);
          if (!hop[t.profileId]) hop[t.profileId] = [];
          hop[t.profileId].push({ date, ...m });
        }
        processed++;
      }
    }

    // Sort by date
    const dateCmp = (a, b) => {
      const [am, ad, ay] = a.date.split("/").map(Number);
      const [bm, bd, by] = b.date.split("/").map(Number);
      return (ay - by) || (am - bm) || (ad - bd);
    };
    Object.values(cmj).forEach(a => a.sort(dateCmp));
    Object.values(hop).forEach(a => a.sort(dateCmp));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const timedOut = processed < tests.length;

    return res.status(200).json({
      success: true,
      syncedAt: new Date().toISOString(),
      elapsed: `${elapsed}s`,
      complete: !timedOut,
      stats: {
        profiles: profiles.length,
        totalTests: tests.length,
        processed,
        skipped,
        errors,
        cmjAthletes: Object.keys(cmj).length,
        hopAthletes: Object.keys(hop).length,
        cmjSessions: Object.values(cmj).reduce((s, a) => s + a.length, 0),
        hopSessions: Object.values(hop).reduce((s, a) => s + a.length, 0),
      },
      profileMap: pMap,
      cmj,
      hop,
    });

  } catch (err) {
    console.error("VALD sync error:", err);
    return res.status(500).json({
      success: false, error: err.message,
      hint: err.message.includes("Missing VALD") ? "Set env vars in Vercel"
        : err.message.includes("Authentication") ? "Check credentials"
        : "Check Vercel function logs",
    });
  }
}
