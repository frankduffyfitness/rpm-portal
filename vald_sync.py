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

TENANT_ID = "3127f695-175f-4b63-8331-f1295a34cd51"
AUTH_URL = "https://auth.prd.vald.com/oauth/token"
FORCEDECKS_BASE = "https://prd-use-api-extforcedecks.valdperformance.com"
PROFILES_BASE = "https://prd-use-api-externalprofile.valdperformance.com"
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
    6553698: {"key": "rsiModified",        "label": "RSI-modified",        "unit": "m/s",  "scale": 0.01},
    6553604: {"key": "relativePower",      "label": "Relative Power",      "unit": "W/kg", "scale": 1},
    6553678: {"key": "brakingRFD",         "label": "Braking Ability",     "unit": "N/s",  "scale": 1},
    6553712: {"key": "concentricImpulse",  "label": "Concentric Impulse",  "unit": "N·s",  "scale": 1},
    6553703: {"key": "eccBrakingImpulse",  "label": "Ecc Braking Impulse", "unit": "N·s",  "scale": 1},
    6553685: {"key": "concPeakForce",      "label": "Conc Peak Force",     "unit": "N",    "scale": 1},
     655387: {"key": "bodyweightLbs",      "label": "Bodyweight",          "unit": "lbs",  "scale": 2.20462},
    # HJ (Hop Jump) metrics — VALD returns CT/FT in seconds, scale ×1000 to ms
    13303819: {"key": "hopRsi",            "label": "Hop RSI (FT/CT)",     "unit": "ratio","scale": 1},
    13303814: {"key": "hopContactTime",    "label": "Hop Contact Time",    "unit": "ms",   "scale": 1000},
    13303815: {"key": "hopFlightTime",     "label": "Hop Flight Time",     "unit": "ms",   "scale": 1000},
    13303818: {"key": "hopPeakForce",      "label": "Hop Peak Force",      "unit": "N",    "scale": 1},
}
PORTAL_METRIC_IDS = set(PORTAL_METRICS.keys())


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
        resp = requests.get(f"{FORCEDECKS_BASE}/tests", headers=H(token),
            params={"tenantId": TENANT_ID, "modifiedFromUtc": cursor}, timeout=30)
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


def process_trial(trial):
    """Extract the named portal metrics (CMJ + Hop) from a trial.
    L/R limbs get Left/Right suffixes."""
    metrics = {}

    for result in trial.get("results", []):
        # Get result ID from either top level or nested definition
        result_id = result.get("resultId")
        if result_id is None:
            result_id = result.get("definition", {}).get("id")

        if result_id not in PORTAL_METRIC_IDS:
            # DIAGNOSTIC: capture every hop-range result ID (13303xxx) we don't already
            # have a name for, so we can identify VALD's Mean RSI metric by inspecting
            # the synced data. Remove once Mean RSI is identified and added to PORTAL_METRICS.
            if isinstance(result_id, int) and 13303000 <= result_id < 13304000:
                value = result.get("value")
                limb = result.get("limb", "Trial")
                suffix = "" if limb == "Trial" else limb
                if value is not None:
                    metrics[f"hopRaw_{result_id}{suffix}"] = round(value, 4)
            continue

        value = result.get("value")
        limb = result.get("limb", "Trial")
        meta = PORTAL_METRICS[result_id]
        scale = meta["scale"]
        display_value = round(value * scale, 2) if value is not None else None

        key = meta["key"]
        if limb == "Left":
            key = f"{meta['key']}Left"
        elif limb == "Right":
            key = f"{meta['key']}Right"

        metrics[key] = display_value

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
        ath["name"] = f"{profile.get('givenName', '')} {profile.get('familyName', '')}".strip()
        ath["dateOfBirth"] = profile.get("dateOfBirth")
        ath["groups"] = profile.get("groups", [])

        raw_trials = trials_by_test.get(tid, [])
        trials = []
        for t in raw_trials:
            metrics = process_trial(t)
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
    full_sync = "--full" in sys.argv
    log("=" * 50)
    log("VALD ForceDecks → RPM Portal Sync")
    log("=" * 50)
    token = authenticate()
    profiles = fetch_profiles(token)
    groups = fetch_groups(token)
    attach_groups_to_profiles(token, profiles, groups)
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
                    existing_athletes[pid]["name"] = f"{profile.get('givenName','')} {profile.get('familyName','')}".strip() or existing_athletes[pid]["name"]
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
