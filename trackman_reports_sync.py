#!/usr/bin/env python3
"""
TrackMan session-report PDFs → trackman_reports.json

Parses the per-session PDF reports TrackMan exports (TempPlayerSessionReport*.pdf)
into structured JSON for the portal's Bullpen Breakdown view. This is the richest
data we can get on the basic subscription: per-pitch-type aggregates AND every
individual pitch (velo, spin, tilt, IVB, HB, extension, release point, spin eff).

Folder layout (athlete name = folder name, must match the portal name):
    TrackMan Files/
      Joe Hauser/
        TempPlayerSessionReport.pdf
        TempPlayerSessionReport 2.pdf
        ...

Usage:
    python3 trackman_reports_sync.py "/path/to/TrackMan Files" > trackman_reports.json

Pitch-type assignment: the PDF's per-pitch table doesn't label pitch types (the
report encodes them as row colors, which don't survive text extraction). We
recover them by assigning each pitch to the session's pitch-type centroids
(velocity + spin) with exact per-type quotas from the summary table, then
validate that per-type averages reproduce the summary table's averages.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

from pypdf import PdfReader

# ─── Parsing helpers ─────────────────────────────────────────────────────────

MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

# 14 numeric fields after the type name in the "Stats by pitch type" table:
# qty, veloMin, veloMax, veloAvg, spinMin, spinMax, spinAvg,
# ivbAvg, hbAvg, hbMaxAbs, vertMovMaxAbs, relH, relSide, ext
# (column order verified against the per-pitch data: e.g. Fastball ivbAvg 20.2
#  matches the mean of its per-pitch IVB values)
TYPE_ROW = re.compile(
    r'^([A-Za-z][A-Za-z \-]*?)\s+(\d+)((?:\s+(?:-?[\d.]+|-)){13})\s*$', re.M)

PITCH_ROW = re.compile(r'^#(\d+)\s+(.+)$', re.M)


def _num(tok):
    """'-' → None, else float."""
    if tok is None or tok == '-':
        return None
    try:
        return float(tok)
    except ValueError:
        return None


def _feet(tok):
    """5'8\" → 5.67 ft; 5' → 5.0; '-' → None."""
    if not tok or tok == '-':
        return None
    m = re.match(r"^(\d+)'(?:(\d+)\")?$", tok)
    if not m:
        return None
    ft = int(m.group(1))
    inches = int(m.group(2)) if m.group(2) else 0
    return round(ft + inches / 12, 2)


def _pct(tok):
    if not tok or tok == '-':
        return None
    m = re.match(r'^(\d+)%$', tok)
    return int(m.group(1)) if m else None


SESSION_TYPE_WORDS = re.compile(
    r'\b(Pitching practice|Bullpen|Live BP|Live|Game|Practice|Pitch Design|Session)\b', re.I)


def parse_header(page1_text, athlete_name):
    """'Joe Hauser Pitching practice 7 Jul 2026' → (session_type, iso_date).

    The PDF's name spelling can differ from the folder name in case
    (e.g. 'Thomas Lobello' vs folder 'Thomas LoBello'), so match the
    name prefix case-insensitively, with a session-type-keyword fallback."""
    for line in page1_text.splitlines():
        line = line.strip()
        m = re.search(r'(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})\s*$', line)
        if not m:
            continue
        d = f"{m.group(3)}-{MONTHS[m.group(2)]:02d}-{int(m.group(1)):02d}"
        before = line[:m.start()].strip()
        if before.lower().startswith(athlete_name.lower()):
            stype = before[len(athlete_name):].strip() or "Session"
            return stype, d
        kw = SESSION_TYPE_WORDS.search(before)
        if kw:  # name spelled differently — still recover the session type
            return kw.group(1), d
    return None, None


def parse_type_stats(page1_text):
    """Rows from the 'Stats by pitch type' summary table."""
    anchor = page1_text.find("Stats by pitch type")
    section = page1_text[anchor:] if anchor >= 0 else page1_text
    types = []
    for m in TYPE_ROW.finditer(section):
        name = m.group(1).strip()
        if name in ("Pitch type",):
            continue
        # Display-name normalization (TrackMan's PDFs say "ChangeUp")
        name = {"ChangeUp": "Changeup"}.get(name, name)
        nums = [_num(t) for t in m.group(3).split()]
        types.append({
            "name": name, "count": int(m.group(2)),
            "veloMin": nums[0], "veloMax": nums[1], "veloAvg": nums[2],
            "spinMin": nums[3], "spinMax": nums[4], "spinAvg": nums[5],
            "ivb": nums[6], "hb": nums[7], "hbMaxAbs": nums[8],
            "vertMovMaxAbs": nums[9], "relH": nums[10], "relSide": nums[11],
            "ext": nums[12],
        })
    return types


def parse_pitches(all_text):
    """Per-pitch rows: #N velo spin tilt ivb hb ext relH relSide eff."""
    pitches = []
    for m in PITCH_ROW.finditer(all_text):
        toks = m.group(2).split()
        if len(toks) != 9:
            continue  # not a pitch row (or malformed) — pitch rows have 9 fields
        velo = _num(toks[0])
        if velo is None:
            continue  # no velocity = dead capture, skip
        pitches.append({
            "no": int(m.group(1)), "velo": velo, "spin": _num(toks[1]),
            "tilt": toks[2] if re.match(r'^\d{1,2}:\d{2}$', toks[2]) else None,
            "ivb": _num(toks[3]), "hb": _num(toks[4]),
            "ext": _feet(toks[5]), "relH": _feet(toks[6]),
            "relSide": _feet(toks[7]), "eff": _pct(toks[8]),
        })
    return pitches


