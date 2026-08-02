#!/usr/bin/env python3
# Suppress blake2 hash warnings on macOS Python 3.14
import warnings
warnings.filterwarnings("ignore")
import logging as _lg
_lg.disable(_lg.CRITICAL)
import hashlib
_lg.disable(_lg.NOTSET)
del _lg

import os, sys, json, time, requests
from datetime import datetime, timezone
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

TENANT_ID = "3127f695-175f-4b63-8331-f1295a34cd51"
AUTH_URL = "https://auth.prd.vald.com/oauth/token"
FORCEDECKS_BASE = "https://prd-use-api-extforcedecks.valdperformance.com"
PROFILES_BASE = "https://prd-use-api-externalprofile.valdperformance.com"

# VALD profile-name typos -> portal-canonical spelling (mirrors dynamo_sync's
# NAME_ALIASES). Applied wherever a profile becomes an athlete name, so adding
# an entry re-canonicalizes the whole store on the next sync run.
NAME_ALIASES = {
    "Alex Rodriquez": "Alex Rodriguez",   # VALD typo (missing g), 2026-08-01
}

def profile_name(profile):
    n = f"{profile.get('givenName', '')} {profile.get('familyName', '')}".strip()
    return NAME_ALIASES.get(n, n)
TENANTS_BASE = "https://prd-use-api-externaltenants.valdperformance.com"
AUTH_AUDIENCE = "vald-api-external"
CLIENT_ID = os.environ.get("VALD_CLIENT_ID", "jOvajkmerTNoNt1wV4xrtgEizdBCt8Va")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")
TESTS_PAGE_SIZE = 50
STATE_FILE = "vald_sync_state.json"
OUTPUT_FILE = "forcedecks_portal.json"
RATE_LIMIT_PAUSE = 0.05

