#!/usr/bin/env python3
"""
VALD DynaMo → dynamo_portal.json  (staff-only shoulder-strength page)

Mirrors vald_sync.py (ForceDecks) but targets the External DynaMo API. Produces
dynamo_portal.json, which generate_portal_data.py splices into the portal as the
_DYNAMO array behind the #dynamo password gate.

────────────────────────────────────────────────────────────────────────────
⚠️  VALIDATION STATUS — read before trusting output
────────────────────────────────────────────────────────────────────────────
The auth flow is identical to vald_sync.py (known-good). Two things could NOT be
verified from this machine because VALD_CLIENT_SECRET only exists in CI and
VALD's API docs are auth-walled:

  1. DYNAMO_BASE — the regional base URL. Set to the ForceDecks pattern
     (prd-use-api-extdynamo…). If a run 404s on /tests, try the alternates
     listed below (DYNAMO_BASE_ALTS) — the first successful one is the right one.
  2. RESULT FIELD NAMES — how peak force / RFD / time-to-peak per side are keyed
     inside each test's result payload. Run with `--debug` to dump the raw API
     response to dynamo_raw_debug.json, then confirm RESULT_KEYS below.

Run `python3 dynamo_sync.py --debug` once (in CI, where the secret lives) and
inspect dynamo_raw_debug.json before enabling the scheduled workflow.

NOTE ON ANNOTATIONS: the VALD API supplies the NUMBERS only. Test position
("Supine, 90/90"), the DISCOMFORT flags, the ER:IR interpretation, and the
narrative discomfort/plan notes are RPM-added context, not VALD fields. Position
is inferred from the DynaMo test/movement name (MOVEMENT_MAP). Discomfort flags
and narrative come from an optional per-test annotation file
(dynamo_annotations.json) if present — otherwise those fields are left empty and
can be filled in by hand, exactly like the seeded Jason Peacock baseline.
────────────────────────────────────────────────────────────────────────────

Usage:
    export VALD_CLIENT_SECRET="…"
    python3 dynamo_sync.py            # incremental, writes dynamo_portal.json
    python3 dynamo_sync.py --full     # re-pull everything
    python3 dynamo_sync.py --debug    # dump raw API responses for schema check
"""
import warnings
warnings.filterwarnings("ignore")

import os, sys, json, time, requests
from datetime import datetime, timezone
from collections import defaultdict

# ─── Config (shared with vald_sync.py) ───────────────────────────────────────
TENANT_ID     = os.environ.get("VALD_TENANT_ID", "3127f695-175f-4b63-8331-f1295a34cd51")
AUTH_URL      = "https://auth.prd.vald.com/oauth/token"
AUTH_AUDIENCE = "vald-api-external"
CLIENT_ID     = os.environ.get("VALD_CLIENT_ID", "jOvajkmerTNoNt1wV4xrtgEizdBCt8Va")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")
PROFILES_BASE = "https://prd-use-api-externalprofile.valdperformance.com"

# Primary regional DynaMo base (ForceDecks uses prd-use-api-extforcedecks).
DYNAMO_BASE      = os.environ.get("VALD_DYNAMO_BASE", "https://prd-use-api-extdynamo.valdperformance.com")
# Fallbacks to try if the primary 404s — see VALIDATION STATUS above.
DYNAMO_BASE_ALTS = [
    "https://prd-use-api-externaldynamo.valdperformance.com",
    "https://dynamoextapi.valdperformance.com",
]

OUTPUT_FILE      = "dynamo_portal.json"
ANNOTATIONS_FILE = "dynamo_annotations.json"
STATE_FILE       = "dynamo_sync_state.json"
RATE_LIMIT_PAUSE = 0.05

# ─── Movement metadata (position/order — API gives names, not positions) ─────
# Maps the DynaMo test/movement name (lowercased, loose match) → portal display
# name + test position. Extend as new protocols are used.
MOVEMENT_MAP = [
    ("external rot",  "External Rotation",    "Supine, 90/90"),
    ("internal rot",  "Internal Rotation",    "Supine, 90/90"),
    ("scaption",      "Scaption (Abduction)", "Supine"),
    ("abduction",     "Scaption (Abduction)", "Supine"),
    ("flexion",       "Shoulder Flexion",     "Supine, long lever"),
    ("extension",     "Shoulder Extension",   "Prone, long lever"),
]
MOVEMENT_ORDER = ["Shoulder Flexion", "Shoulder Extension", "Scaption (Abduction)",
                  "External Rotation", "Internal Rotation"]

# Candidate field names inside a test/repetition result for each metric. The
# parser takes the first key that is present. Confirm against --debug output.
RESULT_KEYS = {
    "peak":  ["peakForce", "peakForceN", "peakForceNewtons", "maxForce", "peak"],
    "rfd":   ["rfd", "rateOfForceDevelopment", "rfdMax", "peakRfd"],
    "ttp":   ["timeToPeakForce", "timeToPeak", "timeToPeakForceSeconds", "ttp"],
}
N_PER_LB = 4.44822