def assign_types(pitches, types, log_prefix=""):
    """Assign each pitch a type via quota-constrained nearest-centroid on
    (velo, spin). Sort all (pitch, type) distances ascending; greedily assign
    while the type still has quota. Guarantees per-type counts match the
    summary table exactly."""
    quotas = {t["name"]: t["count"] for t in types}
    cands = []
    for i, p in enumerate(pitches):
        for t in types:
            dv = (p["velo"] - (t["veloAvg"] or 0)) / 3.0
            ds = 0.0
            if p["spin"] is not None and t["spinAvg"] is not None:
                ds = (p["spin"] - t["spinAvg"]) / 250.0
            dh = 0.0
            # HB tiebreaks types whose velo+spin bands touch (e.g. a slow
            # slider vs a hard sweeper — sweep separates them cleanly).
            if p["hb"] is not None and t["hb"] is not None:
                dh = (p["hb"] - t["hb"]) / 6.0
            cands.append((dv * dv + ds * ds + dh * dh, i, t["name"]))
    cands.sort()
    assigned = {}
    for dist, i, tname in cands:
        if i in assigned or quotas.get(tname, 0) <= 0:
            continue
        assigned[i] = tname
        quotas[tname] -= 1
    for i, p in enumerate(pitches):
        p["type"] = assigned.get(i)

    # Validate: per-type mean velo should reproduce the summary table's avg.
    for t in types:
        vals = [p["velo"] for p in pitches if p["type"] == t["name"]]
        if vals and t["veloAvg"] is not None:
            avg = sum(vals) / len(vals)
            if abs(avg - t["veloAvg"]) > 0.5:
                print(f"{log_prefix}  WARN: {t['name']} classified avg "
                      f"{avg:.1f} vs table {t['veloAvg']} — check assignment",
                      file=sys.stderr)

    # Per-type spin-efficiency average (only from pitches that reported it)
    for t in types:
        effs = [p["eff"] for p in pitches if p["type"] == t["name"] and p["eff"] is not None]
        t["effAvg"] = round(sum(effs) / len(effs)) if effs else None
    return pitches


def parse_report(path, athlete_name):
    r = PdfReader(path)
    page1 = r.pages[0].extract_text() or ""
    all_text = "\n".join((p.extract_text() or "") for p in r.pages)

    stype, date = parse_header(page1, athlete_name)
    if not date:
        print(f"  SKIP {os.path.basename(path)}: no header/date found", file=sys.stderr)
        return None

    m = re.search(r'Pitches\s*(\d+)\s*Total', page1)
    total = int(m.group(1)) if m else 0
    types = parse_type_stats(page1)
    if total == 0 or not types:
        print(f"  SKIP {os.path.basename(path)} ({date}): empty session "
              f"(0 pitches)", file=sys.stderr)
        return None

    pitches = parse_pitches(all_text)
    if len(pitches) != total:
        print(f"  WARN {os.path.basename(path)} ({date}): parsed "
              f"{len(pitches)} pitch rows, report says {total}", file=sys.stderr)
    assign_types(pitches, types, log_prefix=f"  [{date}]")

    return {"date": date, "sessionType": stype, "total": total,
            "types": types, "pitches": pitches}


def main():
    if len(sys.argv) < 2:
        print('Usage: trackman_reports_sync.py "/path/to/TrackMan Files"', file=sys.stderr)
        sys.exit(2)
    root = sys.argv[1]

    athletes = {}
    for folder in sorted(os.listdir(root)):
        fpath = os.path.join(root, folder)
        if not os.path.isdir(fpath) or folder.startswith('.'):
            continue
        sessions = []
        for f in sorted(os.listdir(fpath)):
            if not f.lower().endswith('.pdf'):
                continue
            s = parse_report(os.path.join(fpath, f), folder)
            if s:
                sessions.append(s)
        if sessions:
            sessions.sort(key=lambda s: s["date"], reverse=True)
            athletes[folder] = {"name": folder, "sessions": sessions}
            print(f"[trackman_reports] {folder}: {len(sessions)} sessions "
                  f"({sessions[-1]['date']} → {sessions[0]['date']})", file=sys.stderr)

    out = {"lastSyncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "athletes": athletes}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