# ─── Portal Metrics (only these get kept) ────────────────────────────────────
# Maps result ID → { portal display name, unit, scale factor }
PORTAL_METRICS = {
    # CMJ metrics
    6553614: {"key": "jumpHeight",         "label": "Jump Height",         "unit": "in",   "scale": 1},
    # RSI-modified (Imp-Mom) — the variant RPM reads in VALD Hub, and consistent
    # with jumpHeight above (6553614 = "Jump Height (Imp-Mom) in Inches").
    # 6553698 is plain "RSI-modified" (flight-time derived) — do not use.
    # Names verified against GET /resultdefinitions (see fd_result_definitions.json).
    6553733: {"key": "rsiModified",        "label": "RSI-modified (Imp-Mom)", "unit": "m/s", "scale": 0.01},
    6553604: {"key": "relativePower",      "label": "Relative Power",      "unit": "W/kg", "scale": 1},
    # Braking slot = Eccentric Deceleration Mean Force / BW (id 6553757), a ×BW
    # multiple. Replaced Eccentric Braking RFD (6553678) 2026-07-17: RFD is a rate
    # and measured ~11% between-trial CV vs ~4% for this mean force — far steadier
    # for tracking training adaptation, and legible to parents ("braked at 1.9×BW").
    # Native to Hub (the 7340* "Takeoff" twin is empty). See rpm-portal memory.
    6553757: {"key": "brakingForceBW",     "label": "Ecc Braking Force / BW", "unit": "×BW", "scale": 1},
    6553603: {"key": "cmDepth",            "label": "Countermovement Depth", "unit": "cm", "scale": 1},  # signed (neg = deeper); context for braking
    6553712: {"key": "concentricImpulse",  "label": "Concentric Impulse",  "unit": "N·s",  "scale": 1},
    # Physicality radar additions (2026-07-23): absolute peak power, mean power
    # relative to bodymass, and early-drive impulse in the first 100ms of the
    # concentric. 6553* family = the populated CMJ ids (7340* twins are empty).
    6553633: {"key": "peakPower",          "label": "Peak Power",          "unit": "W",    "scale": 1},
    6553624: {"key": "conMeanPowerBM",     "label": "Conc Mean Power / BM","unit": "W/kg", "scale": 1},
    6553675: {"key": "conImpulse100",      "label": "Conc Impulse-100ms",  "unit": "N·s",  "scale": 1},
    6553703: {"key": "eccBrakingImpulse",  "label": "Ecc Braking Impulse", "unit": "N·s",  "scale": 1},
    6553685: {"key": "concPeakForce",      "label": "Conc Peak Force",     "unit": "N",    "scale": 1},
     655387: {"key": "bodyweightLbs",      "label": "Bodyweight",          "unit": "lbs",  "scale": 2.20462},
    # ── 2026-08-01 metric sweep: 18 pre-registered candidates (timing/velocity/
    # force-at-event/stiffness/landing/RFD). Screened vs velo residual after the
    # [refresh-cmj] backfill; verdicts in the velo-model notes. Additive only.
    6553643: {"key": "contractionTime",   "label": "Contraction Time", "unit": "ms", "scale": 1000, "trialOnly": True},
    6553657: {"key": "concDuration",      "label": "Concentric Duration", "unit": "ms", "scale": 1000, "trialOnly": True},
    6553664: {"key": "brakingPhaseDur",   "label": "Braking Phase Duration", "unit": "ms", "scale": 1000, "trialOnly": True},
    6553668: {"key": "eccDecelPhaseDur",  "label": "Ecc Deceleration Phase Duration", "unit": "s", "scale": 1, "trialOnly": True},
    6553642: {"key": "concTimeToPF",      "label": "Conc Time to Peak Force", "unit": "ms", "scale": 1000, "trialOnly": True},
    6553660: {"key": "ftCtRatio",         "label": "Flight Time:Contraction Time", "unit": "", "scale": 1, "trialOnly": True},
    6553634: {"key": "concPeakVelo",      "label": "Concentric Peak Velocity", "unit": "m/s", "scale": 1, "trialOnly": True},
    6553701: {"key": "eccPeakVelo",       "label": "Eccentric Peak Velocity", "unit": "m/s", "scale": 1, "trialOnly": True},
    6553713: {"key": "forceAtZeroV",      "label": "Force at Zero Velocity", "unit": "N", "scale": 1, "trialOnly": True},
    6553673: {"key": "forceAtPeakPower",  "label": "Force at Peak Power", "unit": "N", "scale": 1, "trialOnly": True},
    6553718: {"key": "cmjStiffness",      "label": "CMJ Stiffness", "unit": "N/m", "scale": 1, "trialOnly": True},
    6553709: {"key": "activeStiffness",   "label": "Active Stiffness", "unit": "N/m", "scale": 1, "trialOnly": True},
    6553612: {"key": "landingRfd",        "label": "Landing RFD", "unit": "N/s", "scale": 1, "trialOnly": True},
    6553647: {"key": "landingPeakForceBM", "label": "Landing Net Peak Force / BM", "unit": "N/kg", "scale": 1, "trialOnly": True},
    6553727: {"key": "landingImpulse",    "label": "Landing Impulse", "unit": "N s", "scale": 1, "trialOnly": True},
    6553768: {"key": "landingStiffness",  "label": "Landing Stiffness", "unit": "N/m", "scale": 1, "trialOnly": True},
    6553682: {"key": "eccDecelRfd",       "label": "Ecc Deceleration RFD", "unit": "N/s", "scale": 1, "trialOnly": True},
    6553641: {"key": "concMaxRfd",        "label": "Conc Maximum RFD", "unit": "N/s", "scale": 1, "trialOnly": True},
    # HJ (Hop Jump) metrics — VALD returns CT/FT in seconds, scale ×1000 to ms
    13303830: {"key": "hopMeanRsi",        "label": "Hop Mean RSI (FT/CT)","unit": "ratio","scale": 1},
    13303819: {"key": "hopRsi",            "label": "Hop RSI (FT/CT)",     "unit": "ratio","scale": 1},
    13303814: {"key": "hopContactTime",    "label": "Hop Contact Time",    "unit": "ms",   "scale": 1000},
    # ── 2026-08-01 hop sweep: 10 pre-registered HJ candidates (BestHop set-level
    # aggregates + Fatigue family). Screened vs velo residual after [refresh-hop].
    13303821: {"key": "bestActiveStiffness", "label": "Best Active Stiffness", "unit": "N/m", "scale": 1, "trialOnly": True},
    13303812: {"key": "bestLandingRfd",    "label": "Best Landing RFD",      "unit": "N/s", "scale": 1, "trialOnly": True},
    13303813: {"key": "bestTimeToPF",      "label": "Best Time to Peak Force", "unit": "ms", "scale": 1000, "trialOnly": True},
    13303817: {"key": "bestImpulse",       "label": "Best Impulse",          "unit": "N s", "scale": 1, "trialOnly": True},
    13303811: {"key": "bestAvgForce",      "label": "Best Average Force",    "unit": "N",   "scale": 1, "trialOnly": True},
    13303855: {"key": "bestPeakPower",     "label": "Best Peak Power",       "unit": "W",   "scale": 1, "trialOnly": True},
    13303816: {"key": "bestJumpHeightFT",  "label": "Best Jump Height (FT)", "unit": "cm",  "scale": 1, "trialOnly": True},
    13303841: {"key": "rsiFatigue",        "label": "RSI Fatigue",           "unit": "%",   "scale": 1, "trialOnly": True},
    13303840: {"key": "peakForceFatigue",  "label": "Peak Force Fatigue",    "unit": "%",   "scale": 1, "trialOnly": True},
    13303843: {"key": "stiffnessFatigue",  "label": "Stiffness Fatigue",     "unit": "%",   "scale": 1, "trialOnly": True},
    13303815: {"key": "hopFlightTime",     "label": "Hop Flight Time",     "unit": "ms",   "scale": 1000},
    13303818: {"key": "hopPeakForce",      "label": "Hop Peak Force",      "unit": "N",    "scale": 1},
}
PORTAL_METRIC_IDS = set(PORTAL_METRICS.keys())

