# sync-trigger: 2026-08-31 Josh Miller evaluation pull
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

import os, sys, json, time, re, hashlib, requests
from datetime import datetime, timezone, timedelta
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
# Torque (force × lever arm) is computed in generate_portal_data.py, which joins
# raw force here with the manual forearm measurements on every portal build.

# Canonicalize VALD DynaMo profile names to the spelling used elsewhere in the
# portal (TrackMan/velo), so an athlete's data unifies and measurements join.
NAME_ALIASES = {
    "Zach Uysal": "Zachary Uysal",
    "Robert Romero": "Rob Romero",   # portal/velo-model spelling (2026-08-05)
}
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
            "name": NAME_ALIASES.get(
                f"{p.get('givenName','')} {p.get('familyName','')}".strip(),
                f"{p.get('givenName','')} {p.get('familyName','')}".strip()),
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
    """Paged fetch with rep summaries inline. Returns TestDTO list.

    Deduped by full test CONTENT: the paged endpoint can return the same test on
    more than one page (observed 2026-07-15 — every 7/14+ test came back twice,
    producing exact-duplicate movements downstream).

    NOT keyed on `id`: VALD reuses an id across the movements of one session, so
    an id-based dedupe silently drops real tests (it cost Matt Bowman his IR and
    two grips before this was caught). Hashing the whole payload only collapses
    byte-identical repeats, which is exactly the pagination artifact."""
    log(f"Fetching DynaMo tests (modified from {modified_from[:10]})…")
    tests, seen, dupes, page = [], set(), 0, 1
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
        fresh = 0
        for it in items:
            sig = hashlib.md5(json.dumps(it, sort_keys=True, default=str)
                              .encode()).hexdigest()
            if sig in seen:
                dupes += 1
                continue
            seen.add(sig)
            tests.append(it)
            fresh += 1
        total_pages = body.get("totalPages", 1)
        log(f"  page {page}/{total_pages}: {len(items)} returned, +{fresh} new "
            f"(total {len(tests)})")
        if page >= total_pages or not items:
            break
        page += 1
    if dupes:
        log(f"  NOTE: dropped {dupes} byte-identical duplicate test(s) across pages")
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
            # Collapse exact duplicates (same movement, position and peak to
            # 0.1 N). Two real efforts never match exactly — that's a double
            # record, not a repeat test. Genuine repeats (different values,
            # e.g. two Elbow Extension efforts) are preserved.
            seen_mv, uniq = set(), []
            for m in movements:
                k = (m["name"], m.get("position"), tuple(m.get("peakN") or []))
                if k in seen_mv:
                    continue
                seen_mv.add(k)
                uniq.append(m)
            movements = uniq
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
        wm = json.load(open(STATE_FILE)).get("lastModifiedUtc", "")
    except (FileNotFoundError, json.JSONDecodeError):
        wm = ""
    # An empty watermark must never reach the API. Observed 2026-07-30: the
    # stored watermark was "" (the API's test objects carry no modifiedDateUtc,
    # so max() wrote an empty string), modifiedFromUTC="" returned a partial
    # set, and the 7/29 evening trunk-rotation tests were silently skipped.
    # Empty -> full pull; merge_existing unions, so full pulls are safe.
    return wm if wm else "2020-01-01T00:00:00Z"


