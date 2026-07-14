#!/usr/bin/env python3
"""
One-shot DynaMo API access probe. Runs in CI (where VALD_CLIENT_SECRET lives),
writes findings to dynamo_probe_result.json, which the workflow commits back.

Answers, in order:
  1. Does OAuth succeed, and what scopes/audience does the token carry?
     (decoded from the JWT payload — tells us if DynaMo access is granted)
  2. Which candidate DynaMo base URLs resolve + answer /tests?
  3. For the first working base: a sample test list item + one test detail,
     so RESULT_KEYS in dynamo_sync.py can be locked against real field names.

Deliberately read-only against VALD; writes nothing anywhere except the local
result file.
"""
import base64
import json
import os
import socket
import sys
from datetime import datetime, timezone

import requests

TENANT_ID = os.environ.get("VALD_TENANT_ID", "3127f695-175f-4b63-8331-f1295a34cd51")
AUTH_URL = "https://auth.prd.vald.com/oauth/token"
CLIENT_ID = os.environ.get("VALD_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("VALD_CLIENT_SECRET", "")

CANDIDATE_BASES = [
    "https://prd-use-api-extdynamo.valdperformance.com",
    "https://prd-use-api-externaldynamo.valdperformance.com",
    "https://prd-use-api-extdynamomax.valdperformance.com",
    "https://dynamoextapi.valdperformance.com",
    "https://prd-use-api-extdynamometry.valdperformance.com",
]

OUT = "dynamo_probe_result.json"
result = {"ranAt": datetime.now(timezone.utc).isoformat(), "steps": []}


def step(name, **kw):
    entry = {"step": name, **kw}
    result["steps"].append(entry)
    print(f"[probe] {name}: {json.dumps(kw, default=str)[:300]}", flush=True)
    return entry


def jwt_claims(token):
    """Decode the JWT payload WITHOUT verification — we only read our own
    token's claims to see which products/scopes VALD granted."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception as e:
        return {"decodeError": str(e)}


def main():
    # 1. Auth (audience identical to the working ForceDecks sync)
    if not CLIENT_SECRET:
        step("auth", ok=False, error="VALD_CLIENT_SECRET not set")
        return
    r = requests.post(AUTH_URL, json={
        "client_id": CLIENT_ID, "audience": "vald-api-external",
        "grant_type": "client_credentials", "client_secret": CLIENT_SECRET,
    }, timeout=20)
    if r.status_code != 200:
        step("auth", ok=False, status=r.status_code, body=r.text[:300])
        return
    token = r.json()["access_token"]
    claims = jwt_claims(token)
    # Strip anything that isn't scope/permission info; never write the token.
    step("auth", ok=True,
         scope=claims.get("scope"),
         permissions=claims.get("permissions"),
         audience=claims.get("aud"),
         otherClaimKeys=sorted(k for k in claims if k not in
                               ("scope", "permissions", "aud", "iat", "exp", "iss", "sub", "azp", "gty")))

    H = {"Authorization": f"Bearer {token}"}

    # 2. Probe candidate bases
    working = None
    for base in CANDIDATE_BASES:
        host = base.split("//")[1]
        try:
            socket.getaddrinfo(host, 443)
        except OSError:
            step("dns", base=base, resolves=False)
            continue
        entry = {"base": base, "resolves": True, "endpoints": {}}
        for path, params in [
            ("/tests", {"TenantId": TENANT_ID, "modifiedFromUtc": "2020-01-01T00:00:00Z"}),
            ("/tests", {"tenantId": TENANT_ID, "modifiedFromUtc": "2020-01-01T00:00:00Z"}),
        ]:
            key = f"{path}?{'&'.join(params)}"
            try:
                pr = requests.get(f"{base}{path}", headers=H, params=params, timeout=20)
                entry["endpoints"][key] = {"status": pr.status_code, "body": pr.text[:400]}
                if pr.status_code == 200 and not working:
                    working = (base, path, params, pr)
                elif pr.status_code == 204 and not working:
                    working = (base, path, params, pr)
            except requests.RequestException as e:
                entry["endpoints"][key] = {"error": f"{e.__class__.__name__}: {e}"}
        step("probe", **entry)

    if not working:
        step("conclusion", ok=False,
             message="No candidate DynaMo base answered /tests. Either the URL "
                     "differs or the credentials lack DynaMo API access — see "
                     "the auth step's scope/permissions to distinguish.")
        return

    base, path, params, resp = working
    if resp.status_code == 204:
        step("conclusion", ok=True, base=base,
             message="DynaMo API reachable but returned 204 No Content — access "
                     "works, there are just no tests modified in range (or none "
                     "synced from the unit yet).")
        return

    tests = resp.json().get("tests", resp.json() if isinstance(resp.json(), list) else [])
    step("tests", ok=True, base=base, count=len(tests),
         sampleListItem=tests[0] if tests else None)

    # 3. One test detail for field mapping
    if tests:
        tid = tests[0].get("testId") or tests[0].get("id")
        for dpath in (f"/tests/{tid}", f"/v2019q3/teams/{TENANT_ID}/tests/{tid}",
                      f"/tests/{tid}/trials"):
            try:
                dr = requests.get(f"{base}{dpath}", headers=H,
                                  params={"TenantId": TENANT_ID}, timeout=20)
                ok = dr.status_code == 200
                step("detail", path=dpath, status=dr.status_code,
                     body=(dr.json() if ok else dr.text[:300]))
                if ok:
                    break
            except requests.RequestException as e:
                step("detail", path=dpath, error=str(e))
    step("conclusion", ok=True, base=base,
         message="DynaMo API access CONFIRMED with existing credentials. "
                 "Lock DYNAMO_BASE and RESULT_KEYS in dynamo_sync.py from the "
                 "payloads above.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # never fail the workflow — always write findings
        step("fatal", error=f"{e.__class__.__name__}: {e}")
    json.dump(result, open(OUT, "w"), indent=2, default=str)
    print(f"[probe] wrote {OUT}")
# bump 1784053632 — re-fire probe to capture token scopes