# ─── PPU (Plyometric Push Up) metrics — kept ONLY on PPU tests ───────────────
# Scoped like the hop set: Flight/Contraction Time are generic Takeoff-group
# ids that also exist on jump tests, where we don't keep them. Wire units for
# the time metrics are unverified (the hop twins arrive in SECONDS despite ms
# catalog labels), so _ppu_norm() normalizes defensively instead of trusting a
# fixed scale. Ids verified against fd_result_definitions.json.
PPU_METRICS = {
    6553606: {"key": "flightTime",      "label": "Flight Time",                 "unit": "ms"},
    6553643: {"key": "contractionTime", "label": "Contraction Time",            "unit": "ms"},
    7405572: {"key": "pushUpHeight",    "label": "Push Up Height (Flight Time)","unit": "cm"},
    6553637: {"key": "conRfd",          "label": "Concentric RFD",              "unit": "N/s"},
    6553678: {"key": "eccBrakingRfd",   "label": "Eccentric Braking RFD",       "unit": "N/s"},
    7405574: {"key": "pushUpDepth",     "label": "Push Up Depth",               "unit": "cm"},
    6553686: {"key": "concPeakForceBM", "label": "Concentric Peak Force / BM",  "unit": "N/kg"},
}
PPU_METRIC_IDS = set(PPU_METRICS.keys())


def _ppu_norm(key, value):
    """Wire-unit defense for PPU metrics. Times: seconds → ms when value < 10
    (real PPU times are 100-3000 ms). Lengths: metres → cm when value < 1
    (real heights/depths are 5-60 cm). Identity when values already arrive in
    display units, so a future wire change cannot double-scale."""
    if value is None:
        return None
    if key in ("flightTime", "contractionTime") and 0 < value < 10:
        return value * 1000.0
    if key in ("pushUpHeight", "pushUpDepth") and 0 < value < 1:
        return value * 100.0
    return value

# Per-hop repeat results (Takeoff group, isRepeatResult=True). Averaging these
# over ALL hops in a set gives the WHOLE-SET mean that VALD Hub headlines.
# VALD's own "Mean RSI" (13303830) is the mean of only the best N hops, so it
# reads high (e.g. 3.04 vs the whole-set 2.86 Hub shows). CT/FT come in seconds.
HOP_REPEAT_IDS = {
    "rsi": 13303852,   # RSI (Flight/Contact Time) per hop — ratio
    "ct":  13303847,   # Contact Time per hop — seconds
    "ft":  13303848,   # Flight Time per hop — seconds
    "pf":  13303851,   # Peak Force per hop (limb "Trial" = L+R total) — N
}


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def authenticate():
    if not CLIENT_SECRET:
        print("ERROR: VALD_CLIENT_SECRET not set. Run: export VALD_CLIENT_SECRET=\"your_secret\"", flush=True)
        sys.exit(1)
    log("Authenticating with VALD...")
    resp = requests.post(AUTH_URL, json={
        "client_id": CLIENT_ID, "audience": AUTH_AUDIENCE,
        "grant_type": "client_credentials", "client_secret": CLIENT_SECRET,
    }, timeout=15)
    resp.raise_for_status()
    data = resp.json()
    log(f"Authenticated! Token valid for {data.get('expires_in', 86400) // 3600}h.")
    return data["access_token"]


def H(token):
    return {"Authorization": f"Bearer {token}"}


def fetch_groups(token):
    """Return {groupId: groupName} for all groups in this tenant."""
    log("Fetching groups...")
    resp = requests.get(f"{TENANTS_BASE}/groups",
        headers=H(token), params={"TenantId": TENANT_ID}, timeout=30)
    resp.raise_for_status()
    groups = {}
    for g in resp.json().get("groups", []):
        groups[g["id"]] = g.get("name", "")
    log(f"Total groups: {len(groups)} ({', '.join(groups.values())})")
    return groups


def fetch_profiles(token):
    log("Fetching profiles...")
    resp = requests.get(f"{PROFILES_BASE}/profiles",
        headers=H(token), params={"tenantId": TENANT_ID, "pageSize": 500}, timeout=30)
    resp.raise_for_status()
    profiles = {}
    for p in resp.json().get("profiles", []):
        profiles[p["profileId"]] = {
            "givenName": p.get("givenName", ""),
            "familyName": p.get("familyName", ""),
            "dateOfBirth": p.get("dateOfBirth"),
            "groups": [],  # populated by attach_groups_to_profiles
        }
    log(f"Total profiles: {len(profiles)}")
    return profiles


def attach_groups_to_profiles(token, profiles, groups):
    """For each group, fetch its members and tag each profile with group names.
    Modifies `profiles` in place."""
    log("Fetching group memberships...")
    for group_id, group_name in groups.items():
        time.sleep(RATE_LIMIT_PAUSE)
        resp = requests.get(f"{PROFILES_BASE}/profiles",
            headers=H(token),
            params={"tenantId": TENANT_ID, "GroupId": group_id, "pageSize": 500},
            timeout=30)
        resp.raise_for_status()
        members = resp.json().get("profiles", [])
        for p in members:
            pid = p.get("profileId")
            if pid in profiles and group_name not in profiles[pid]["groups"]:
                profiles[pid]["groups"].append(group_name)
        log(f"  {group_name}: {len(members)} members")


