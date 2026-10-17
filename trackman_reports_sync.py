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
    """5'8\" → 5.67 ft; 5' → 5.0; -6\" → -0.5; -1'1\" → -1.08; 0\" → 0.0; '-' → None.

    Release-side values are usually inches-only and often negative, which the
    original feet'inches\" pattern rejected — that's why relSide came through
    null on every per-pitch row before 2026-10-17."""
    if not tok or tok == '-':
        return None
    m = re.match(r"^(-?)(?:(\d+)')?(?:(\d+)\")?$", tok)
    if not m or (m.group(2) is None and m.group(3) is None):
        return None
    v = int(m.group(2) or 0) + int(m.group(3) or 0) / 12
    return round(-v if m.group(1) else v, 2)


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


# ─── Location-plot extraction ────────────────────────────────────────────────
# The per-pitch table has no plate-location columns; the only location data in
# the report is the dot plot on page 1. The dots are vector circle paths, so we
# recover them with PyMuPDF: calibrate the Location axes from their numeric
# tick labels, read each dot's center and ring color, and map colors to pitch
# types via the page's own legend. Optional dependency: without pymupdf the
# sync still runs and sessions simply carry no "locations".
try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None


def _dot_drawings(page):
    """Small circular paths → (cx, cy, color). A pitch dot is one path of
    Bézier curves with a near-square bbox a few points wide; the ring (stroke)
    color carries the pitch type, with fill as fallback."""
    dots = []
    for d in page.get_drawings():
        r = d["rect"]
        if not (2 < r.width < 12 and 2 < r.height < 12):
            continue
        if abs(r.width - r.height) > 2.5:
            continue
        if not any(it[0] == "c" for it in d["items"]):
            continue
        # Fill carries the type color on every TrackMan dot; stroke sometimes
        # doesn't (the velo-panel legend rings its dot in black). Fall back to
        # stroke only for hollow (missing or near-white fill) dots.
        fill, stroke = d.get("fill"), d.get("color")
        col = fill if fill and min(fill) < 0.9 else stroke
        if col is None:
            continue
        dots.append((r.x0 + r.width / 2, r.y0 + r.height / 2,
                     tuple(round(c, 3) for c in col)))
    return dots


def _linfit(pairs):
    """Least-squares pixel→value map from (pixel, value) tick pairs."""
    n = len(pairs)
    sx = sum(p for p, _ in pairs); sv = sum(v for _, v in pairs)
    sxx = sum(p * p for p, _ in pairs); sxv = sum(p * v for p, v in pairs)
    den = n * sxx - sx * sx
    if not den:
        return None
    a = (n * sxv - sx * sv) / den
    b = (sv - a * sx) / n
    return lambda px: a * px + b


