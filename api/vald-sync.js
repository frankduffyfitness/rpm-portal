/**
 * VALD ForceDecks API Sync — Vercel Serverless Function
 * 
 * Authenticates with VALD's identity server, pulls ForceDecks test data,
 * and returns processed athlete metrics for the RPM Strength portal.
 * 
 * Environment variables required (set in Vercel dashboard):
 *   VALD_CLIENT_ID     — API client ID from VALD
 *   VALD_CLIENT_SECRET — API client secret from VALD
 * 
 * Endpoints:
 *   GET /api/vald-sync              — Full sync (all data since start date)
 *   GET /api/vald-sync?since=ISO    — Incremental sync (since date)
 *   GET /api/vald-sync?test=auth    — Test authentication only
 */

// ─── Configuration ───────────────────────────────────────────────────
const AUTH_URL = "https://security.valdperformance.com/connect/token";
const TENANT_URL = "https://prd-use-api-externaltenant.valdperformance.com";
const PROFILE_URL = "https://prd-use-api-externalprofile.valdperformance.com";
const FD_URL = "https://prd-use-api-externalforcedecks.valdperformance.com";

// Fallback to old auth if new one isn't active yet
const AUTH_URL_OLD = "https://auth.prd.vald.com/oauth/token";

// How far back to pull data on full sync
const DEFAULT_START = "2025-06-01T00:00:00Z";

// ─── Token cache (persists across warm invocations) ──────────────────
let tokenCache = { accessToken: null, expiresAt: 0 };

// ─── Auth ────────────────────────────────────────────────────────────
async function getToken() {
  if (tokenCache.accessToken && tokenCache.expiresAt > Date.now() + 60000) {
    return tokenCache.accessToken;
  }

  const clientId = process.env.VALD_CLIENT_ID;
  const clientSecret = process.env.VALD_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing VALD_CLIENT_ID or VALD_CLIENT_SECRET environment variables");
  }

  // Try new auth endpoint first, fall back to old
  const endpoints = [AUTH_URL, AUTH_URL_OLD];
  const errors = [];

  for (const url of endpoints) {
    try {
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      });

      // Both endpoints require audience parameter
      body.append("audience", "vald-api-external");

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!res.ok) {
        const errText = await res.text();
        lastError = `${url}: ${res.status} ${res.statusText} — ${errText}`;
        errors.push(lastError);
        continue;
      }

      const data = await res.json();
      tokenCache.accessToken = data.access_token;
      tokenCache.expiresAt = Date.now() + (data.expires_in || 3600) * 1000;

      console.log(`Authenticated via ${url}, expires in ${data.expires_in}s`);
      return tokenCache.accessToken;
    } catch (err) {
      lastError = `${url}: ${err.message}`;
      errors.push(lastError);
      continue;
    }
  }

  throw new Error(`Authentication failed. Errors: ${JSON.stringify(errors)}`);
}