def fetch_tests(token, modified_from="2020-01-01T00:00:00Z"):
    log(f"Fetching tests (modified from {modified_from[:10]})...")
    all_tests = []
    cursor = modified_from
    page = 0
    while True:
        time.sleep(RATE_LIMIT_PAUSE)
        # VALD quota is 25 calls per 5s shared across endpoints; full-history
        # pagination (~350 pages) trips it under load. Back off and retry on
        # 429 instead of dying (bit both [refresh-hop] runs, 2026-08-02).
        for attempt in range(6):
            resp = requests.get(f"{FORCEDECKS_BASE}/tests", headers=H(token),
                params={"tenantId": TENANT_ID, "modifiedFromUtc": cursor}, timeout=30)
            if resp.status_code != 429:
                break
            wait = 6 + attempt * 4
            log(f"  Tests page rate-limited (429); waiting {wait}s...")
            time.sleep(wait)
        if resp.status_code == 204:
            log(f"  No new data (HTTP 204)")
            break
        if resp.status_code != 200:
            log(f"  ERROR: API returned {resp.status_code}: {resp.text[:200]}")
            resp.raise_for_status()
        try:
            tests = resp.json().get("tests", [])
        except Exception as e:
            log(f"  ERROR: Failed to parse JSON: {e}")
            log(f"  Response content: {resp.text[:300]}")
            raise
        if not tests:
            break
        all_tests.extend(tests)
        page += 1
        last_modified = tests[-1].get("modifiedDateUtc", "")
        log(f"  Tests page {page}: {len(tests)} (total: {len(all_tests)}, through {last_modified[:10]})")
        if len(tests) < TESTS_PAGE_SIZE or last_modified == cursor:
            break
        cursor = last_modified
    log(f"Total tests: {len(all_tests)}")
    return all_tests


def fetch_trials_for_test(token, test_id):
    url = f"{FORCEDECKS_BASE}/v2019q3/teams/{TENANT_ID}/tests/{test_id}/trials"
    time.sleep(RATE_LIMIT_PAUSE)
    try:
        resp = requests.get(url, headers=H(token), timeout=30)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 429:
            log("  Rate limited, waiting 5s...")
            time.sleep(5)
            resp = requests.get(url, headers=H(token), timeout=30)
            resp.raise_for_status()
            return resp.json()
        return []
    except Exception:
        return []


def fetch_trials_strict(token, test_id, tries=5):
    """Like fetch_trials_for_test but RAISES on persistent failure instead of
    returning []. Used by the CMJ refresh: a silently-empty result would make
    build_portal_data drop that CMJ test entirely (data loss). Better to fail
    the whole job — nothing gets committed — than to lose tests."""
    url = f"{FORCEDECKS_BASE}/v2019q3/teams/{TENANT_ID}/tests/{test_id}/trials"
    for attempt in range(tries):
        try:
            resp = requests.get(url, headers=H(token), timeout=30)
            if resp.status_code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt < tries - 1:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise RuntimeError(f"trials fetch failed for {test_id}: {e}")
    raise RuntimeError(f"trials fetch: 429 budget exhausted for {test_id}")


def fetch_all_trials_parallel(token, tests, workers=5):
    """Fetch trials for many tests concurrently (bounded). Any worker error
    propagates and aborts the run (strict). Modest worker count keeps VALD
    rate-limiting manageable; the 429 backoff in fetch_trials_strict absorbs
    the rest."""
    out = {}
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_trials_strict, token, t["testId"]): t["testId"]
                for t in tests}
        for f in as_completed(futs):
            out[futs[f]] = f.result()  # re-raises any worker exception
            done += 1
            if done % 250 == 0:
                log(f"  trials {done}/{len(tests)}")
    return out


def refresh_cmj():
    """Re-fetch + re-extract ONLY CMJ tests and merge them into the existing
    portal JSON, leaving Hop (HJ) / IMTP / everything else untouched. Used to
    apply a CMJ-metric change (e.g. RSI-modified → Imp-Mom variant) without a
    full 16k-test re-pull that can't finish in one CI job. RSI-modified only
    exists on CMJ tests, so this is the minimal correct scope."""
    log("=" * 50)
    log("CMJ-only refresh (re-pull trials for CMJ tests)")
    log("=" * 50)
    if not os.path.exists(OUTPUT_FILE):
        log(f"ERROR: {OUTPUT_FILE} missing — nothing to merge into.")
        sys.exit(1)
    token = authenticate()
    profiles = fetch_profiles(token)
    groups = fetch_groups(token)
    attach_groups_to_profiles(token, profiles, groups)

    all_tests = fetch_tests(token, "2020-01-01T00:00:00Z")
    cmj = [t for t in all_tests if t.get("testType") == "CMJ"]
    log(f"CMJ tests: {len(cmj)} of {len(all_tests)} total")
    if not cmj:
        log("No CMJ tests returned — aborting rather than wiping CMJ data.")
        sys.exit(1)

    trials_by_test = fetch_all_trials_parallel(token, cmj)
    log(f"Fetched trials for {len(trials_by_test)} CMJ tests.")
    new_data = build_portal_data(profiles, cmj, trials_by_test)  # CMJ-only athletes

    with open(OUTPUT_FILE) as f:
        existing = json.load(f)
    existing, stats = merge_cmj(existing, new_data)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(existing, f, separators=(',', ':'), default=str)
    log("=" * 50)
    log(f"CMJ REFRESH COMPLETE — dropped {stats['dropped']} old CMJ tests, added "
        f"{stats['added']} fresh; {stats['totalTests']} total tests across "
        f"{stats['totalAthletes']} athletes.")
    log("=" * 50)