# ─── Helpers ─────────────────────────────────────────────────────────────────
def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)

def authenticate():
    if not CLIENT_SECRET:
        log("ERROR: VALD_CLIENT_SECRET not set. export VALD_CLIENT_SECRET=…")
        sys.exit(1)
    log("Authenticating with VALD…")
    resp = requests.post(AUTH_URL, json={
        "client_id": CLIENT_ID, "audience": AUTH_AUDIENCE,
        "grant_type": "client_credentials", "client_secret": CLIENT_SECRET,
    }, timeout=15)
    resp.raise_for_status()
    log("Authenticated.")
    return resp.json()["access_token"]

def H(token):
    return {"Authorization": f"Bearer {token}"}

def resolve_base(token):
    """Return the first DynaMo base URL that answers /tests, else None."""
    for base in [DYNAMO_BASE] + DYNAMO_BASE_ALTS:
        try:
            r = requests.get(f"{base}/tests", headers=H(token),
                             params={"TenantId": TENANT_ID,
                                     "modifiedFromUtc": "2020-01-01T00:00:00Z"},
                             timeout=20)
            if r.status_code in (200, 204):
                log(f"DynaMo base: {base} (HTTP {r.status_code})")
                return base
            log(f"  {base} → HTTP {r.status_code}")
        except requests.RequestException as e:
            log(f"  {base} → {e.__class__.__name__}")
    return None

def fetch_profiles(token):
    resp = requests.get(f"{PROFILES_BASE}/profiles",
        headers=H(token), params={"tenantId": TENANT_ID, "pageSize": 500}, timeout=30)
    resp.raise_for_status()
    out = {}
    for p in resp.json().get("profiles", []):
        out[p["profileId"]] = {
            "name": f"{p.get('givenName','')} {p.get('familyName','')}".strip(),
            "dob": p.get("dateOfBirth"),
        }
    log(f"Profiles: {len(out)}")
    return out

def fetch_tests(token, base, modified_from):
    log(f"Fetching DynaMo tests (from {modified_from[:10]})…")
    tests, cursor = [], modified_from
    while True:
        time.sleep(RATE_LIMIT_PAUSE)
        r = requests.get(f"{base}/tests", headers=H(token),
                         params={"TenantId": TENANT_ID, "modifiedFromUtc": cursor}, timeout=30)
        if r.status_code == 204:
            break
        r.raise_for_status()
        page = r.json().get("tests", [])
        if not page:
            break
        tests.extend(page)
        last = page[-1].get("modifiedDateUtc", "")
        log(f"  +{len(page)} (total {len(tests)}, through {last[:10]})")
        if len(page) < 50 or last == cursor:
            break
        cursor = last
    log(f"Total DynaMo tests: {len(tests)}")
    return tests

def fetch_test_detail(token, base, test_id):
    time.sleep(RATE_LIMIT_PAUSE)
    r = requests.get(f"{base}/tests/{test_id}", headers=H(token),
                     params={"TenantId": TENANT_ID}, timeout=30)
    if r.status_code != 200:
        return None
    return r.json()

def _first(d, keys):
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d[k]
    return None

def _side_summary(detail, side):
    """Pull the repetitionTypeSummaries entry for LeftSide/RightSide."""
    for s in (detail.get("repetitionTypeSummaries") or detail.get("results") or []):
        tag = str(s.get("repetitionType") or s.get("limb") or s.get("side") or "").lower()
        if side.lower() in tag:
            return s
    return None

def map_movement(name):
    low = (name or "").lower()
    for needle, disp, pos in MOVEMENT_MAP:
        if needle in low:
            return disp, pos
    return name or "Unknown", ""