def merge_existing(new_data):
    """Union this run's results into what we already have — never replace.

    ALWAYS runs, including on --full. The VALD DynaMo endpoint returns
    INCOMPLETE results on some full pulls (observed repeatedly 2026-07-14/15:
    consecutive full syncs alternated between 17-19 athletes and 14-16, with
    Alchi Santos and several of Tom Hackimer's ER tests appearing/vanishing).
    A --full previously rebuilt from scratch, so a partial API response silently
    deleted good data. Unioning makes the pipeline monotonic: a flaky response
    can only add, never remove.

    Trade-off: a test genuinely deleted in VALD persists here until purged by
    hand. That is the safer failure direction for a coach-facing dashboard."""
    if not os.path.exists(OUTPUT_FILE):
        return new_data
    try:
        old = json.load(open(OUTPUT_FILE))
    except Exception:
        return new_data

    def mv_key(m):
        return (m.get("name"), m.get("position"), tuple(m.get("peakN") or []))

    merged = old.get("athletes", {})
    for name, ath in new_data["athletes"].items():
        if name not in merged:
            merged[name] = ath
            continue
        prev = merged[name]
        by_date = {t["date"]: t for t in prev.get("tests", [])}
        for t in ath.get("tests", []):
            if t["date"] not in by_date:
                by_date[t["date"]] = t
                continue
            # same session seen again: union movements, keep richer metadata
            base = by_date[t["date"]]
            seen = {mv_key(m) for m in base.get("movements", [])}
            for m in t.get("movements", []):
                if mv_key(m) not in seen:
                    seen.add(mv_key(m))
                    base.setdefault("movements", []).append(m)
            for fld in ("erIr", "discomfortNote", "planNote", "type", "label"):
                if t.get(fld) and not base.get(fld):
                    base[fld] = t[fld]
        prev["tests"] = sorted(by_date.values(), key=lambda x: x["date"], reverse=True)
        prev["name"] = ath.get("name", prev.get("name"))
        prev["group"] = ath.get("group", prev.get("group"))
        prev["dob"] = ath.get("dob") or prev.get("dob")
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
    # union ALWAYS (see merge_existing): the API's full pulls are not reliably
    # complete, so rebuilding from scratch loses data.
    data = merge_existing(data)
    json.dump(data, open(OUTPUT_FILE, "w"), indent=2, default=str)
    def _modified(t):
        return (t.get("modifiedDateUtc") or t.get("modifiedUtc")
                or t.get("lastModifiedUtc") or "")
    new_wm = max((_modified(t) for t in tests), default="")
    if new_wm:
        # Back off 48h so late-uploading devices can never be skipped; the
        # union merge makes re-fetching the overlap free.
        try:
            _dt = datetime.fromisoformat(new_wm.replace("Z", "+00:00")) - timedelta(hours=48)
            new_wm = _dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            pass
    else:
        # No usable modified field on this API version: force the next run to
        # a full pull rather than persisting a poisoned watermark.
        new_wm = "2020-01-01T00:00:00Z"
    json.dump({"lastModifiedUtc": new_wm,
               "lastSyncDate": datetime.now(timezone.utc).isoformat()},
              open(STATE_FILE, "w"), indent=2)
    log(f"Wrote {OUTPUT_FILE}: {data['meta']['totalAthletes']} athletes, "
        f"{sum(len(a['tests']) for a in data['athletes'].values())} sessions")


if __name__ == "__main__":
    main()

# sync trigger 2026-07-15 — pull Matt Bowman DynaMo test

# sync trigger 2026-07-16 — pull latest DynaMo test

# sync trigger 2026-07-30 — pull new trunk rotation tests

# sync trigger 2026-07-30 pm — pull new VALD Hub data

# sync trigger 2026-08-04 pm — pull Napolitano + Peralta grips

# sync trigger 2026-08-04 pm — pull Nieto grip

# sync trigger 2026-08-10 — pull Florman grip

# sync trigger 2026-08-12 — pull Ott grip

# sync trigger 2026-08-12 pm — pull Luke Mendez grip

# sync trigger 2026-08-12 pm (retry) — Mendez grip uploaded off the device

# sync trigger 2026-08-13 — pull the DynaMo tests that came with today's pens

# sync trigger 2026-08-17 pm — pull the DynaMo tests from today

# sync trigger 2026-08-18 — pull today's eval DynaMo (Tineo, Corkery + any new)

# sync trigger 2026-08-20 — pull Gianni Muro grip (device synced by Frank)

# sync trigger 2026-08-24 — pull Leland Daniels-Weeks eval DynaMo