def merge_cmj(existing, new_data):
    """Replace every athlete's CMJ tests with the freshly-built ones; leave all
    non-CMJ tests (Hop/IMTP/etc.) untouched. Pure + unit-testable."""
    ath = existing.setdefault("athletes", {})
    dropped = 0
    for a in ath.values():
        before = len(a.get("tests", []))
        a["tests"] = [t for t in a.get("tests", []) if t.get("testType") != "CMJ"]
        dropped += before - len(a["tests"])
    added = 0
    for pid, na in new_data["athletes"].items():
        if pid not in ath:
            ath[pid] = na
        else:
            ath[pid]["tests"].extend(na["tests"])
            ath[pid]["tests"].sort(key=lambda t: t.get("date", ""), reverse=True)
            ath[pid]["name"] = na.get("name") or ath[pid].get("name")
            ath[pid]["dateOfBirth"] = na.get("dateOfBirth") or ath[pid].get("dateOfBirth")
            ath[pid]["groups"] = na.get("groups") or ath[pid].get("groups")
        added += len(na["tests"])
    total_tests = sum(len(a["tests"]) for a in ath.values())
    existing["meta"] = {
        "syncDate": datetime.now(timezone.utc).isoformat(),
        "totalAthletes": len(ath),
        "totalTests": total_tests,
        "totalTrials": new_data["meta"]["totalTrials"],
    }
    return existing, {"dropped": dropped, "added": added,
                      "totalTests": total_tests, "totalAthletes": len(ath)}


def merge_ppu(existing, new_data):
    """Replace every athlete's PPU tests with the freshly-built ones; leave all
    other test types untouched. Mirrors merge_cmj. Pure + unit-testable."""
    ath = existing.setdefault("athletes", {})
    dropped = 0
    for a in ath.values():
        before = len(a.get("tests", []))
        a["tests"] = [t for t in a.get("tests", []) if t.get("testType") != "PPU"]
        dropped += before - len(a["tests"])
    added = 0
    for pid, na in new_data["athletes"].items():
        if pid not in ath:
            ath[pid] = na
        else:
            ath[pid]["tests"].extend(na["tests"])
            ath[pid]["tests"].sort(key=lambda t: t.get("date", ""), reverse=True)
            ath[pid]["name"] = na.get("name") or ath[pid].get("name")
            ath[pid]["dateOfBirth"] = na.get("dateOfBirth") or ath[pid].get("dateOfBirth")
            ath[pid]["groups"] = na.get("groups") or ath[pid].get("groups")
        added += len(na["tests"])
    total_tests = sum(len(a["tests"]) for a in ath.values())
    existing["meta"] = {
        "syncDate": datetime.now(timezone.utc).isoformat(),
        "totalAthletes": len(ath),
        "totalTests": total_tests,
        "totalTrials": new_data["meta"]["totalTrials"],
    }
    return existing, {"dropped": dropped, "added": added,
                      "totalTests": total_tests, "totalAthletes": len(ath)}


def count_legacy_ppu(existing):
    """PPU tests ingested before the 2026-07-28 metric mapping (ffdf113) lack
    flightTime/contractionTime/ppuRsi. Date-bounded so a future test that
    genuinely lacks a metric can never trigger a refetch loop."""
    stale = 0
    for a in existing.get("athletes", {}).values():
        for t in a.get("tests", []):
            if (t.get("testType") == "PPU"
                    and (t.get("date") or "")[:10] < "2026-07-28"
                    and t.get("trials")
                    and not any("flightTime" in (tr.get("metrics") or {})
                                for tr in t["trials"])):
                stale += 1
    return stale


def heal_legacy_ppu(token, profiles):
    """Self-healing PPU backfill: when legacy PPU tests are missing the new
    metrics, re-pull ONLY the PPU tests (a handful of API calls) and merge
    them in. Runs on every sync; a no-op once the store has converged."""
    if not os.path.exists(OUTPUT_FILE):
        return
    with open(OUTPUT_FILE) as f:
        existing = json.load(f)
    stale = count_legacy_ppu(existing)
    if not stale:
        return
    log(f"PPU self-heal: {stale} legacy PPU test(s) missing new metrics; re-pulling all PPU tests...")
    all_tests = fetch_tests(token, "2020-01-01T00:00:00Z")
    ppu = [t for t in all_tests if t.get("testType") == "PPU"]
    if not ppu:
        log("PPU self-heal: no PPU tests returned; skipping rather than wiping PPU data.")
        return
    trials_by_test = fetch_all_trials_parallel(token, ppu)
    new_data = build_portal_data(profiles, ppu, trials_by_test)
    with open(OUTPUT_FILE) as f:
        existing = json.load(f)
    existing, stats = merge_ppu(existing, new_data)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(existing, f, separators=(',', ':'), default=str)
    log(f"PPU self-heal complete: replaced {stats['dropped']} legacy with "
        f"{stats['added']} fresh PPU tests.")