def build_portal(profiles, tests, details, annotations):
    """Group DynaMo tests into per-athlete, per-date sessions of 5 movements."""
    sessions = defaultdict(lambda: defaultdict(list))  # pid -> date -> [movement,…]
    for t in tests:
        pid = t.get("profileId")
        tid = t.get("testId")
        detail = details.get(tid)
        if not detail:
            continue
        date = (t.get("recordedDateUtc") or t.get("modifiedDateUtc") or "")[:10]
        disp, pos = map_movement(t.get("testType") or detail.get("testType") or detail.get("name"))
        left, right = _side_summary(detail, "Left"), _side_summary(detail, "Right")
        def val(side, key):
            return _first(side or {}, RESULT_KEYS[key])
        pkL, pkR = val(left, "peak"), val(right, "peak")
        if pkL is None and pkR is None:
            continue
        asym = None
        if pkL and pkR and max(pkL, pkR) > 0:
            asym = round(abs(pkR - pkL) / max(pkL, pkR) * 100, 1)
        note = "Symmetric" if (asym is not None and asym < 10) else \
               ("right side stronger" if (pkR or 0) > (pkL or 0) else "left side stronger")
        sessions[pid][date].append({
            "name": disp, "position": pos, "discomfort": False,
            "peakN": [round(pkL, 1) if pkL else None, round(pkR, 1) if pkR else None],
            "peakLbs": [round(pkL / N_PER_LB, 1) if pkL else None,
                        round(pkR / N_PER_LB, 1) if pkR else None],
            "asymPct": asym, "asymNote": note,
            "rfd": [round(val(left, "rfd")) if val(left, "rfd") else None,
                    round(val(right, "rfd")) if val(right, "rfd") else None],
            "ttp": [round(val(left, "ttp"), 2) if val(left, "ttp") else None,
                    round(val(right, "ttp"), 2) if val(right, "ttp") else None],
        })

    athletes = {}
    for pid, by_date in sessions.items():
        prof = profiles.get(pid, {})
        name = prof.get("name") or pid
        tests_out = []
        for date, movements in sorted(by_date.items(), reverse=True):
            movements.sort(key=lambda m: MOVEMENT_ORDER.index(m["name"])
                           if m["name"] in MOVEMENT_ORDER else 99)
            ann = (annotations.get(name, {}) or {}).get(date, {})
            for m in movements:
                if m["name"] in ann.get("discomfort", []):
                    m["discomfort"] = True
            erL = erR = None
            er = next((m for m in movements if m["name"] == "External Rotation"), None)
            ir = next((m for m in movements if m["name"] == "Internal Rotation"), None)
            if er and ir and er["peakN"][0] and ir["peakN"][0]:
                erL = round(er["peakN"][0] / ir["peakN"][0], 2)
            if er and ir and er["peakN"][1] and ir["peakN"][1]:
                erR = round(er["peakN"][1] / ir["peakN"][1], 2)
            tests_out.append({
                "date": date,
                "type": ann.get("type", "Shoulder Strength Baseline"),
                "label": ann.get("label", "Assessment"),
                "movements": movements,
                "erIr": {"left": erL, "right": erR},
                "discomfortNote": ann.get("discomfortNote", ""),
                "planNote": ann.get("planNote", ""),
            })
        athletes[name] = {"name": name, "group": prof.get("group", "hs"),
                          "dob": prof.get("dob"), "tests": tests_out}
    return {
        "meta": {"syncDate": datetime.now(timezone.utc).isoformat(),
                 "source": "VALD DynaMo", "totalAthletes": len(athletes)},
        "athletes": athletes,
    }

def load_state():
    try:
        return json.load(open(STATE_FILE)).get("lastModifiedUtc", "2020-01-01T00:00:00Z")
    except (FileNotFoundError, json.JSONDecodeError):
        return "2020-01-01T00:00:00Z"

def main():
    full  = "--full" in sys.argv
    debug = "--debug" in sys.argv
    token = authenticate()
    base = resolve_base(token)
    if not base:
        log("ERROR: no DynaMo base URL answered /tests. Check VALD_DYNAMO_BASE / DynaMo API access.")
        sys.exit(1)

    profiles = fetch_profiles(token)
    modified_from = "2020-01-01T00:00:00Z" if full else load_state()
    tests = fetch_tests(token, base, modified_from)
    if not tests:
        log("No new DynaMo tests. Done.")
        return

    details = {}
    for i, t in enumerate(tests):
        d = fetch_test_detail(token, base, t.get("testId"))
        if d:
            details[t["testId"]] = d
        if (i + 1) % 25 == 0:
            log(f"  detail {i+1}/{len(tests)}")

    if debug:
        sample = tests[0] if tests else {}
        raw = {"sample_test_list_item": sample,
               "sample_test_detail": details.get(sample.get("testId"))}
        json.dump(raw, open("dynamo_raw_debug.json", "w"), indent=2, default=str)
        log("Wrote dynamo_raw_debug.json — inspect field names, then confirm RESULT_KEYS.")

    annotations = {}
    if os.path.exists(ANNOTATIONS_FILE):
        try:
            annotations = json.load(open(ANNOTATIONS_FILE))
        except Exception:
            pass

    data = build_portal(profiles, tests, details, annotations)
    json.dump(data, open(OUTPUT_FILE, "w"), indent=2, default=str)
    json.dump({"lastModifiedUtc": max(t.get("modifiedDateUtc", "") for t in tests),
               "lastSyncDate": datetime.now(timezone.utc).isoformat()},
              open(STATE_FILE, "w"), indent=2)
    log(f"Wrote {OUTPUT_FILE}: {data['meta']['totalAthletes']} athletes")

if __name__ == "__main__":
    main()