def extract_locations(path, type_names):
    """[{x, z, type}] in feet from the page-1 Location plot, [] when the plot,
    pymupdf, or a usable calibration is missing. Never raises."""
    if fitz is None:
        return []
    try:
        doc = fitz.open(path)
        page = doc[0]
        words = page.get_text("words")
        dots = _dot_drawings(page)

        def title(s):
            c = [w for w in words if w[4] == s]
            return c[0] if c else None

        loc, rel = title("Location"), title("Release")
        if not loc or not rel or rel[1] <= loc[3]:
            return []
        region = fitz.Rect(loc[0] - 30, loc[3], page.rect.x1, rel[1] - 2)

        nums = []
        for w in words:
            if not (region.x0 <= w[0] and w[2] <= region.x1
                    and region.y0 <= w[1] and w[3] <= region.y1):
                continue
            try:
                nums.append((w, float(w[4])))
            except ValueError:
                continue
        if len(nums) < 4:
            return []
        maxy = max((t[0][1] + t[0][3]) / 2 for t in nums)
        xticks = [t for t in nums if abs((t[0][1] + t[0][3]) / 2 - maxy) < 5]
        rest = [t for t in nums if t not in xticks]
        if len(xticks) < 2 or not rest:
            return []
        maxx = max((t[0][0] + t[0][2]) / 2 for t in rest)
        yticks = [t for t in rest if abs((t[0][0] + t[0][2]) / 2 - maxx) < 6]
        if len(yticks) < 2:
            return []
        fx = _linfit([(((w[0] + w[2]) / 2), v) for w, v in xticks])
        fy = _linfit([(((w[1] + w[3]) / 2), v) for w, v in yticks])
        if not fx or not fy:
            return []

        # Legend: each type name has its ring dot just left of the text.
        legend = {}
        for w in words:
            name = {"ChangeUp": "Changeup"}.get(w[4], w[4])
            if name not in type_names:
                continue
            cy = (w[1] + w[3]) / 2
            for cx, dy, col in dots:
                if abs(dy - cy) < 4 and 0 < w[0] - cx < 25:
                    legend.setdefault(name, col)
                    break
        if not legend:
            return []

        def nearest_type(col):
            best = None
            for n, c in legend.items():
                d = sum((a - b) ** 2 for a, b in zip(col, c))
                if best is None or d < best[0]:
                    best = (d, n)
            return best[1] if best and best[0] < 0.12 else None

        out = []
        for cx, cy, col in dots:
            if not (region.x0 <= cx <= region.x1 and region.y0 <= cy <= region.y1):
                continue
            t = nearest_type(col)
            if t is None:
                continue
            x, z = fx(cx), fy(cy)
            if abs(x) > 5 or not -1 <= z <= 8:
                continue
            out.append({"x": round(x, 2), "z": round(z, 2), "type": t})
        doc.close()
        return out
    except Exception as ex:
        print(f"  WARN location extraction failed for "
              f"{os.path.basename(path)}: {ex}", file=sys.stderr)
        return []


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
    for dd, i, tname in cands:
        if i in assigned or quotas.get(tname, 0) <= 0:
            continue
        assigned[i] = tname
        quotas[tname] -= 1

    # 2-opt refinement against TrackMan's OWN aggregates: greedy quota-filling
    # can strand a pitch on the wrong type (e.g. the session's hardest pitch
    # labeled Sinker because closer pitches filled the Fastball quota first).
    # The ground truth we can check is the summary table's per-type velo/spin
    # averages, so swap pitch pairs whenever the exchange brings our per-type
    # means closer to the table's. Quotas are preserved by swapping.
    table = {t["name"]: t for t in types}

    def objective(a):
        cost = 0.0
        by_type = {}
        for i, tn in a.items():
            by_type.setdefault(tn, []).append(pitches[i])
        for tn, ps in by_type.items():
            t = table[tn]
            if t.get("veloAvg") is not None:
                cost += abs(sum(p["velo"] for p in ps) / len(ps) - t["veloAvg"])
            spins = [p["spin"] for p in ps if p["spin"] is not None]
            if spins and t.get("spinAvg") is not None:
                cost += abs(sum(spins) / len(spins) - t["spinAvg"]) / 150.0
            hbs = [p["hb"] for p in ps if p["hb"] is not None]
            if hbs and t.get("hb") is not None:
                cost += abs(sum(hbs) / len(hbs) - t["hb"]) / 4.0
        return cost

    idxs = list(assigned.keys())
    best = objective(assigned)
    for _ in range(10):  # converges in 1-2 passes at these sizes
        improved = False
        for a_i in range(len(idxs)):
            for b_i in range(a_i + 1, len(idxs)):
                i, j = idxs[a_i], idxs[b_i]
                if assigned[i] == assigned[j]:
                    continue
                assigned[i], assigned[j] = assigned[j], assigned[i]
                cost = objective(assigned)
                if cost + 1e-9 < best:
                    best = cost
                    improved = True
                else:
                    assigned[i], assigned[j] = assigned[j], assigned[i]
        if not improved:
            break

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

    locations = extract_locations(path, {t["name"] for t in types})
    return {"date": date, "sessionType": stype, "total": total,
            "types": types, "pitches": pitches, "locations": locations}


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