def refresh_hop():
    """Re-fetch + re-extract ONLY HJ (hop) tests and merge into the portal JSON,
    leaving CMJ / IMTP / everything else untouched. Used to backfill the
    whole-set-mean hop fields (hopSetMean*) that match VALD Hub, without a full
    16k-test re-pull. Hop metrics only live on HJ tests — minimal correct scope."""
    log("=" * 50)
    log("HOP-only refresh (re-pull trials for HJ tests)")
    log("=" * 50)
    if not os.path.exists(OUTPUT_FILE):
        log(f"ERROR: {OUTPUT_FILE} missing — nothing to merge into.")
        sys.exit(1)
    token = authenticate()
    profiles = fetch_profiles(token)
    groups = fetch_groups(token)
    attach_groups_to_profiles(token, profiles, groups)

    all_tests = fetch_tests(token, "2020-01-01T00:00:00Z")
    hj = [t for t in all_tests if t.get("testType") == "HJ"]
    log(f"HJ tests: {len(hj)} of {len(all_tests)} total")
    if not hj:
        log("No HJ tests returned — aborting rather than wiping Hop data.")
        sys.exit(1)

    trials_by_test = fetch_all_trials_parallel(token, hj)
    log(f"Fetched trials for {len(trials_by_test)} HJ tests.")
    new_data = build_portal_data(profiles, hj, trials_by_test)  # HJ-only athletes

    with open(OUTPUT_FILE) as f:
        existing = json.load(f)
    existing, stats = merge_hop(existing, new_data)
    with open(OUTPUT_FILE, "w") as f:
        json.dump(existing, f, separators=(',', ':'), default=str)
    log("=" * 50)
    log(f"HOP REFRESH COMPLETE — dropped {stats['dropped']} old HJ tests, added "
        f"{stats['added']} fresh; {stats['totalTests']} total tests across "
        f"{stats['totalAthletes']} athletes.")
    log("=" * 50)


def merge_hop(existing, new_data):
    """Replace every athlete's HJ tests with the freshly-built ones; leave all
    non-HJ tests (CMJ/IMTP/etc.) untouched. Mirrors merge_cmj."""
    ath = existing.setdefault("athletes", {})
    dropped = 0
    for a in ath.values():
        before = len(a.get("tests", []))
        a["tests"] = [t for t in a.get("tests", []) if t.get("testType") != "HJ"]
        dropped += before - len(a["tests"])
    added = 0
    for pid, na in new_data["athletes"].items():
        if pid not in ath:
            ath[pid] = na
        else:
            ath[pid]["tests"].extend(na["tests"])
            ath[pid]["tests"].sort(key=lambda t: t.get("date", ""), reverse=True)
            ath[pid]["name"] = na.get("name") or ath[pid].get("name")
            ath[pid]["dateOfBirth"] = na.get("dateOfBirth") or ath[pid].get("dateOfBirth")
            ath[pid]["groups"] = na.get("groups") or ath[pid].get("groups")
        added += len(na["tests"])
    total_tests = sum(len(a["tests"]) for a in ath.values())
    existing["meta"] = {
        "syncDate": datetime.now(timezone.utc).isoformat(),
        "totalAthletes": len(ath),
        "totalTests": total_tests,
        "totalTrials": new_data["meta"]["totalTrials"],
    }
    return existing, {"dropped": dropped, "added": added,
                      "totalTests": total_tests, "totalAthletes": len(ath)}


