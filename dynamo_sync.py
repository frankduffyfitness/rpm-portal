#!/usr/bin/env python3
"""
VALD DynaMo → dynamo_portal.json  (staff-only shoulder-strength page)

Mirrors vald_sync.py (ForceDecks) auth; targets the External DynaMo API.
Produces dynamo_portal.json, which generate_portal_data.py splices into the
portal as the _DYNAMO array behind the #dynamo password gate.

API contract verified 2026-07-14 against the LIVE public Swagger spec at
https://prd-use-api-extdynamo.valdperformance.com/swagger/v1/swagger.json :

  GET /v2022q2/teams/{teamId}/tests
      ?modifiedFromUTC=…&includeRepSummaries=true&page=N
      → PagedDTO { items: TestDTO[], currentPage, totalItems, totalPages }

  TestDTO: id, athleteId, teamId, testCategory (Strength|RangeofMotion),
      bodyRegion (Shoulder|Hip|…), movement (Flexion|Extension|Scaption|
      ExternalRotation|InternalRotation|…), position (SupineLongLever|
      ProneLongLever|Supine|SupineElbow90Degrees90DegreeShoulderAbduction|…),
      customPosition, laterality (LeftSide|RightSide|LeftThenRight|
      RightThenLeft|None), startTimeUTC, repetitionTypeSummaries[],
      asymmetries[{movement, valuePercentage}], ratios[{laterality,
      numeratorMovement, denominatorMovement, value}]

  RepetitionTypeSummaryDTO: movement, laterality, repCount, maxForceNewtons,
      maxRateOfForceDevelopmentNewtonsPerSecond, avgTimeToPeakForceSeconds, …

Aggregate choices (documented so re-tests compare like-for-like):
  peak force     = maxForceNewtons                 (best rep)
  RFD            = maxRateOfForceDevelopmentNewtonsPerSecond (best rep)
  time-to-peak   = avgTimeToPeakForceSeconds       (typical response)

VALD supplies the NUMBERS. Discomfort flags and the narrative discomfort/plan
notes are RPM-added context, merged from dynamo_annotations.json when present:
  { "<Athlete Name>": { "<YYYY-MM-DD>": {
        "type": "...", "label": "...", "discomfort": ["Shoulder Flexion", …],
        "discomfortNote": "...", "planNote": "..." } } }

Usage:
    export VALD_CLIENT_SECRET="…"
    python3 dynamo_sync.py            # incremental
    python3 dynamo_sync.py --full     # re-pull everything
"""
import warnings
warnings.filterwarnings("ignore")

import os, sys, json, time, re, requests
from datetime import datetime, timezone
from collections import defaultdict
from zoneinfo import ZoneInfo

# ─── Config (shared with vald_sync.py) ───────────────────────────────────────
TENANT_ID     = os.environ.get("VALD_TENANT_ID", "3127f695-175f-4b63-8331-f1295a34cd51")
AUTH_URL      = "https://auth.prd.vald.com/oauth/token"
AUTH_AUDIENCE = "vald-api-external"
CLIENT_ID     = os.environ.get("VALD_CLIENT_ID", "jOvajkmerTNoNt1wV4xrtgEizdBCt8Va")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")
PROFILES_BASE = "https://prd-use-api-externalprofile.valdperformance.com"
TENANTS_BASE  = "https://prd-use-api-externaltenants.valdperformance.com"
DYNAMO_BASE   = os.environ.get("VALD_DYNAMO_BASE",
                               "https://prd-use-api-extdynamo.valdperformance.com")

OUTPUT_FILE      = "dynamo_portal.json"
ANNOTATIONS_FILE = "dynamo_annotations.json"
STATE_FILE       = "dynamo_sync_state.json"
RATE_LIMIT_PAUSE = 0.05
LOCAL_TZ         = ZoneInfo("America/New_York")   # session date = RPM local date

# VALD group names → portal short codes (mirror of generate_portal_data.py)
VALD_GROUP_TO_CODE = {
    "Pro": "pro", "Staff": "stf", "College": "col", "High School": "hs",
    "Middle School": "ms", "Men's League": "ml", "Female Athletes": "fem",
}
GROUP_PRIORITY = ["pro", "stf", "col", "ml", "hs", "ms", "fem"]