// ─── API Helpers ─────────────────────────────────────────────────────
async function apiGet(baseUrl, path, params = {}) {
  const token = await getToken();
  const url = new URL(path, baseUrl);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) url.searchParams.set(k, v);
  });

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 204) return null; // No content
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${url.pathname} — ${errText}`);
  }

  return res.json();
}

// ─── Data Fetchers ───────────────────────────────────────────────────
async function getTenantId() {
  const data = await apiGet(TENANT_URL, "/tenants");
  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error("No tenants found for this API client");
  }
  console.log(`Found ${data.length} tenant(s): ${data.map(t => t.name || t.tenantId).join(", ")}`);
  return data[0].tenantId;
}

async function getProfiles(tenantId) {
  const data = await apiGet(PROFILE_URL, "/profiles", { tenantId });
  if (!data || !Array.isArray(data)) return [];
  console.log(`Found ${data.length} profiles`);
  return data;
}

async function getForceDecksTests(tenantId, modifiedFromUtc) {
  const allTests = [];
  let page = 1;
  let hasMore = true;

  // Use v2 endpoint for incremental pulls (ascending by modifiedDateUtc)
  while (hasMore) {
    const data = await apiGet(FD_URL, "/tests/v2", {
      TenantId: tenantId,
      ModifiedFromUtc: modifiedFromUtc,
    });

    if (!data || !data.tests || data.tests.length === 0) {
      hasMore = false;
    } else {
      allTests.push(...data.tests);
      // Pagination: use last record's modifiedDateUtc for next pull
      const lastModified = data.tests[data.tests.length - 1].modifiedDateUtc;
      modifiedFromUtc = lastModified;
      console.log(`Fetched page ${page}: ${data.tests.length} tests (last: ${lastModified})`);
      page++;

      // Safety: cap at 50 pages to avoid runaway
      if (page > 50) {
        console.warn("Hit 50-page cap, stopping pagination");
        hasMore = false;
      }
    }
  }

  console.log(`Total tests fetched: ${allTests.length}`);
  return allTests;
}

async function getTrials(tenantId, testId) {
  return apiGet(FD_URL, `/v2019q3/teams/${tenantId}/tests/${testId}/trials`);
}

// ─── Data Processing ─────────────────────────────────────────────────
function processTestData(tests, profiles) {
  // Build profile lookup
  const profileMap = {};
  profiles.forEach(p => {
    const name = [p.givenName, p.familyName].filter(Boolean).join(" ").trim();
    profileMap[p.id || p.profileId] = {
      name: name || "Unknown",
      givenName: p.givenName || "",
      familyName: p.familyName || "",
    };
  });

  // Group tests by profile
  const athleteTests = {};
  tests.forEach(t => {
    const pid = t.profileId;
    if (!athleteTests[pid]) athleteTests[pid] = [];
    athleteTests[pid].push(t);
  });

  return {
    profileMap,
    athleteTests,
    testCount: tests.length,
    athleteCount: Object.keys(athleteTests).length,
    profiles: profiles.length,
  };
}

// ─── Main Handler ────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const { test, since } = req.query || {};

    // ─── Test mode: just verify auth works ───
    if (test === "auth") {
      const token = await getToken();
      return res.status(200).json({
        success: true,
        message: "Authentication successful",
        tokenPreview: token.substring(0, 20) + "...",
        expiresAt: new Date(tokenCache.expiresAt).toISOString(),
      });
    }

    // ─── Test mode: verify tenant access ───
    if (test === "tenant") {
      const token = await getToken();
      const tenantId = await getTenantId();
      return res.status(200).json({
        success: true,
        tenantId,
      });
    }

    // ─── Test mode: verify profiles ───
    if (test === "profiles") {
      const tenantId = await getTenantId();
      const profiles = await getProfiles(tenantId);
      return res.status(200).json({
        success: true,
        count: profiles.length,
        sample: profiles.slice(0, 5).map(p => ({
          id: p.id || p.profileId,
          name: [p.givenName, p.familyName].filter(Boolean).join(" "),
        })),
      });
    }

    // ─── Test mode: fetch a small batch of tests ───
    if (test === "tests") {
      const tenantId = await getTenantId();
      const testSince = since || "2026-02-01T00:00:00Z"; // Recent data only for testing
      const tests = await getForceDecksTests(tenantId, testSince);
      return res.status(200).json({
        success: true,
        testCount: tests.length,
        sample: tests.slice(0, 3).map(t => ({
          testId: t.testId,
          profileId: t.profileId,
          recorded: t.recordedDateUtc,
          testType: t.testType || t.testTypeName,
        })),
      });
    }

    // ─── Full sync ───
    const modifiedFrom = since || DEFAULT_START;
    console.log(`Starting sync from ${modifiedFrom}`);

    const tenantId = await getTenantId();
    const profiles = await getProfiles(tenantId);
    const tests = await getForceDecksTests(tenantId, modifiedFrom);
    const processed = processTestData(tests, profiles);

    return res.status(200).json({
      success: true,
      syncedAt: new Date().toISOString(),
      modifiedFrom,
      tenantId,
      stats: {
        profiles: processed.profiles,
        tests: processed.testCount,
        athletes: processed.athleteCount,
      },
      // In production, this would return the fully processed data
      // For now, return raw structure for validation
      data: {
        profiles: profiles.slice(0, 10),
        recentTests: tests.slice(-10),
      },
    });

  } catch (err) {
    console.error("VALD sync error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      hint: err.message.includes("Missing VALD_CLIENT")
        ? "Set VALD_CLIENT_ID and VALD_CLIENT_SECRET in Vercel Environment Variables"
        : err.message.includes("Authentication failed")
        ? "Check credentials — the March 2026 auth migration may require new credentials from VALD"
        : "Check Vercel function logs for details",
    });
  }
}