def process_trial(trial, test_type=""):
    """Extract the named portal metrics (CMJ + Hop + PPU) from a trial.
    L/R limbs get Left/Right suffixes."""
    metrics = {}

    for result in trial.get("results", []):
        # Get result ID from either top level or nested definition
        result_id = result.get("resultId")
        if result_id is None:
            result_id = result.get("definition", {}).get("id")

        is_ppu_metric = test_type == "PPU" and result_id in PPU_METRIC_IDS
        if result_id not in PORTAL_METRIC_IDS and not is_ppu_metric:
            continue

        value = result.get("value")
        limb = result.get("limb", "Trial")
        meta = PPU_METRICS[result_id] if is_ppu_metric else PORTAL_METRICS[result_id]
        # Sweep metrics are screened at trial level only; skipping the
        # Left/Right/Asym variants keeps the portal JSON ~30 MB smaller
        # (GitHub rejects blobs over 100 MB — bitten 2026-08-02).
        if meta.get("trialOnly") and limb != "Trial":
            continue
        scale = meta.get("scale", 1)
        if is_ppu_metric:
            value = _ppu_norm(meta["key"], value)
        display_value = round(value * scale, 2) if value is not None else None

        key = meta["key"]
        if limb == "Left":
            key = f"{meta['key']}Left"
        elif limb == "Right":
            key = f"{meta['key']}Right"
        elif limb == "Asym":
            # Keep the asymmetry entry OUT of the bare key: VALD emits up to
            # four limb rows per result (Trial/Left/Right/Asym) and Asym comes
            # last, so it silently overwrote the Trial value for any metric
            # with limb splits. Caught 2026-07-23: Concentric Impulse-100ms
            # showed 11.4 N·s (the asym %) instead of 241.0 (the Hub value).
            key = f"{meta['key']}Asym"
        elif limb not in (None, "Trial"):
            # Same overwrite class, generalized (2026-07-28): any limb label we
            # don't recognize gets suffixed so it can never clobber the Trial
            # total. Bare key stays reserved for Trial/None rows only.
            key = f"{meta['key']}{limb}"

        metrics[key] = display_value

    # RPM-computed PPU reactive ratio: VALD defines no RSI metric for the PPU
    # test type (confirmed in Hub, 2026-07-28), so we derive flight/contraction
    # ourselves. Label as RPM-computed anywhere athlete-facing.
    if test_type == "PPU":
        ft, ct = metrics.get("flightTime"), metrics.get("contractionTime")
        if ft and ct:
            metrics["ppuRsi"] = round(ft / ct, 3)

    # Whole-set hop means: average every hop in this set (matches VALD Hub).
    # Unlike the best-N means above, this includes the athlete's weaker hops.
    perhop = {k: [] for k in HOP_REPEAT_IDS}
    for result in trial.get("results", []):
        rid = result.get("resultId")
        if rid is None:
            rid = result.get("definition", {}).get("id")
        if result.get("limb") not in (None, "Trial"):
            continue  # per-hop L/R splits — the "Trial" value is the L+R total
        v = result.get("value")
        if v is None:
            continue
        for k, want in HOP_REPEAT_IDS.items():
            if rid == want:
                perhop[k].append(v)
    if perhop["rsi"]:
        _mean = lambda xs: sum(xs) / len(xs)
        metrics["hopSetHops"] = len(perhop["rsi"])
        metrics["hopSetMeanRsi"] = round(_mean(perhop["rsi"]), 2)
        if perhop["ct"]:
            metrics["hopSetMeanCt"] = round(_mean(perhop["ct"]) * 1000, 2)  # s → ms
        if perhop["ft"]:
            metrics["hopSetMeanFt"] = round(_mean(perhop["ft"]) * 1000, 2)  # s → ms
        if perhop["pf"]:
            metrics["hopSetMeanPeakForce"] = round(_mean(perhop["pf"]), 2)   # N (L+R)

    # Calculate asymmetry percentages for L/R metrics
    for base_key in ["concentricImpulse", "eccBrakingImpulse", "concPeakForce"]:
        left = metrics.get(f"{base_key}Left")
        right = metrics.get(f"{base_key}Right")
        if left is not None and right is not None and (left + right) > 0:
            asym_pct = round(abs(right - left) / max(left, right) * 100, 1)
            dominant = "R" if right > left else "L" if left > right else "="
            metrics[f"{base_key}Asym"] = asym_pct
            metrics[f"{base_key}Dominant"] = dominant

    return metrics


def build_portal_data(profiles, tests, trials_by_test):
    athletes = defaultdict(lambda: {"name": "", "dateOfBirth": None, "groups": [], "tests": []})
    total_trials = 0

    for test in tests:
        pid = test["profileId"]
        tid = test["testId"]
        profile = profiles.get(pid, {})
        ath = athletes[pid]
        ath["name"] = profile_name(profile)
        ath["dateOfBirth"] = profile.get("dateOfBirth")
        ath["groups"] = profile.get("groups", [])

        raw_trials = trials_by_test.get(tid, [])
        trials = []
        for t in raw_trials:
            metrics = process_trial(t, test_type=test.get("testType", ""))
            if metrics:  # only keep trials that have at least one portal metric
                trials.append({
                    "limb": t.get("limb", ""),
                    "metrics": metrics,
                })
                total_trials += 1

        if trials:
            ath["tests"].append({
                "testType": test.get("testType", ""),
                "date": test.get("recordedDateUtc", ""),
                "weight": test.get("weight"),
                "trials": trials,
            })

    # Sort each athlete's tests by date (newest first)
    for ath in athletes.values():
        ath["tests"].sort(key=lambda t: t["date"], reverse=True)

    return {
        "meta": {
            "syncDate": datetime.now(timezone.utc).isoformat(),
            "totalAthletes": len(athletes),
            "totalTests": len(tests),
            "totalTrials": total_trials,
        },
        "athletes": dict(athletes),
    }


def load_sync_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f).get("lastModifiedUtc", "2020-01-01T00:00:00Z")
    except (FileNotFoundError, json.JSONDecodeError):
        return "2020-01-01T00:00:00Z"


def save_sync_state(last_modified):
    with open(STATE_FILE, "w") as f:
        json.dump({"lastModifiedUtc": last_modified,
                    "lastSyncDate": datetime.now(timezone.utc).isoformat()}, f, indent=2)


