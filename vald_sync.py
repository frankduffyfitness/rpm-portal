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
AUTH_AUDIENCE = "vald-api-external"
CLIENT_ID = os.environ.get("VALD_CLIENT_ID", "jOvajkmerTNoNt1wV4xrtgEizdBCt8Va")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")
TESTS_PAGE_SIZE = 50
STATE_FILE = "vald_sync_state.json"
OUTPUT_FILE = "forcedecks_portal.json"
RATE_LIMIT_PAUSE = 0.25

# ─── Portal Metrics (only these get kept) ────────────────────────────────────
# Maps result ID → { portal display name, unit, scale factor }
PORTAL_METRICS = {
    6553614: {"key": "jumpHeight",         "label": "Jump Height",         "unit": "in",   "scale": 1},
    6553698: {"key": "rsiModified",        "label": "RSI-modified",        "unit": "m/s",  "scale": 0.01},
    6553604: {"key": "relativePower",      "label": "Relative Power",      "unit": "W/kg", "scale": 1},
    6553678: {"key": "brakingRFD",         "label": "Braking Ability",     "unit": "N/s",  "scale": 1},
    6553712: {"key": "concentricImpulse",  "label": "Concentric Impulse",  "unit": "N·s",  "scale": 1},
    6553703: {"key": "eccBrakingImpulse",  "label": "Ecc Braking Impulse", "unit": "N·s",  "scale": 1},
    6553685: {"key": "concPeakForce",      "label": "Conc Peak Force",     "unit": "N",    "scale": 1},
     655387: {"key": "bodyweightLbs",      "label": "Bodyweight",          "unit": "lbs",  "scale": 2.20462},
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
        }
    log(f"Total profiles: {len(profiles)}")
    return profiles


def fetch_tests(token, modified_from="2020-01-01T00:00:00Z"):
    log(f"Fetching tests (modified from {modified_from[:10]})...")
    all_tests = []
    cursor = modified_from
    page = 0
    while True:
        time.sleep(RATE_LIMIT_PAUSE)
        resp = requests.get(f"{FORCEDECKS_BASE}/tests", headers=H(token),
            params={"tenantId": TENANT_ID, "modifiedFromUtc": cursor}, timeout=30)
        resp.raise_for_status()
        tests = resp.json().get("tests", [])
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
    """Extract only the 8 portal metrics from a trial, including L/R for asymmetry."""
    metrics = {}

    for result in trial.get("results", []):
        # Get result ID from either top level or nested definition
        result_id = result.get("resultId")
        if result_id is None:
            result_id = result.get("definition", {}).get("id")

        if result_id not in PORTAL_METRIC_IDS:
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
    athletes = defaultdict(lambda: {"name": "", "dateOfBirth": None, "tests": []})
    total_trials = 0

    for test in tests:
        pid = test["profileId"]
        tid = test["testId"]
        profile = profiles.get(pid, {})
        ath = athletes[pid]
        ath["name"] = f"{profile.get('givenName', '')} {profile.get('familyName', '')}".strip()
        ath["dateOfBirth"] = profile.get("dateOfBirth")

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
    modified_from = "2020-01-01T00:00:00Z" if full_sync else load_sync_state()
    if full_sync:
        log("Full sync requested.")
    else:
        log(f"Incremental sync from {modified_from[:10]}")
    tests = fetch_tests(token, modified_from)
    if not tests:
        log("No new tests. Done.")
        return
    log(f"Fetching trials for {len(tests)} tests...")
    trials_by_test = {}
    for i, test in enumerate(tests):
        trials = fetch_trials_for_test(token, test["testId"])
        trials_by_test[test["testId"]] = trials if isinstance(trials, list) else []
        if (i + 1) % 50 == 0:
            log(f"  Progress: {i + 1}/{len(tests)} tests")
    log(f"All {len(tests)} tests processed.")
    log("Building portal data (8 metrics only)...")
    portal_data = build_portal_data(profiles, tests, trials_by_test)
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