N_PER_LB = 4.44822


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def authenticate():
    if not CLIENT_SECRET:
        log("ERROR: VALD_CLIENT_SECRET not set.")
        sys.exit(1)
    r = requests.post(AUTH_URL, json={
        "client_id": CLIENT_ID, "audience": AUTH_AUDIENCE,
        "grant_type": "client_credentials", "client_secret": CLIENT_SECRET,
    }, timeout=20)
    r.raise_for_status()
    log("Authenticated with VALD.")
    return r.json()["access_token"]


def H(token):
    return {"Authorization": f"Bearer {token}"}


def get_with_retry(url, token, params=None, tries=4, timeout=30):
    """GET with backoff on 429/5xx/network errors — transient VALD hiccups
    should not kill a whole CI sync run."""
    for attempt in range(tries):
        try:
            r = requests.get(url, headers=H(token), params=params, timeout=timeout)
            if r.status_code in (429, 500, 502, 503, 504) and attempt < tries - 1:
                wait = 3 * (attempt + 1)
                log(f"  HTTP {r.status_code} from {url.split('.com')[0]}…, retrying in {wait}s")
                time.sleep(wait)
                continue
            return r
        except requests.RequestException as e:
            if attempt < tries - 1:
                wait = 3 * (attempt + 1)
                log(f"  {e.__class__.__name__}, retrying in {wait}s")
                time.sleep(wait)
                continue
            raise


# ─── Profiles + groups (same endpoints as vald_sync.py) ──────────────────────
def fetch_profiles_with_groups(token):
    r = get_with_retry(f"{PROFILES_BASE}/profiles", token,
                       params={"tenantId": TENANT_ID, "pageSize": 500})
    r.raise_for_status()
    profiles = {}
    for p in r.json().get("profiles", []):
        profiles[p["profileId"]] = {
            "name": f"{p.get('givenName','')} {p.get('familyName','')}".strip(),
            "dob": (p.get("dateOfBirth") or "")[:10] or None,
            "groups": [],
        }
    gr = get_with_retry(f"{TENANTS_BASE}/groups", token,
                        params={"TenantId": TENANT_ID})
    if gr.status_code == 200:
        for g in gr.json().get("groups", []):
            time.sleep(RATE_LIMIT_PAUSE)
            mr = get_with_retry(f"{PROFILES_BASE}/profiles", token,
                                params={"tenantId": TENANT_ID, "GroupId": g["id"],
                                        "pageSize": 500})
            if mr.status_code != 200:
                continue
            for p in mr.json().get("profiles", []):
                if p.get("profileId") in profiles:
                    profiles[p["profileId"]]["groups"].append(g.get("name", ""))
    log(f"Profiles: {len(profiles)}")
    return profiles


def group_code(vald_groups):
    codes = {VALD_GROUP_TO_CODE[g] for g in (vald_groups or []) if g in VALD_GROUP_TO_CODE}
    for c in GROUP_PRIORITY:
        if c in codes:
            return c
    return "hs"


# ─── DynaMo tests ─────────────────────────────────────────────────────────────
def fetch_dynamo_tests(token, modified_from):
    """Paged fetch with rep summaries inline. Returns TestDTO list."""
    log(f"Fetching DynaMo tests (modified from {modified_from[:10]})…")
    tests, page = [], 1
    while True:
        time.sleep(RATE_LIMIT_PAUSE)
        r = get_with_retry(f"{DYNAMO_BASE}/v2022q2/teams/{TENANT_ID}/tests",
                           token,
                           params={"modifiedFromUTC": modified_from,
                                   "includeRepSummaries": "true",
                                   "page": page})
        if r.status_code == 204:
            break
        r.raise_for_status()
        body = r.json()
        items = body.get("items", [])
        tests.extend(items)
        total_pages = body.get("totalPages", 1)
        log(f"  page {page}/{total_pages}: +{len(items)} (total {len(tests)})")
        if page >= total_pages or not items:
            break
        page += 1
    log(f"Total DynaMo tests: {len(tests)}")
    return tests


# ─── Display mapping ─────────────────────────────────────────────────────────
def _decamel(s):
    out = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s or "").strip()
    out = re.sub(r"^p(\d+) Degrees?", r"\1°", out)      # p90DegreesX -> 90° X
    out = re.sub(r"(\d+) Degrees?", r"\1°", out)         # …90 Degrees… -> 90°
    return out

