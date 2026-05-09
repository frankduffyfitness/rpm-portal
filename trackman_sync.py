#!/usr/bin/env python3
"""
Trackman master sheet → trackman_portal.json

Reads a CSV export of the RPM Trackman Master Sheet (Master Trackman Data tab)
and produces trackman_portal.json — the velo equivalent of forcedecks_portal.json.

Usage:
    python3 trackman_sync.py master.csv [program_links.csv] > trackman_portal.json

The output JSON shape mirrors forcedecks_portal.json closely so generate_portal_data.py
can treat it the same way.
"""
import csv
import json
import re
import sys
from datetime import datetime
from collections import defaultdict


# ─── Config ──────────────────────────────────────────────────────────────────

# Aliases the master sheet uses → real athlete names.
NAME_ALIASES = {
    "GLV":           "Gavin Laya-Vetell",
    "IRP":           "Isaiah Rubin-Patel",
    "Bob Billiams":  "Rob Williams",
}

# Session types that are intentionally submax and should NOT count toward
# "best ever" peak/avg leaderboards. Latest-session display still includes them.
SUBMAX_SESSION_TYPES = {
    "Low Effort",
    "Rehab",
}

# Notes patterns that flag a session as having Trackman data quality issues.
# Flagged sessions are excluded from the leaderboard / sparkline; latest-session
# still shows them but with a small flag in the data so the UI can mark them.
TRACKMAN_ISSUE_PATTERNS = [
    r"trackman\s+(issues?|errors?|not\s+(?:really\s+)?working)",
    r"few\s+pitches",
    r"only\s+\d+\s+pitches?",
    r"iffy\s+calibration",
    r"trackman\s+(?:sort\s+of\s+)?in\s+and\s+out",
]
_ISSUE_RE = re.compile("|".join(TRACKMAN_ISSUE_PATTERNS), re.IGNORECASE)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def parse_date(s):
    """Master sheet uses M/D/YYYY. Return ISO YYYY-MM-DD or None."""
    s = (s or "").strip()
    for fmt in ("%m/%d/%Y", "%-m/%-d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            continue
    return None


def parse_velo(s):
    """Parse a velo value, handling typos like '72/4' → 72.4."""
    s = (s or "").strip()
    if not s:
        return None
    # Common typo: forward slash where decimal should be (e.g. "72/4")
    if re.match(r"^\d+/\d$", s):
        s = s.replace("/", ".")
    try:
        v = float(s)
    except ValueError:
        return None
    # Sanity bounds — peak FB velo for any human pitcher is 30-110 mph
    if v < 30 or v > 110:
        return None
    return round(v, 1)


def normalize_name(raw):
    """Trim whitespace, apply aliases."""
    n = (raw or "").strip()
    return NAME_ALIASES.get(n, n)


def is_flagged(notes):
    """Sessions with Trackman data quality issues per the Notes column."""
    if not notes:
        return False
    return bool(_ISSUE_RE.search(notes))


# ─── Main parser ─────────────────────────────────────────────────────────────

def load_master(csv_path):
    """Yield normalized session dicts from the Master Trackman Data CSV."""
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            date = parse_date(row.get("Date"))
            name = normalize_name(row.get("Athlete Name"))
            peak = parse_velo(row.get("Peak FB Velo"))
            avg  = parse_velo(row.get("Avg FB Velo"))
            stype = (row.get("Session Type") or "").strip() or "Other"
            notes = (row.get("Notes") or "").strip()
            program_url = (row.get("Athlete Program URL") or "").strip()

            # Reject rows missing the essentials
            if not date or not name or peak is None:
                continue

            yield {
                "date": date,
                "name": name,
                "peakVelo": peak,
                "avgVelo": avg,
                "sessionType": stype,
                "notes": notes,
                "programUrl": program_url,
                "isFlagged": is_flagged(notes),
                "isSubmax": stype in SUBMAX_SESSION_TYPES,
            }


def load_program_links(csv_path):
    """Optional second-tab CSV: Athlete Name → Program URL."""
    if not csv_path:
        return {}
    out = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = normalize_name(row.get("Athlete Name"))
            url = (row.get("Program URL") or "").strip()
            if name and url:
                out[name] = url
    return out


def build_portal(sessions, program_links):
    """Group by athlete, sort sessions newest-first, build the portal JSON."""
    by_athlete = defaultdict(list)
    for s in sessions:
        by_athlete[s["name"]].append(s)

    athletes = {}
    for name, rows in by_athlete.items():
        rows.sort(key=lambda s: s["date"], reverse=True)
        program_url = program_links.get(name) or rows[0].get("programUrl") or ""
        athletes[name] = {
            "name": name,
            "programUrl": program_url,
            "sessions": [
                {
                    "date":        s["date"],
                    "peakVelo":    s["peakVelo"],
                    "avgVelo":     s["avgVelo"],
                    "sessionType": s["sessionType"],
                    "notes":       s["notes"],
                    "isFlagged":   s["isFlagged"],
                    "isSubmax":    s["isSubmax"],
                }
                for s in rows
            ],
        }
    return {
        "lastSyncedAt": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "athletes": athletes,
    }


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: trackman_sync.py master.csv [program_links.csv]", file=sys.stderr)
        sys.exit(2)

    master_csv = sys.argv[1]
    links_csv  = sys.argv[2] if len(sys.argv) > 2 else None

    sessions = list(load_master(master_csv))
    program_links = load_program_links(links_csv)

    portal = build_portal(sessions, program_links)

    # Sanity log to stderr
    print(
        f"[trackman_sync] {len(sessions)} sessions across "
        f"{len(portal['athletes'])} athletes",
        file=sys.stderr,
    )
    print(json.dumps(portal, indent=2))


if __name__ == "__main__":
    main()
