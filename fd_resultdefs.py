#!/usr/bin/env python3
"""
One-shot: dump the ForceDecks result-definition table.

The portal pins numeric result IDs in vald_sync.py's PORTAL_METRICS, but
nothing in the repo records what those IDs actually MEAN — and ForceDecks
ships several variants of the same concept (e.g. RSI-modified computed from
flight time vs from impulse-momentum). This fetches the authoritative list so
the pinned IDs can be verified by name instead of by assumption.

Endpoint confirmed from the API's own public Swagger
(https://prd-use-api-extforcedecks.valdperformance.com/swagger/v2019q3/swagger.json):
    GET /resultdefinitions -> { resultDefinitions: [ GetResultDefinitionResponse ] }
    GetResultDefinitionResponse: resultId, resultIdString, resultName,
        resultDescription, resultGroup, resultUnit, resultUnitName,
        resultUnitScaleFactor, numberOfDecimalPlaces, trendDirection

Writes fd_result_definitions.json (committed by the workflow). Read-only.
"""
import json
import os
import sys
from datetime import datetime, timezone

import requests

AUTH_URL = "https://auth.prd.vald.com/oauth/token"
FD_BASE = "https://prd-use-api-extforcedecks.valdperformance.com"
CLIENT_ID = os.environ.get("VALD_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")

# What the portal currently pins (vald_sync.py PORTAL_METRICS) — we want their
# real names to confirm each is the intended variant.
PINNED = {
    6553614: "jumpHeight", 6553698: "rsiModified", 6553604: "relativePower",
    6553678: "brakingRFD", 6553712: "concentricImpulse", 6553703: "eccBrakingImpulse",
    6553685: "concPeakForce", 655387: "bodyweightLbs",
    13303830: "hopMeanRsi", 13303819: "hopRsi", 13303814: "hopContactTime",
    13303815: "hopFlightTime", 13303818: "hopPeakForce",
}


def main():
    out = {"ranAt": datetime.now(timezone.utc).isoformat()}
    if not CLIENT_SECRET:
        out["error"] = "VALD_CLIENT_SECRET not set"
        return out

    r = requests.post(AUTH_URL, json={
        "client_id": CLIENT_ID, "audience": "vald-api-external",
        "grant_type": "client_credentials", "client_secret": CLIENT_SECRET,
    }, timeout=20)
    if r.status_code != 200:
        out["error"] = f"auth {r.status_code}: {r.text[:200]}"
        return out
    token = r.json()["access_token"]

    rr = requests.get(f"{FD_BASE}/resultdefinitions",
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if rr.status_code != 200:
        out["error"] = f"resultdefinitions {rr.status_code}: {rr.text[:200]}"
        return out

    defs = rr.json().get("resultDefinitions", [])
    rows = []
    for d in defs:
        rows.append({
            "id": d.get("resultId"),
            "name": d.get("resultName"),
            "unit": d.get("resultUnitName"),
            "scale": d.get("resultUnitScaleFactor"),
            "decimals": d.get("numberOfDecimalPlaces"),
            "group": d.get("resultGroup"),
        })
    rows.sort(key=lambda x: (x["name"] or "").lower())
    out["total"] = len(rows)

    # The question at hand: which RSI / jump-height variants exist?
    def match(*terms):
        return [r for r in rows if r["name"] and all(t.lower() in r["name"].lower() for t in terms)]

    out["rsi_variants"] = match("rsi")
    out["jump_height_variants"] = match("jump height")
    out["imp_mom_anything"] = [r for r in rows
                               if r["name"] and ("imp-mom" in r["name"].lower()
                                                 or "impulse-momentum" in r["name"].lower())]
    # Verify what each pinned ID actually is
    by_id = {r["id"]: r for r in rows}
    out["pinned_now"] = {str(i): {"portalKey": k, "actualName": (by_id.get(i) or {}).get("name"),
                                  "unit": (by_id.get(i) or {}).get("unit"),
                                  "scale": (by_id.get(i) or {}).get("scale")}
                         for i, k in PINNED.items()}
    out["all"] = rows
    return out


if __name__ == "__main__":
    try:
        res = main()
    except Exception as e:
        res = {"fatal": f"{e.__class__.__name__}: {e}"}
    json.dump(res, open("fd_result_definitions.json", "w"), indent=2, default=str)
    print(json.dumps({k: v for k, v in res.items() if k != "all"}, indent=2, default=str)[:3000])
    print("wrote fd_result_definitions.json")