MOVEMENT_DISPLAY = {
    "Flexion":          "Shoulder Flexion",       # shoulder context
    "Extension":        "Shoulder Extension",
    "Scaption":         "Scaption (Abduction)",
    "ExternalRotation": "External Rotation",
    "InternalRotation": "Internal Rotation",
}
# Core RPM screen (ER/IR + grip) sorts first; rehab/RTP movements follow.
MOVEMENT_ORDER = ["External Rotation", "Internal Rotation", "Grip Squeeze",
                  "Shoulder Flexion", "Shoulder Extension", "Scaption (Abduction)"]

POSITION_DISPLAY = {
    "SupineLongLever":  "Supine, long lever",
    "SupineShortLever": "Supine, short lever",
    "ProneLongLever":   "Prone, long lever",
    "ProneShortLever":  "Prone, short lever",
    "Supine":           "Supine",
    "Prone":            "Prone",
    "SupineElbow90Degrees90DegreeShoulderAbduction": "Supine, 90/90",
    "SeatedElbow90Degrees90DegreeShoulderAbduction": "Seated, 90/90",
    "StandingElbow90Degrees90DegreeShoulderAbduction": "Standing, 90/90",
}

def movement_display(mv, body_region):
    if mv in MOVEMENT_DISPLAY:
        # only prefix "Shoulder" when it IS the shoulder
        if mv in ("Flexion", "Extension") and body_region != "Shoulder":
            return f"{body_region} {_decamel(mv)}".strip()
        return MOVEMENT_DISPLAY[mv]
    return _decamel(mv)

def position_display(pos, custom):
    if custom:
        return custom
    return POSITION_DISPLAY.get(pos, _decamel(pos))


# ─── Build portal data ───────────────────────────────────────────────────────
def _side(summaries, movement, side):
    for s in summaries or []:
        if s.get("laterality") == side and (movement is None or s.get("movement") == movement):
            return s
    return None


def build_portal(profiles, tests, annotations):
    # Group tests by (athlete, local session date); each test = one movement.
    sessions = defaultdict(lambda: defaultdict(list))
    for t in tests:
        if t.get("testCategory") not in (None, "Strength"):
            continue  # skip pure range-of-motion tests for this page
        aid = t.get("athleteId")
        start = t.get("startTimeUTC") or ""
        try:
            dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            date = dt.astimezone(LOCAL_TZ).date().isoformat()
        except ValueError:
            date = start[:10]
        summaries = t.get("repetitionTypeSummaries") or []
        movements = {s.get("movement") for s in summaries} or {t.get("movement")}
        for mv in movements:
            L = _side(summaries, mv, "LeftSide")
            R = _side(summaries, mv, "RightSide")
            if not L and not R:
                # unilateral test with laterality None — treat as single side
                both = _side(summaries, mv, "None")
                if not both:
                    continue
                L = R = both
            pkL = (L or {}).get("maxForceNewtons")
            pkR = (R or {}).get("maxForceNewtons")
            if pkL is None and pkR is None:
                continue
            # asymmetry: prefer VALD's own computation on the test
            asym = None
            for a in t.get("asymmetries") or []:
                if a.get("movement") == mv and a.get("valuePercentage") is not None:
                    asym = round(abs(a["valuePercentage"]), 1)
                    break
            if asym is None and pkL and pkR and max(pkL, pkR) > 0:
                asym = round(abs(pkR - pkL) / max(pkL, pkR) * 100, 1)
            if pkL is None or pkR is None:
                note = ""          # unilateral test — no L/R comparison
            elif asym is not None and asym < 10:
                note = "Symmetric"
            else:
                note = "right side stronger" if pkR >= pkL else "left side stronger"
            sessions[aid][date].append({
                "name": movement_display(mv, t.get("bodyRegion")),
                "position": position_display(t.get("position"), t.get("customPosition")),
                "discomfort": False,
                "peakN":  [round(pkL, 1) if pkL is not None else None,
                           round(pkR, 1) if pkR is not None else None],
                "peakLbs": [round(pkL / N_PER_LB, 1) if pkL is not None else None,
                            round(pkR / N_PER_LB, 1) if pkR is not None else None],
                "asymPct": asym, "asymNote": note,
                "rfd": [round(v) if (v := (L or {}).get("maxRateOfForceDevelopmentNewtonsPerSecond")) is not None else None,
                        round(v) if (v := (R or {}).get("maxRateOfForceDevelopmentNewtonsPerSecond")) is not None else None],
                "ttp": [round(v, 2) if (v := (L or {}).get("avgTimeToPeakForceSeconds")) is not None else None,
                        round(v, 2) if (v := (R or {}).get("avgTimeToPeakForceSeconds")) is not None else None],
                "_ratios": t.get("ratios") or [],
            })

    athletes = {}
    for aid, by_date in sessions.items():
        prof = profiles.get(aid, {})
        name = prof.get("name") or aid
        tests_out = []
        for date, movements in sorted(by_date.items(), reverse=True):
            movements.sort(key=lambda m: MOVEMENT_ORDER.index(m["name"])
                           if m["name"] in MOVEMENT_ORDER else 99)
            ann = (annotations.get(name, {}) or {}).get(date, {})
            for m in movements:
                if m["name"] in (ann.get("discomfort") or []):
                    m["discomfort"] = True
            # ER:IR — prefer VALD's ratios, fall back to computing from peaks
            erL = erR = None
            for m in movements:
                for rat in m.pop("_ratios", []):
                    if rat.get("numeratorMovement") == "ExternalRotation" and \
                       rat.get("denominatorMovement") == "InternalRotation" and \
                       rat.get("value") is not None:
                        if rat.get("laterality") == "LeftSide":
                            erL = round(rat["value"], 2)
                        elif rat.get("laterality") == "RightSide":
                            erR = round(rat["value"], 2)
            er = next((m for m in movements if m["name"] == "External Rotation"), None)
            ir = next((m for m in movements if m["name"] == "Internal Rotation"), None)
            if er and ir:
                if erL is None and er["peakN"][0] and ir["peakN"][0]:
                    erL = round(er["peakN"][0] / ir["peakN"][0], 2)
                if erR is None and er["peakN"][1] and ir["peakN"][1]:
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
        athletes[name] = {"name": name, "group": group_code(prof.get("groups")),
                          "dob": prof.get("dob"), "tests": tests_out}
    return {
        "meta": {"syncDate": datetime.now(timezone.utc).isoformat(),
                 "source": "VALD DynaMo", "totalAthletes": len(athletes)},
        "athletes": athletes,
    }