def main():
    if "--refresh-cmj" in sys.argv:
        return refresh_cmj()
    if "--refresh-hop" in sys.argv:
        return refresh_hop()
    full_sync = "--full" in sys.argv
    log("=" * 50)
    log("VALD ForceDecks → RPM Portal Sync")
    log("=" * 50)
    token = authenticate()
    profiles = fetch_profiles(token)
    groups = fetch_groups(token)
    attach_groups_to_profiles(token, profiles, groups)
    # Runs before the no-new-tests early return so convergence never waits on
    # unrelated test activity. Failure here must never sink the main sync.
    try:
        heal_legacy_ppu(token, profiles)
    except Exception as ex:
        log(f"PPU self-heal skipped ({ex}); will retry next sync.")
    modified_from = "2020-01-01T00:00:00Z" if full_sync else load_sync_state()
    if full_sync:
        log("Full sync requested.")
    else:
        log(f"Incremental sync from {modified_from[:10]}")
    tests = fetch_tests(token, modified_from)
    if not tests:
        log("No new tests. Done.")
        return
    # Load existing portal data to skip already-processed tests
    existing_test_ids = set()
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE) as f:
                existing = json.load(f)
            for ath in existing.get("athletes", {}).values():
                for t in ath.get("tests", []):
                    for tr in t.get("trials", []):
                        existing_test_ids.add(t.get("date", ""))
        except Exception:
            pass

    # Only fetch trials for tests we haven't processed yet
    tests_needing_trials = [t for t in tests if t.get("testId") not in existing_test_ids]
    log(f"Fetching trials for {len(tests_needing_trials)} new tests (skipping {len(tests) - len(tests_needing_trials)} cached)...")
    trials_by_test = {}

    # For existing tests, try to reuse trial data from portal JSON
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE) as f:
                existing = json.load(f)
            for ath in existing.get("athletes", {}).values():
                for t in ath.get("tests", []):
                    # Store existing trial data keyed by date+type as a fallback
                    pass
        except Exception:
            pass

    for i, test in enumerate(tests_needing_trials):
        trials = fetch_trials_for_test(token, test["testId"])
        trials_by_test[test["testId"]] = trials if isinstance(trials, list) else []
        if (i + 1) % 50 == 0:
            log(f"  Progress: {i + 1}/{len(tests_needing_trials)} tests")
    log(f"All {len(tests_needing_trials)} new tests processed.")

    # For tests we didn't fetch trials for, add empty trials
    for test in tests:
        if test["testId"] not in trials_by_test:
            trials_by_test[test["testId"]] = []
    log("Building portal data (8 metrics only)...")
    new_portal_data = build_portal_data(profiles, tests, trials_by_test)

    # Merge with existing data on incremental syncs
    if not full_sync and os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE) as f:
                existing = json.load(f)
            existing_athletes = existing.get("athletes", {})
            new_athletes = new_portal_data.get("athletes", {})
            log(f"Merging {len(new_athletes)} updated athletes into {len(existing_athletes)} existing...")
            for pid, ath in new_athletes.items():
                if pid in existing_athletes:
                    # Merge new tests into existing athlete
                    existing_dates = {t["date"] for t in existing_athletes[pid]["tests"]}
                    for t in ath["tests"]:
                        if t["date"] not in existing_dates:
                            existing_athletes[pid]["tests"].append(t)
                    existing_athletes[pid]["tests"].sort(key=lambda t: t["date"], reverse=True)
                    # Update name/DOB/groups in case they changed
                    existing_athletes[pid]["name"] = ath["name"]
                    existing_athletes[pid]["dateOfBirth"] = ath["dateOfBirth"]
                    existing_athletes[pid]["groups"] = ath["groups"]
                else:
                    existing_athletes[pid] = ath
            # Refresh groups for athletes who had no new tests this sync
            # (catches group changes in VALD even without test activity)
            for pid, profile in profiles.items():
                if pid in existing_athletes and pid not in new_athletes:
                    existing_athletes[pid]["groups"] = profile.get("groups", [])
                    existing_athletes[pid]["name"] = profile_name(profile) or existing_athletes[pid]["name"]
            total_tests = sum(len(a["tests"]) for a in existing_athletes.values())
            portal_data = {
                "meta": {
                    "syncDate": new_portal_data["meta"]["syncDate"],
                    "totalAthletes": len(existing_athletes),
                    "totalTests": total_tests,
                    "totalTrials": new_portal_data["meta"]["totalTrials"],
                },
                "athletes": existing_athletes,
            }
            log(f"Merged: {len(existing_athletes)} athletes, {total_tests} tests")
        except (json.JSONDecodeError, KeyError) as e:
            log(f"WARNING: Could not merge with existing data ({e}), using new data only")
            portal_data = new_portal_data
    else:
        portal_data = new_portal_data

    with open(OUTPUT_FILE, "w") as f:
        json.dump(portal_data, f, separators=(',', ':'), default=str)
    file_size_mb = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    log(f"Output: {OUTPUT_FILE} ({file_size_mb:.1f} MB)")
    if tests:
        save_sync_state(max(t.get("modifiedDateUtc", "") for t in tests))
    m = portal_data["meta"]
    log("=" * 50)
    log("SYNC COMPLETE!")
    log(f"  Athletes: {m['totalAthletes']}")
    log(f"  Tests:    {m['totalTests']}")
    log(f"  Trials:   {m['totalTrials']}")
    log(f"  Output:   {OUTPUT_FILE} ({file_size_mb:.1f} MB)")
    log("=" * 50)


if __name__ == "__main__":
    main()

# sync trigger 2026-07-15 — pull Sam Unger 5th session

# sync trigger 2026-07-15 15:45 — pull Pete Hansen / Cade Winquest CMJ

# sync trigger 2026-07-30 — pull new PPU + trunk rotation tests

# sync trigger 2026-07-30 pm — pull new VALD Hub data

# refresh-hop reproduce trigger 2026-08-02

# hop re-pull after source-verified deletions 2026-08-02

# slim cmj re-pull (drop stored limb variants) 2026-08-02