# ─── State + merge ───────────────────────────────────────────────────────────
def load_state():
    try:
        return json.load(open(STATE_FILE)).get("lastModifiedUtc", "2020-01-01T00:00:00Z")
    except (FileNotFoundError, json.JSONDecodeError):
        return "2020-01-01T00:00:00Z"


def merge_existing(new_data):
    """Incremental runs only re-fetch modified tests; keep existing athletes/
    sessions that this run didn't see. Annotations re-apply on top either way."""
    if not os.path.exists(OUTPUT_FILE):
        return new_data
    try:
        old = json.load(open(OUTPUT_FILE))
    except Exception:
        return new_data
    merged = old.get("athletes", {})
    for name, ath in new_data["athletes"].items():
        if name in merged:
            have = {t["date"] for t in ath["tests"]}
            ath["tests"].extend(t for t in merged[name]["tests"] if t["date"] not in have)
            ath["tests"].sort(key=lambda t: t["date"], reverse=True)
        merged[name] = ath
    new_data["athletes"] = merged
    new_data["meta"]["totalAthletes"] = len(merged)
    return new_data


def main():
    full = "--full" in sys.argv
    token = authenticate()
    profiles = fetch_profiles_with_groups(token)
    modified_from = "2020-01-01T00:00:00Z" if full else load_state()
    tests = fetch_dynamo_tests(token, modified_from)
    if not tests:
        log("No new DynaMo tests. Done.")
        return

    annotations = {}
    if os.path.exists(ANNOTATIONS_FILE):
        try:
            annotations = json.load(open(ANNOTATIONS_FILE))
        except Exception as e:
            log(f"WARNING: could not read {ANNOTATIONS_FILE}: {e}")

    data = build_portal(profiles, tests, annotations)
    if not full:
        data = merge_existing(data)
    json.dump(data, open(OUTPUT_FILE, "w"), indent=2, default=str)
    json.dump({"lastModifiedUtc": max((t.get("modifiedDateUtc") or "") for t in tests),
               "lastSyncDate": datetime.now(timezone.utc).isoformat()},
              open(STATE_FILE, "w"), indent=2)
    log(f"Wrote {OUTPUT_FILE}: {data['meta']['totalAthletes']} athletes, "
        f"{sum(len(a['tests']) for a in data['athletes'].values())} sessions")


if __name__ == "__main__":
    main()
