#!/usr/bin/env python3
"""
Generate portal data arrays from forcedecks_portal.json
Outputs a JS snippet to paste into App.jsx, replacing the hardcoded arrays.
"""
import json, sys, os, re
from datetime import datetime, timedelta
from collections import defaultdict, Counter
import statistics
from decimal import Decimal, ROUND_HALF_UP

def r1u(x):
    """Round to 1 decimal, HALF-UP, to match VALD Hub. Python's round() is
    banker's rounding AND reads e.g. 24.15 as the float 24.1499… so it rounds
    DOWN to 24.1; VALD (and the coaches) round 24.15 → 24.2. str(x) recovers the
    intended 2-decimal reading before we re-round."""
    if x is None:
        return None
    return float(Decimal(str(x)).quantize(Decimal('0.1'), rounding=ROUND_HALF_UP))

# ─── Config ──────────────────────────────────────────────────────────────────

PORTAL_JSON = sys.argv[1] if len(sys.argv) > 1 else "forcedecks_portal.json"
CURRENT_JSX = sys.argv[2] if len(sys.argv) > 2 else "App.jsx"
TRACKMAN_JSON = sys.argv[3] if len(sys.argv) > 3 else "trackman_portal.json"
ACTIVE_CUTOFF = datetime.now() - timedelta(days=42)
MIN_SESSIONS = 5
# Pro / Men's League are visiting or one-off testers who rarely reach 5 sessions,
# so the normal MIN_SESSIONS gate zeroes those groups out — no "vs Pro" benchmark.
# Let them feed their group's norms with as few as 1 session (Frank, 2026-07-16:
# "good for guys to see how they stack up against the pro athletes"). Still gated
# to >=3 contributing athletes so the percentile isn't degenerate; when the pros
# go stale (>6wk) the group drops out and ReportView falls back to "vs All
# Athletes" on its own.
NORM_RELAXED_GROUPS = {"pro", "ml"}
NORM_RELAXED_MIN_SESSIONS = 1
NORM_RELAXED_MIN_ATHLETES = 3
HISTORY_LEN = 8  # last 8 sessions for sparklines

# ─── Hop test metric keys ───────────────────────────────────────────────────
# vald_sync.py stores hop metrics under these keys (see PORTAL_METRICS in vald_sync).
# RSI displayed on the portal is VALD's "Mean RSI" (averaged across hops within a
# trial), to match VALD Hub's headline number. hopRsi (single-best-hop) is also
# captured but is no longer used as the displayed metric.
HOP_RSI_KEY        = "hopSetMeanRsi"    # Whole-set mean RSI over ALL hops — matches VALD Hub
HOP_CT_KEY         = "hopSetMeanCt"     # Whole-set mean Contact Time — milliseconds
HOP_FT_KEY         = "hopSetMeanFt"     # Whole-set mean Flight Time — milliseconds
HOP_PEAK_FORCE_KEY = "hopPeakForce"     # Best Peak Force — Newtons
HOP_TEST_TYPE      = "HJ"               # primary hop test type to process
G = 9.81
LB_PER_KG = 2.20462

# ─── Manual hop-test exclusions ──────────────────────────────────────────────
# Athletes -> list of test dates (YYYY-MM-DD) to skip entirely.
# Use this when a specific session looks suspect and we're awaiting athlete
# confirmation. Drop entries here once a session is confirmed real or fake.
HOP_MANUAL_EXCLUSIONS = {
    "Jackson Cintron": [
        "2026-01-29",  # 4.16/4.09 RSI session — pending Frank's check with athlete
    ],
    "Ivan Victorio": [
        "2026-02-06",  # 4.03 RSI trial w/ CT 126 vs his ~190 norm — likely missed-takeoff misread
    ],
    "Scottie Nieto": [
        "2026-03-04",  # 4.12 RSI trial — 0.5+ above his consistent 3.0–3.63 ceiling
    ],
}

# CMJ force/elasticity quadrants: how far back "current form" reaches. Must
# stay equal to QUAD_WIN_DAYS in src/App.jsx, which filters the same plot by
# lastCmj -- if these two ever disagree, an athlete can be drawn from a median
# that reaches outside the window he was admitted on. See gen_QUAD.
QUAD_WIN_DAYS = 42

# ─── Velo (Trackman) config ──────────────────────────────────────────────────
VELO_HISTORY_LEN = 8                          # last N sessions in sparkline history
VELO_SUBMAX_TYPES = {"Low Effort", "Rehab"}   # excluded from "best ever" math
# Manual session exclusions for velo (mirror HOP_MANUAL_EXCLUSIONS pattern).
# Athletes -> list of session dates (YYYY-MM-DD) to skip entirely.
VELO_MANUAL_EXCLUSIONS = {}
# Re-label a bullpen-derived session (TrackMan has no effort field, so a submax
# bullpen imports as a max-effort "Bullpen"). (athlete, YYYY-MM-DD) -> label; a
# label in VELO_SUBMAX_TYPES (e.g. "Low Effort") also marks it submax so it drops
# out of best/avg/trend but still shows in history.
# LIVE ABs: TrackMan stamps every session "Pitching practice" — it cannot tell a
# bullpen from live at-bats, so the distinction is recorded here by hand. "Live
# AB" is deliberately NOT in VELO_SUBMAX_TYPES: facing hitters is max effort, so
# it still counts toward peak/average velo. It only changes what the session is
# CALLED, on both the velo card and the Bullpen Breakdown.
VELO_BULLPEN_LABELS = {
    ("Ben Wallace", "2026-07-16"): "Low Effort",
    ("Christian Peralta", "2026-08-07"): "Live AB",   # Frank, 2026-08-07
    ("Ben Wallace", "2026-08-07"): "Live AB",         # Frank, 2026-08-07
    ("Mason Morello", "2026-08-07"): "Live AB",       # Frank, 2026-08-07
    ("Eli Delgado", "2026-08-07"): "Live AB",         # Frank, 2026-08-07
    ("Liam Brower", "2026-08-07"): "Live AB",         # Frank, 2026-08-07
    ("Thomas LoBello", "2026-08-07"): "Low Effort",  # low-intent pen (Frank, 2026-08-07)
    ("Eric Grgas", "2026-08-24"): "Low Effort",       # low-intent pen (Frank, 2026-08-24)
    ("Shea O'Sullivan", "2026-08-24"): "Low Effort",  # low-intent pen (Frank, 2026-08-24)
    ("Severino Napolitano", "2026-08-26"): "Live AB",  # Frank, 2026-08-26
    ("Eli Delgado", "2026-08-28"): "Live AB",          # Frank, 2026-08-28
    ("Liam Brower", "2026-08-28"): "Live AB",          # Frank, 2026-08-28
    ("Matthew Mamak", "2026-08-28"): "Live AB",        # Frank, 2026-08-28
    ("Eric Grgas", "2026-08-28"): "Live AB",           # Frank, 2026-08-28
    ("Sebastian Sanchez", "2026-08-28"): "Live AB",    # Frank, 2026-08-28 (new athlete)
    ("Gavin Laya-Vetell", "2026-08-28"): "Rehab",      # flatground/short slope rehab (Frank, 2026-08-28)
    ("Severino Napolitano", "2026-08-31"): "Low Effort",  # low-intent pen (Frank, 2026-08-31)
    ("Eric Grgas", "2026-08-07"): "Live AB",          # Frank, 2026-08-07
    ("Frankie Muzio", "2026-08-07"): "Live AB",       # Frank, 2026-08-07
    # Return-to-throw thrown from the BOTTOM HALF of the portable mound's slope,
    # not off the rubber (Frank, 2026-08-10). First use of the "Rehab" label.
    # Velo is submax by construction here, but the geometry is the harder
    # problem: TrackMan measures extension FROM THE RUBBER, so starting several
    # feet down the slope reports 9.2 ft against a mound norm of ~5.5-7. The
    # extension and release-height numbers are artifacts of where he stood, not
    # measurements of his delivery. Submax keeps it out of best/avg/trend; a matching
    # SESSION_EXCLUSIONS entry in stuff_plus_model/extract_arsenal.py keeps it
    # out of arsenal GRADING. Both are needed - this map does not reach grading.
    ("Johnny Hammer", "2026-08-10"): "Rehab",
    # Very low-intent day: 74.2 peak against an 86.6 best, on a 3-session sample
    # where one pen is a quarter of everything he has (Frank, 2026-08-11).
    ("Jaylen Cruz", "2026-08-11"): "Low Effort",
    ("Thomas LoBello", "2026-08-12"): "Low Effort",   # Frank, 2026-08-12
    ("Christian Peralta", "2026-08-14"): "Live AB",   # Frank, 2026-08-14
    ("Mason Morello", "2026-08-14"): "Live AB",       # Frank, 2026-08-14
    ("Brendan Ott", "2026-08-14"): "Live AB",         # two innings, one date (Frank, 2026-08-14)
    ("Liam Brower", "2026-08-14"): "Live AB",         # Frank, 2026-08-14
    ("KJ Osorio", "2026-08-14"): "Live AB",           # Frank, 2026-08-14
    ("Joe Hauser", "2026-08-14"): "Live AB",          # Frank, 2026-08-14
    ("Eli Delgado", "2026-08-14"): "Live AB",         # Frank, 2026-08-16
    ("Elian Carrasco", "2026-08-14"): "Live AB",      # Frank, 2026-08-16
    ("Angelo Nunes", "2026-08-14"): "Live AB",        # Frank, 2026-08-16
    ("Emrie McLaughlin", "2026-08-14"): "Live AB",    # Frank, 2026-08-16
    ("Eric Grgas", "2026-08-14"): "Live AB",          # Frank, 2026-08-16
    ("Zach Powell", "2026-08-14"): "Live AB",         # Frank, 2026-08-16
    # First official rehab BULLPEN: on the rubber now (ext 6.0 vs the 9.2 of the
    # down-slope 8/10 session) but velo still a ramp at 72-74 (Frank, 2026-08-16).
    ("Johnny Hammer", "2026-08-14"): "Rehab",
    # Pitch-design day for Parikh; plain low-intent for Grgas and Uysal
    # (Frank, 2026-08-17). Matching SESSION_EXCLUSIONS entries ride in
    # stuff_plus_model/extract_arsenal.py -- this map does not reach grading.
    ("Nikhil Parikh", "2026-08-17"): "Low Effort",
    ("Eric Grgas", "2026-08-17"): "Low Effort",
    ("Zachary Uysal", "2026-08-17"): "Low Effort",
    ("Brendan Ott", "2026-08-19"): "Low Effort",       # Frank, 2026-08-19
    # 8/21 live-AB day (Frank, 2026-08-21). Ott threw two innings; one label
    # covers both (velo pools same-date sessions since the 8/14 fix).
    ("Christian Peralta", "2026-08-21"): "Live AB",
    ("Frankie Muzio", "2026-08-21"): "Live AB",
    ("Brendan Ott", "2026-08-21"): "Live AB",
    ("Mason Morello", "2026-08-21"): "Live AB",
    ("Eric Grgas", "2026-08-21"): "Live AB",
    ("Zach Powell", "2026-08-21"): "Live AB",
    ("KJ Osorio", "2026-08-21"): "Live AB",
    ("Frankie Muro", "2026-08-21"): "Live AB",
    ("Joe Hauser", "2026-08-21"): "Live AB",
    ("Zachary Uysal", "2026-08-21"): "Live AB",
    # Final rehab pen before leaving for school (Frank, 2026-08-21).
    ("Darren Espinal", "2026-08-21"): "Rehab",
    # Another rehab pen; the 8/17 max-effort pen stays the held first-pen grade.
    ("Johnny Hammer", "2026-08-21"): "Rehab",
    # Pitch-design / lower-intent day (Frank, 2026-08-24).
    ("KJ Osorio", "2026-08-24"): "Low Effort",
    # Rehab progression; partly off the mound but mixed with down-slope throws
    # in one session, ext 10.6-12.5 (Frank, 2026-08-18).
    ("Darren Espinal", "2026-08-18"): "Rehab",
}
# NOTE (2026-08-11): every "Low Effort" / "Rehab" entry above needs a matching
# SESSION_EXCLUSIONS entry in stuff_plus_model/extract_arsenal.py. This map gates
# velo best/avg/trend ONLY and does not reach arsenal grading, so a session
# labelled here still feeds Shape+ unless it is ALSO excluded there. Audited on
# this date: all three low-effort pens on record had been grading normally since
# the label was introduced (Wallace -3 Shape+, Cruz -3, LoBello unaffected).

# ─── Load Data ───────────────────────────────────────────────────────────────

with open(PORTAL_JSON) as f:
    fd = json.load(f)

# ─── Duplicate VALD profiles ────────────────────────────────────────────────
# Same human, two profileIds in the Hub — every downstream array keys off the
# profile, so the athlete renders twice (search, standings, velo model, the
# Impulse board). Drop the redundant profile HERE, at load, so one edit covers
# every consumer. Only list a profile after verifying its tests are a strict
# subset of the survivor's; the note records that check.
DUPLICATE_PROFILES = {
    # Mason Morello: orphan profile, no group set, 11 tests all byte-identical
    # to the kept profile 640def2a (which also has 8/04 and carries the Pro
    # group). Verified strict subset 2026-08-04. Frank to merge in the Hub;
    # this stays harmless once he does.
    "a9018134-2fae-4677-9ba6-e6a142960475": "Mason Morello (dupe of 640def2a)",
}
_dropped = [(pid, why) for pid, why in DUPLICATE_PROFILES.items() if pid in fd.get('athletes', {})]
for pid, why in _dropped:
    del fd['athletes'][pid]
if _dropped:
    print(f"  Dropped {len(_dropped)} duplicate VALD profile(s): "
          + "; ".join(why for _, why in _dropped), flush=True)

with open(CURRENT_JSX) as f:
    jsx = f.read()

# Trackman is optional — generator stays backwards-compatible if missing.
trackman = None
if os.path.exists(TRACKMAN_JSON):
    with open(TRACKMAN_JSON) as f:
        trackman = json.load(f)

# ─── Extract group mapping from existing _A ──────────────────────────────────

def extract_groups_from_jsx(jsx):
    """Pull name→group from existing _A array."""
    import re
    start = jsx.find('const _A = ') + len('const _A = ')
    end = jsx.find(';\n', start)
    _a = json.loads(jsx[start:end])
    groups = {}
    for a in _a:
        groups[a[0]] = a[2]
    # Also get from _HA
    start = jsx.find('const _HA = ') + len('const _HA = ')
    end = jsx.find(';\n', start)
    _ha = json.loads(jsx[start:end])
    for a in _ha:
        if a[0] not in groups:
            groups[a[0]] = a[2]
    return groups

GROUP_MAP = extract_groups_from_jsx(jsx)

# Athletes to exclude from portal
EXCLUDE_ATHLETES = {"Liam Murphy", "Steph Staiano"}
_EXCL_NORM = {" ".join(n.split()).lower() for n in EXCLUDE_ATHLETES}

def is_excluded(name):
    return " ".join((name or "").split()).lower() in _EXCL_NORM

# Manual group overrides — these always win, even over VALD.
# Keep this for athletes whose VALD group is wrong or who aren't yet in VALD.
# Round-4 integrity adjudications (Frank's VALD Hub pass, 2026-08-11): these
# athletes' best RSI-mod values were human-verified as REAL countermovement-
# depth strategy reps, not mis-segmented artifacts. The quadrant guard skips
# an athlete only while his best stays at/below this value; any future spike
# above it re-flags. Consumed by gen_QUAD here and by Pitch Model/
# build_cmj_quadrants.py (which parses this dict from source).
ADJUDICATED_RSI = {
    "Aaron Gonzalez": 1.01, "Aaron Liriano": 0.43, "Ayden Soehngen": 0.61,
    "Dylan Mackay": 0.66, "Francesca  Albergo": 0.59, "Frankie Sturiano": 0.69,
    "Jace Congemi": 0.70, "Jason Mendez": 0.65, "Jason Peacock": 0.95,
    "Jayleen Torres": 0.70, "Lucas Garcia": 0.53, "Matthew Mamak": 0.72,
    "Toren Choudri": 1.22, "Vincent Schlosser": 0.72, "Westry Robinson": 0.57,
    "Yadi Molina": 0.34,
}

GROUP_OVERRIDES = {
    "Nick Padilla": "pro",
    "Cade Winquest": "pro",
    "Pete Hansen": "pro",
    "Matt Bowman": "pro",
    "Julian Minaya": "pro",
    "Mike Sirota": "pro",
    "Mason Morello": "pro",
    # College pitchers
    "Joe Hauser": "col",
    "Michael Destefano": "col",
    "Shea O'Sullivan": "col",
    "Addison Hinz-Camarano": "col",
    # Starts college September 2026 (Frank, 2026-08-02): rank with the
    # college pool from now on. Blind stuff-slot and arsenal grade use the
    # college board too.
    "Rob Stingone": "col",
    "Zach Weinschel": "col",
    # Arrived bullpen-first, so the velo pipeline defaulted him to HS before any
    # plate data existed and that default went sticky (Frank, 2026-08-04).
    "Alex Rodriguez": "col",
    # Bullpen-first, so the velo pipeline defaulted him to HS (Frank, 2026-08-06).
    "Brendan Ott": "col",
    "Darren Espinal": "col",
    "Jackson Mavrides": "col",
    "Severino Napolitano": "col",
    # Evaluation pen was his first contact with us, so no plate data existed to
    # set a level from and the pipeline defaulted him to HS (Frank, 2026-08-10).
    "KJ Osorio": "col",
    # Middle school
    "Josh Miller": "ms",
    # Men's league
    "Carlos Solorzano": "ml",
}

# Female athletes (Frank's definitive roster, 2026-07-08). They KEEP their
# school group as the primary classification (rankings, card color, percentile
# comparisons) and are additionally labeled/filterable as Female Athletes:
# they feed the 'fem' norms alongside their school group's, get a FEM badge,
# and match the Female Athletes filter. Matching collapses whitespace (the
# VALD data has e.g. "Francesca  Albergo" with a double space).
FEMALE_ATHLETES = {
    "Alannah Behler", "Francesca Albergo", "Nicole Berinato", "Victoria Barrientos",
    "Grace Bekios", "Bella Cafasso", "Sophia Conrath", "Barbara DiMaria",
    "Niki Eckert", "Samantha Hartwig", "Aryanna Hernandez", "Tiana Hernandez",
    "Lyla Kondel", "Amber Mangold", "Scarlett Molina", "Diem Nenadich",
    "Angelina Pardo", "Olivia Pichardo", "Anaya Sanchez", "Olivia Santiago",
    "Lily Sheehan", "Jayleen Torres", "Morgan Wallace", "Amy Welsh",
}
_FEM_NORM = {" ".join(n.split()).lower() for n in FEMALE_ATHLETES}

def is_female(name):
    return " ".join((name or "").split()).lower() in _FEM_NORM


# Map VALD group names → portal short codes.
# Edit this if you rename a group in VALD or add a new group.
VALD_GROUP_TO_CODE = {
    "Pro":             "pro",
    "Staff":           "stf",
    "College":         "col",
    "High School":     "hs",
    "Middle School":   "ms",
    "Men's League":    "ml",
    "Female Athletes": "fem",
}

# Priority for athletes who belong to multiple VALD groups.
# Highest priority wins. Example: a college female who is in both
# "College" and "Female Athletes" will be classified as "col".
# Reorder this list if you want different behavior.
GROUP_PRIORITY = ["pro", "stf", "col", "ml", "hs", "ms", "fem"]


def get_group(name, vald_groups=None):
    # 1. Manual overrides always win.
    if name in GROUP_OVERRIDES:
        return GROUP_OVERRIDES[name]
    # 2. Use VALD group memberships when available.
    if vald_groups:
        codes = {VALD_GROUP_TO_CODE[g] for g in vald_groups if g in VALD_GROUP_TO_CODE}
        if codes:
            for code in GROUP_PRIORITY:
                if code in codes:
                    return code
            return next(iter(codes))
    # 3. Fall back to whatever group this name had in the previous App.jsx,
    #    then to "hs" if completely unknown.
    return GROUP_MAP.get(name, "hs")

def get_initials(name):
    parts = name.strip().split()
    if len(parts) >= 2:
        return (parts[0][0] + parts[-1][0]).upper()
    return name[:2].upper()


# ─── Process CMJ Sessions ────────────────────────────────────────────────────

def compute_session_avg(trials, metric_key):
    """Average of a metric across all trials in a test."""
    vals = []
    for tr in trials:
        v = tr['metrics'].get(metric_key)
        if v is not None:
            vals.append(v)
    return round(sum(vals) / len(vals), 2) if vals else None

def compute_session_best(trials, metric_key):
    """Best (max) of a metric across all trials in a test."""
    vals = []
    for tr in trials:
        v = tr['metrics'].get(metric_key)
        if v is not None:
            vals.append(v)
    return round(max(vals), 2) if vals else None

def compute_session_brk_avg(trials):
    """Session braking value = mean of Eccentric Deceleration Mean Force / BW
    (×BW) across all trials. A reliable per-trial mean force (not a rate), so the
    session average is a stable, parent-legible read on eccentric braking."""
    vals = [tr['metrics'].get('brakingForceBW') for tr in trials]
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None

def compute_session_asym(trials, base_key):
    """Average asymmetry for a metric across trials. Returns (pct, dominant_side, left_val, right_val)."""
    pcts = []
    l_vals = []
    r_vals = []
    for tr in trials:
        m = tr['metrics']
        lv = m.get(f'{base_key}Left')
        rv = m.get(f'{base_key}Right')
        if lv is not None and rv is not None:
            l_vals.append(lv)
            r_vals.append(rv)
            mx = max(abs(lv), abs(rv))
            if mx > 0:
                pcts.append(round(abs(rv - lv) / mx * 100, 1))
    if not pcts:
        return None, None, None, None
    avg_pct = round(sum(pcts) / len(pcts), 1)
    avg_l = round(sum(l_vals) / len(l_vals))
    avg_r = round(sum(r_vals) / len(r_vals))
    dom = "R" if avg_r > avg_l else "L" if avg_l > avg_r else "="
    return avg_pct, dom, avg_l, avg_r


# ─── Build Athlete CMJ Data ─────────────────────────────────────────────────

athletes_data = []

for pid, ath in fd['athletes'].items():
    name = ath['name']
    if not name or is_excluded(name):
        continue
    
    cmj_tests = [t for t in ath['tests'] if t['testType'] == 'CMJ' and t['trials']]
    if not cmj_tests:
        continue
    
    # Sort by date descending (should already be, but ensure)
    cmj_tests.sort(key=lambda t: t['date'], reverse=True)
    
    # Session averages for all sessions
    sessions = []
    for test in cmj_tests:
        dt_str = test['date'][:10]
        try:
            dt = datetime.strptime(dt_str, '%Y-%m-%d')
        except:
            continue
        
        jh = compute_session_best(test['trials'], 'jumpHeight')
        rsi = compute_session_best(test['trials'], 'rsiModified')
        # 'pp' slot carries NET CONCENTRIC IMPULSE (N·s) — matching VALD Hub's
        # headline "Concentric Impulse" number (Frank verified 239 for Christian
        # Sanchez; L+R limb fields are GROSS impulse incl. bodyweight support,
        # nearly 2x higher, and the base trial field stores the asym value).
        # Net impulse = mass x takeoff velocity = m * sqrt(2*g*h), which
        # reproduces VALD Hub's value exactly from jump height + bodyweight.
        ci_vals = []
        for tr in test['trials']:
            jh_t, bw_t = tr['metrics'].get('jumpHeight'), tr['metrics'].get('bodyweightLbs')
            if jh_t and bw_t:
                ci_vals.append((bw_t * 0.45359) * (2 * 9.81 * jh_t * 0.0254) ** 0.5)
        pp = round(max(ci_vals), 1) if ci_vals else None
        brk = compute_session_brk_avg(test['trials'])
        bw = compute_session_avg(test['trials'], 'bodyweightLbs')
        depth_raw = compute_session_avg(test['trials'], 'cmDepth')  # signed cm (neg = deeper)
        depth = round(abs(depth_raw), 1) if depth_raw else None      # store as positive cm for display
        # Physicality-radar metrics (pinned in vald_sync 2026-07-23):
        pkw = compute_session_best(test['trials'], 'peakPower')          # W
        pkwbm = compute_session_best(test['trials'], 'relativePower')    # W/kg (Peak Power / BM)
        cmpbm = compute_session_best(test['trials'], 'conMeanPowerBM')   # W/kg
        ci100 = compute_session_best(test['trials'], 'conImpulse100')    # N·s in first 100ms
        
        # Asymmetry
        con_asym, con_dom, con_l, con_r = compute_session_asym(test['trials'], 'concentricImpulse')
        ecc_asym, ecc_dom, ecc_l, ecc_r = compute_session_asym(test['trials'], 'eccBrakingImpulse')
        cpf_asym, cpf_dom, cpf_l, cpf_r = compute_session_asym(test['trials'], 'concPeakForce')
        
        sessions.append({
            'date': dt,
            'date_str': dt.strftime('%m/%d/%Y'),
            'jh': jh, 'rsi': rsi, 'pp': pp, 'brk': brk, 'bw': bw, 'depth': depth,
            'pkw': pkw, 'pkwbm': pkwbm, 'cmpbm': cmpbm, 'ci100': ci100,
            'con_asym': con_asym, 'con_dom': con_dom, 'con_l': con_l, 'con_r': con_r,
            'ecc_asym': ecc_asym, 'ecc_dom': ecc_dom,
            'cpf_asym': cpf_asym, 'cpf_dom': cpf_dom,
        })
    
    if not sessions:
        continue
    
    athletes_data.append({
        'name': name,
        'pid': pid,
        'group': get_group(name, ath.get('groups')),
        'initials': get_initials(name),
        'sessions': sessions,
    })
# ─── Filter out statistical-outlier sessions (force-plate misreads) ──────────
# Robust per-athlete, per-metric filter using the MEDIAN and MAD (median
# absolute deviation) instead of mean/standard-deviation. mean+SD is fooled when
# an athlete has 2+ bad reads: the outliers inflate BOTH the mean and the SD, so
# they mask each other and slip through a 3-SD test (this is exactly how Timmy
# Stines' 26.2"/24.8" CMJ misreads got published next to his real ~13" jumps).
# MAD is resistant to multiple outliers, so it catches them.
#
# OUTLIER_OVERRIDES disables filtering for a given athlete+metric — use it when
# an athlete legitimately has extreme-but-real values you don't want dropped.
OUTLIER_OVERRIDES = {
    "Rocco Rossi": ["rsi"],
}
# A value is dropped as a misread when EITHER:
#   (1) it falls outside hard physiological bounds (a sensor error no matter
#       what the athlete's history looks like), OR
#   (2) it is BOTH a robust-statistical outlier (>3.5 MAD from the median) AND
#       deviates from the athlete's own median by more than a per-metric margin.
# The AND in (2) is the key guardrail: a consistent athlete has a tiny MAD, so a
# genuinely good day can look like a 3.5-sigma outlier — but a real day-to-day
# swing is small in PERCENT terms, while a misread is huge (Timmy's 26" is +79%
# over his ~14.6" median). Requiring both spares real performance and still
# catches the impossible reads.
ROBUST_Z_CUTOFF = 3.5     # robust "standard deviations" from the median
_MAD_TO_SD = 1.4826       # scales MAD onto a normal-SD footing
PCT_FROM_MEDIAN = {       # how far from the athlete's median = implausible
    'jh':  0.40,          # CMJ jump height — tight; real session-to-session <~30%
    'pp':  0.40,          # concentric impulse — fairly stable
    'rsi': 0.55,          # RSI-modified — a bit noisier
    'brk': 0.80,          # eccentric braking RFD — genuinely noisy, stay loose
    'bw':  0.25,          # bodyweight — very stable; a 25%+ single-session swing = scale misread
}
ABS_BOUNDS = {            # hard sanity bounds; outside = sensor error, always drop
    'jh':  (2.0, 50.0),   # inches
    'rsi': (0.0, 5.0),    # RSI-mod realistically maxes well under 5
    'pp':  (30.0, 500.0), # net concentric impulse, N·s
    'bw':  (50.0, 400.0), # lbs — no RPM athlete is under 50 lb, so sub-50 = misread even at low session counts
}                         # 'brk' intentionally omitted — too variable for a fixed bound

def _impossible(metric, v):
    lo, hi = ABS_BOUNDS.get(metric, (None, None))
    return lo is not None and (v < lo or v > hi)


def _filter_one_metric(athletes, metric, log):
    """Apply the same robust misread filter to a single metric across a list of
    athletes. Used to extend bodyweight filtering to the hop pipeline (a scale
    misread shows up in both CMJ and hop, which are built separately)."""
    pct = PCT_FROM_MEDIAN.get(metric, 0.50)
    for ath in athletes:
        vals = [s[metric] for s in ath['sessions'] if s.get(metric) is not None]
        if len(vals) < 3:
            for s in ath['sessions']:
                v = s.get(metric)
                if v is not None and _impossible(metric, v):
                    log.append((ath['name'], metric, s['date_str'], v, None, None, False))
                    s[metric] = None
            continue
        med = statistics.median(vals)
        mad = statistics.median([abs(v - med) for v in vals])
        mean = sum(vals) / len(vals)
        std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        scale = _MAD_TO_SD * mad if mad > 0 else std
        for s in ath['sessions']:
            v = s.get(metric)
            if v is None:
                continue
            robust_out = scale > 0 and abs(v - med) / scale > ROBUST_Z_CUTOFF
            big_dev = med > 0 and abs(v - med) / med > pct
            if _impossible(metric, v) or (robust_out and big_dev):
                rz = round(abs(v - med) / scale, 1) if scale > 0 else None
                log.append((ath['name'], metric, s['date_str'], v, round(med, 2), rz, False))
                s[metric] = None

_misread_log = []   # (name, metric, date, value, median, robust_z, caught_by_old_filter)
for ath in athletes_data:
    skip = OUTLIER_OVERRIDES.get(ath['name'], [])
    for metric in ['jh', 'rsi', 'pp', 'brk', 'bw']:
        if metric in skip:
            continue
        vals = [s[metric] for s in ath['sessions'] if s.get(metric) is not None]
        # With 1-2 readings there's no basis for a relative outlier test, so only
        # hard physiological bounds apply. The robust median/MAD test kicks in at 3+
        # (was 5) so athletes with just a handful of sessions — e.g. a middle-schooler
        # with 4 tests and one 42.8 lb scale misread — are still protected.
        if len(vals) < 3:
            for s in ath['sessions']:
                v = s.get(metric)
                if v is not None and _impossible(metric, v):
                    _misread_log.append((ath['name'], metric, s['date_str'], v,
                                         None, None, False))
                    s[metric] = None
            continue
        med = statistics.median(vals)
        mad = statistics.median([abs(v - med) for v in vals])
        # Old mean/SD numbers: back-stop the degenerate MAD==0 case and flag in
        # the preview report which misreads the old mean/SD filter would miss.
        mean = sum(vals) / len(vals)
        std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
        scale = _MAD_TO_SD * mad if mad > 0 else std   # fall back to SD if MAD==0
        pct = PCT_FROM_MEDIAN.get(metric, 0.50)
        for s in ath['sessions']:
            v = s.get(metric)
            if v is None:
                continue
            robust_out = scale > 0 and abs(v - med) / scale > ROBUST_Z_CUTOFF
            big_dev = med > 0 and abs(v - med) / med > pct
            if _impossible(metric, v) or (robust_out and big_dev):
                caught_by_old = std > 0 and abs(v - mean) > 3 * std
                rz = round(abs(v - med) / scale, 1) if scale > 0 else None
                _misread_log.append((ath['name'], metric, s['date_str'], v,
                                     round(med, 2), rz, caught_by_old))
                s[metric] = None

# Optional preview report: set MISREAD_REPORT=<path> to dump everything this
# filter excluded, flagging which the previous mean/SD filter would have missed.
if os.environ.get("MISREAD_REPORT"):
    _new_only = [r for r in _misread_log if not r[6]]
    with open(os.environ["MISREAD_REPORT"], "w") as _rf:
        _rf.write(f"Sessions excluded as misreads: {len(_misread_log)}\n")
        _rf.write(f"Newly caught (old mean/SD filter MISSED these): {len(_new_only)}\n\n")
        _rf.write(f"{'Athlete':<24}{'metric':<7}{'date':<12}{'value':>10}{'median':>9}{'robustZ':>9}  new?\n")
        for name, metric, date_str, v, med, rz, old in sorted(_misread_log, key=lambda r: (r[0], r[1], r[2])):
            med_s = '—' if med is None else f"{med}"
            rz_s = 'bound' if rz is None else f"{rz}"
            _rf.write(f"{name:<24}{metric:<7}{date_str:<12}{v:>10}{med_s:>9}{rz_s:>9}  {'' if old else 'NEW'}\n")
    print(f"Misread report -> {os.environ['MISREAD_REPORT']} "
          f"({len(_misread_log)} excluded, {len(_new_only)} newly caught)", flush=True)

# Filter out athletes with no test in the last 6 weeks
athletes_data = [a for a in athletes_data if a['sessions'][0]['date'] >= ACTIVE_CUTOFF]
# Sort athletes by name
athletes_data.sort(key=lambda a: a['name'])


# ─── Build Athlete Hop Test Data ─────────────────────────────────────────────

def hop_best(trials, key):
    vals = [t['metrics'].get(key) for t in trials]
    vals = [v for v in vals if v is not None]
    return round(max(vals), 2) if vals else None

def hop_avg(trials, key):
    vals = [t['metrics'].get(key) for t in trials]
    vals = [v for v in vals if v is not None]
    return round(sum(vals) / len(vals), 2) if vals else None

def hop_min(trials, key):
    """For metrics where lower is better (e.g. contact time)."""
    vals = [t['metrics'].get(key) for t in trials]
    vals = [v for v in vals if v is not None]
    return round(min(vals), 2) if vals else None

hop_athletes_data = []
for pid, ath in fd['athletes'].items():
    name = ath['name']
    if not name or is_excluded(name):
        continue

    hj_tests = [t for t in ath['tests'] if t['testType'] == HOP_TEST_TYPE and t['trials']]
    # Apply manual session exclusions (suspect tests pending confirmation)
    excluded_dates = set(HOP_MANUAL_EXCLUSIONS.get(name, []))
    if excluded_dates:
        hj_tests = [t for t in hj_tests if t['date'][:10] not in excluded_dates]
    if not hj_tests:
        continue

    hj_tests.sort(key=lambda t: t['date'], reverse=True)

    # Per-athlete misread filters (per-athlete relative thresholds):
    #   FT > 1.5× median FT  →  athlete jumped off the plate (sensor missed landing).
    #   CT < 0.6× median CT  →  sensor missed takeoff/landing edge (impossibly short contact).
    # Both inflate RSI = FT/CT, so we drop those trials before picking the best.
    all_ft = [
        tr['metrics'].get(HOP_FT_KEY)
        for test in hj_tests for tr in test['trials']
        if tr['metrics'].get(HOP_FT_KEY) is not None
    ]
    all_ct = [
        tr['metrics'].get(HOP_CT_KEY)
        for test in hj_tests for tr in test['trials']
        if tr['metrics'].get(HOP_CT_KEY) is not None
    ]
    ft_ceiling = (statistics.median(all_ft) * 1.5) if all_ft else float('inf')
    # Hard global floor of 100ms backstops athletes with too-few trials for a stable median.
    ct_floor = max(statistics.median(all_ct) * 0.6, 100) if all_ct else 100

    sessions = []
    for test in hj_tests:
        dt_str = test['date'][:10]
        try:
            dt = datetime.strptime(dt_str, '%Y-%m-%d')
        except:
            continue

        # Drop misread trials, then pick the single best-RSI trial of this test.
        # All metrics for this session come from THAT trial — no cross-trial mixing.
        valid = [
            tr for tr in test['trials']
            if tr['metrics'].get(HOP_FT_KEY) is not None
            and tr['metrics'][HOP_FT_KEY] <= ft_ceiling
            and tr['metrics'].get(HOP_CT_KEY) is not None
            and tr['metrics'][HOP_CT_KEY] >= ct_floor
            and tr['metrics'].get(HOP_RSI_KEY) is not None
        ]
        if not valid:
            continue

        best = max(valid, key=lambda tr: tr['metrics'][HOP_RSI_KEY])
        m = best['metrics']
        rsi = round(m[HOP_RSI_KEY], 2)
        ct = round(m[HOP_CT_KEY], 2)
        ft = round(m[HOP_FT_KEY], 2)
        # Bodyweight averaged across all trials in this test (not affected by misreads).
        bw_vals = [tr['metrics'].get('bodyweightLbs') for tr in test['trials']]
        bw_vals = [v for v in bw_vals if v is not None]
        bw = round(sum(bw_vals) / len(bw_vals), 2) if bw_vals else None
        # True PFBM = whole-set mean peak force (L+R total, averaged over all hops)
        # / (BW_kg × g), giving body-weight units — consistent with the whole-set
        # RSI/CT/FT above. NOTE: VALD's bare `hopPeakForce` field is L/R asymmetry %.
        pf = m.get('hopSetMeanPeakForce')
        if pf is not None and bw:
            bw_kg = bw / LB_PER_KG
            pfbm = round(pf / (bw_kg * G), 2)
        else:
            pfbm = None

        sessions.append({
            'date': dt,
            'date_str': dt.strftime('%m/%d/%Y'),
            'rsi': rsi, 'ct': ct, 'ft': ft, 'pfbm': pfbm, 'bw': bw,
        })

    if not sessions:
        continue

    hop_athletes_data.append({
        'name': name,
        'pid': pid,
        'group': get_group(name, ath.get('groups')),
        'initials': get_initials(name),
        'sessions': sessions,
    })

# Bodyweight is measured by the same force plate for hop tests, so a scale misread
# (e.g. Scarlett Molina's 42.8 lb) lands in the hop pipeline too — apply the same
# bodyweight filter here. pfbm divides by bodyweight, so null it on any session
# whose bodyweight we drop (its value is derived from the bad reading).
_filter_one_metric(hop_athletes_data, 'bw', _misread_log)
for ath in hop_athletes_data:
    for s in ath['sessions']:
        if s.get('bw') is None:
            s['pfbm'] = None

# Filter out hop athletes with no test in the last 6 weeks (matches CMJ behavior)
hop_athletes_data = [a for a in hop_athletes_data if a['sessions'][0]['date'] >= ACTIVE_CUTOFF]
# Sort by name
hop_athletes_data.sort(key=lambda a: a['name'])


# ─── Generate _A Array ───────────────────────────────────────────────────────

def _latest_valid(sessions, key):
    """Most recent non-None value for a metric (sessions are newest-first).
    Used so a misread that was nulled by the outlier filter falls back to the
    athlete's last real reading instead of displaying 0."""
    for sess in sessions:
        if sess.get(key) is not None:
            return sess[key]
    return None


REF_DEPTH = 31.0  # cm — facility-median countermovement depth; reference for depth-adjusting braking
def _depth_adj_brk(sessions):
    """Depth-adjusted latest braking (coach view): normalize the latest session's
    braking force to REF_DEPTH using the athlete's OWN braking-vs-depth slope, so a
    change in dip strategy doesn't read as a strength change (see Rob Stingone). A
    per-athlete detrend — the only thing that removes the confound, since it points
    different directions for different athletes. Falls back to raw braking when
    there's too little data / depth variation to fit a reliable slope."""
    pts = [(x['depth'], x['brk']) for x in sessions if x.get('depth') and x.get('brk')]
    latest = next((x for x in sessions if x.get('depth') and x.get('brk')), None)
    if not latest:
        return None
    if len(pts) >= 5:
        ds = [p[0] for p in pts]; bs = [p[1] for p in pts]
        md = sum(ds) / len(ds); mb = sum(bs) / len(bs)
        var = sum((d - md) ** 2 for d in ds)
        if var > 5:  # enough depth spread to trust a slope
            slope = sum((d - md) * (b - mb) for d, b in pts) / var
            return round(latest['brk'] - slope * (latest['depth'] - REF_DEPTH), 2)
    return latest['brk']

def gen_A(athletes_data):
    """_A: [name, initials, group, bw, testCount, latestDate, jh, rsi, pp, brk, jhHist, rsiHist,
            bestJH, bestRSI, bestPP, bestBRK, jhHist_d, rsiHist_d, depth(cm), adjBrk(×BW @ ref depth)]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        latest = s[0]

        test_count = len(s)
        latest_date = latest['date_str']
        bw_v, jh_v, rsi_v, pp_v, brk_v = (_latest_valid(s, k) for k in ('bw', 'jh', 'rsi', 'pp', 'brk'))
        bw = round(bw_v, 1) if bw_v else 0
        jh = r1u(jh_v) if jh_v else 0
        rsi = round(rsi_v, 2) if rsi_v else 0
        pp = round(pp_v, 1) if pp_v else 0
        brk = brk_v or 0
        
        # History (last 8 sessions, oldest to newest)
        hist = s[:HISTORY_LEN]
        hist.reverse()
        jh_hist = [r1u(h['jh']) for h in hist if h['jh'] is not None]
        rsi_hist = [round(h['rsi'], 2) for h in hist if h['rsi'] is not None]
        # Dates paired 1:1 with each (filtered) history above — the profile
        # sparklines previously indexed the athlete's FULL session-date list,
        # so hover labels showed their first-ever sessions (e.g. Tyler Koenig's
        # recent jumps labeled 08/2025).
        jh_hist_d = [h['date_str'] for h in hist if h['jh'] is not None]
        rsi_hist_d = [h['date_str'] for h in hist if h['rsi'] is not None]
        
        # All-time bests
        all_jh = [h['jh'] for h in s if h['jh'] is not None]
        all_rsi = [h['rsi'] for h in s if h['rsi'] is not None]
        all_pp = [h['pp'] for h in s if h['pp'] is not None]
        all_brk = [h['brk'] for h in s if h['brk'] is not None]
        
        best_jh = r1u(max(all_jh)) if all_jh else 0
        best_rsi = round(max(all_rsi), 2) if all_rsi else 0
        best_pp = round(max(all_pp), 1) if all_pp else 0
        best_brk = max(all_brk) if all_brk else 0
        
        depth_v = _latest_valid(s, 'depth')
        depth = round(depth_v, 1) if depth_v else 0
        adj_brk = _depth_adj_brk(s) or 0

        rows.append([
            ath['name'], ath['initials'], ath['group'], bw, test_count, latest_date,
            jh, rsi, pp, brk, jh_hist, rsi_hist,
            best_jh, best_rsi, best_pp, best_brk,
            jh_hist_d, rsi_hist_d, depth, adj_brk
        ])
    
    return rows


# ─── Generate _PB Array ─────────────────────────────────────────────────────

def gen_PB(athletes_data):
    """_PB: per athlete, [allJH, allRSI, allPP, allBRK, tmJH, tmRSI, tmPP, tmBRK, lmJH, lmRSI, lmPP, lmBRK, twJH, twRSI, twPP, twBRK]
    tm=this month, lm=last month, tw=this week"""
    now = datetime.now()
    # Normalize to midnight: now.replace(day=1) keeps the time-of-day, which
    # silently excluded sessions dated the 1st of the month from "This Month".
    this_month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
    last_month_end = this_month_start - timedelta(seconds=1)
    # This week = last 7 days
    this_week_start = now - timedelta(days=7)
    
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        
        def best_in_range(sessions, start_dt=None, end_dt=None):
            filtered = sessions
            if start_dt:
                filtered = [x for x in filtered if x['date'] >= start_dt]
            if end_dt:
                filtered = [x for x in filtered if x['date'] <= end_dt]
            if not filtered:
                return [None, None, None, None]
            jh_vals = [x['jh'] for x in filtered if x['jh'] is not None]
            rsi_vals = [x['rsi'] for x in filtered if x['rsi'] is not None]
            pp_vals = [x['pp'] for x in filtered if x['pp'] is not None]
            brk_vals = [x['brk'] for x in filtered if x['brk'] is not None]
            return [
                round(max(jh_vals), 1) if jh_vals else None,
                round(max(rsi_vals), 2) if rsi_vals else None,
                round(max(pp_vals), 1) if pp_vals else None,
                max(brk_vals) if brk_vals else None,
            ]
        
        all_best = best_in_range(s)
        tm_best = best_in_range(s, this_month_start)
        lm_best = best_in_range(s, last_month_start, last_month_end)
        tw_best = best_in_range(s, this_week_start)
        
        rows.append(all_best + tm_best + lm_best + tw_best)
    
    return rows


# ─── Generate _T Array (Trends) ─────────────────────────────────────────────

def gen_T(athletes_data):
    """_T: [name, group, sessions, jh_first, jh_last, jh_change, rsi_first, rsi_last, rsi_change, pp_first, pp_last, pp_change, brk_first, brk_last, brk_change]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        
        first = s[-1]  # oldest
        last = s[0]    # newest
        
        def change_pct(old, new):
            if old and new and old != 0:
                return round((new - old) / abs(old) * 100, 1)
            return 0
        
        jh_f = r1u(first['jh']) if first['jh'] else 0
        jh_l = r1u(last['jh']) if last['jh'] else 0
        rsi_f = round(first['rsi'], 2) if first['rsi'] else 0
        rsi_l = round(last['rsi'], 2) if last['rsi'] else 0
        pp_f = round(first['pp'], 1) if first['pp'] else 0
        pp_l = round(last['pp'], 1) if last['pp'] else 0
        brk_f = first['brk'] or 0
        brk_l = last['brk'] or 0
        
        rows.append([
            ath['name'], ath['group'], len(s),
            jh_f, jh_l, change_pct(jh_f, jh_l),
            rsi_f, rsi_l, change_pct(rsi_f, rsi_l),
            pp_f, pp_l, change_pct(pp_f, pp_l),
            brk_f, brk_l, change_pct(brk_f, brk_l),
        ])
    
    return rows


# ─── Generate _WM Array (Weekly Movers) ─────────────────────────────────────

# Physicality metrics that ride the trending sections as a trailing per-row
# dict {key: [prev, curr, change%]} — appended so existing positional indices
# never shift. bw is included (weight-gain tracking) but PRs skip it.
PHY_TREND_ROUND = {'pp': 1, 'ci100': 1, 'pkw': 0, 'pkwbm': 1, 'cmpbm': 1, 'bw': 1}
def _tr_round(k, v):
    if v is None:
        return 0
    return round(v) if PHY_TREND_ROUND[k] == 0 else round(v, PHY_TREND_ROUND[k])
def _tr_chg(old, new):
    return round((new - old) / abs(old) * 100, 1) if old else 0
def _tr_dict(prev_sess, curr_sess, keys=('pp', 'ci100', 'pkw', 'pkwbm', 'cmpbm', 'bw')):
    out = {}
    for k in keys:
        p = _tr_round(k, prev_sess.get(k))
        c = _tr_round(k, curr_sess.get(k))
        out[k] = [p, c, _tr_chg(p, c)]
    return out


def gen_WM(athletes_data):
    """_WM: [name, initials, group, jhPrev, jhCurr, jhChange%, rsiPrev, rsiCurr, rsiChange%, prevDate, currDate]"""
    week_ago = datetime.now() - timedelta(days=7)
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        
        curr = s[0]
        prev = s[1]
        # The section is titled "This Week" — only count athletes whose most
        # recent session actually happened in the last 7 days. Previously an
        # athlete whose last two sessions were months old still ranked here.
        if curr['date'] < week_ago:
            continue
        
        jh_c = r1u(curr['jh']) if curr['jh'] else 0
        jh_p = r1u(prev['jh']) if prev['jh'] else 0
        rsi_c = round(curr['rsi'], 2) if curr['rsi'] else 0
        rsi_p = round(prev['rsi'], 2) if prev['rsi'] else 0
        
        jh_chg = round((jh_c - jh_p) / jh_p * 100, 1) if jh_p else 0
        rsi_chg = round((rsi_c - rsi_p) / rsi_p * 100, 1) if rsi_p else 0
        
        rows.append([
            ath['name'], ath['initials'], ath['group'],
            jh_p, jh_c, jh_chg, rsi_p, rsi_c, rsi_chg,
            prev['date_str'], curr['date_str'],
            _tr_dict(prev, curr),
        ])
    
    return rows


# ─── Generate _MH Array (Monthly Highlights) ────────────────────────────────

def gen_MH(athletes_data):
    """_MH: [name, initials, group, jhPrev, jhCurr, jhChange%, rsiPrev, rsiCurr, rsiChange%]
    Compares this month avg vs last month avg."""
    now = datetime.now()
    tm_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    lm_start = (tm_start - timedelta(days=1)).replace(day=1)
    lm_end = tm_start - timedelta(seconds=1)
    
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        tm = [x for x in s if x['date'] >= tm_start]
        lm = [x for x in s if lm_start <= x['date'] <= lm_end]
        
        if not tm or not lm:
            continue
        
        tm_jh_vals = [x['jh'] for x in tm if x['jh'] is not None]
        lm_jh_vals = [x['jh'] for x in lm if x['jh'] is not None]
        tm_rsi_vals = [x['rsi'] for x in tm if x['rsi'] is not None]
        lm_rsi_vals = [x['rsi'] for x in lm if x['rsi'] is not None]
        
        if not tm_jh_vals or not lm_jh_vals:
            continue
        
        tm_jh = round(sum(tm_jh_vals) / len(tm_jh_vals), 1)
        lm_jh = round(sum(lm_jh_vals) / len(lm_jh_vals), 1)
        tm_rsi = round(sum(tm_rsi_vals) / len(tm_rsi_vals), 2) if tm_rsi_vals else 0
        lm_rsi = round(sum(lm_rsi_vals) / len(lm_rsi_vals), 2) if lm_rsi_vals else 0
        
        jh_chg = round((tm_jh - lm_jh) / lm_jh * 100, 1) if lm_jh else 0
        rsi_chg = round((tm_rsi - lm_rsi) / lm_rsi * 100, 1) if lm_rsi else 0
        
        md = {}
        for k in ('pp', 'ci100', 'pkw', 'pkwbm', 'cmpbm', 'bw'):
            tv = [x[k] for x in tm if x.get(k) is not None]
            lv = [x[k] for x in lm if x.get(k) is not None]
            ta = _tr_round(k, sum(tv) / len(tv)) if tv else 0
            la = _tr_round(k, sum(lv) / len(lv)) if lv else 0
            md[k] = [la, ta, _tr_chg(la, ta)]
        rows.append([ath['name'], ath['initials'], ath['group'], lm_jh, tm_jh, jh_chg, lm_rsi, tm_rsi, rsi_chg, md])
    
    return rows


# ─── Generate _OS Array (Offseason Tracking) ────────────────────────────────

def gen_OS(athletes_data):
    """_OS: [name, initials, group, sessions, jhFirst, jhLast, jhChange%, rsiFirst, rsiLast, rsiChange%, ppFirst, ppLast, ppChange%, brkFirst, brkLast, brkChange%]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        
        first = s[-1]
        last = s[0]
        
        def chg(old, new):
            if old and new and old != 0:
                return round((new - old) / abs(old) * 100, 1)
            return 0
        
        jf = r1u(first['jh']) if first['jh'] else 0
        jl = r1u(last['jh']) if last['jh'] else 0
        rf = round(first['rsi'], 2) if first['rsi'] else 0
        rl = round(last['rsi'], 2) if last['rsi'] else 0
        pf = round(first['pp'], 1) if first['pp'] else 0
        pl = round(last['pp'], 1) if last['pp'] else 0
        bf = first['brk'] or 0
        bl = last['brk'] or 0
        
        rows.append([
            ath['name'], ath['initials'], ath['group'], len(s),
            jf, jl, chg(jf, jl), rf, rl, chg(rf, rl),
            pf, pl, chg(pf, pl), bf, bl, chg(bf, bl),
            _tr_dict(first, last, ('ci100', 'pkw', 'pkwbm', 'cmpbm', 'bw')),
        ])
    
    return rows


# ─── Generate _ASY Array ────────────────────────────────────────────────────

def gen_ASY(athletes_data):
    """_ASY: [name, conImpulse%, conSide, eccBraking%, eccSide, concPeakForce%, cpfSide, domSide, lImpulse, rImpulse, histSigned[]]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        latest = s[0]
        
        con_a = latest.get('con_asym') or 0
        con_d = latest.get('con_dom') or "="
        ecc_a = latest.get('ecc_asym') or 0
        ecc_d = latest.get('ecc_dom') or "="
        cpf_a = latest.get('cpf_asym') or 0
        cpf_d = latest.get('cpf_dom') or "="
        
        # Dominant side = whichever appears most, and "=" when nothing does.
        # The tie branch is not cosmetic: max(set(sides), key=sides.count)
        # iterates a SET, and Python randomizes string hashing per process, so
        # a tie resolved to a different letter on every regeneration. Christian
        # Peralta (=, R, L) flipped between =/L/R across runs of identical data
        # (2026-08-10). A split verdict is also not dominance on the merits.
        sides = [con_d, ecc_d, cpf_d]
        counts = {s: sides.count(s) for s in sides}
        top = max(counts.values())
        winners = [s for s in ("L", "R", "=") if counts.get(s) == top]
        dom = winners[0] if len(winners) == 1 else "="
        
        # L/R concentric impulse values
        con_l = latest.get('con_l') or 0
        con_r = latest.get('con_r') or 0
        
        # History of signed asymmetry (positive = R dominant)
        hist_signed = []
        for sess in s[:HISTORY_LEN]:
            ca = sess.get('con_asym')
            cd = sess.get('con_dom')
            if ca is not None and cd is not None:
                val = ca if cd == "R" else -ca
                hist_signed.append(round(val, 1))
        hist_signed.reverse()  # oldest to newest
        
        rows.append([ath['name'], con_a, con_d, ecc_a, ecc_d, cpf_a, cpf_d, dom, con_l, con_r, hist_signed])
    
    return rows


# ─── Generate _BW Array ─────────────────────────────────────────────────────

def gen_BW(athletes_data):
    """_BW: [name, history[], current, change, dates[]]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        # Get BW from all sessions with BW data
        bw_sessions = [(sess['date_str'], sess['bw']) for sess in reversed(s) if sess['bw'] is not None]
        if not bw_sessions:
            continue
        
        dates = [b[0] for b in bw_sessions]
        history = [round(b[1], 1) for b in bw_sessions]
        current = history[-1] if history else 0
        first = history[0] if history else 0
        change = round(current - first, 1) if first else 0
        
        rows.append([ath['name'], history, current, change, dates])
    
    return rows


# ─── Generate _SD Array (Session Dates) ─────────────────────────────────────

def gen_SD(athletes_data):
    """_SD: [name, dates[]]  (dates as MM/DD/YYYY strings, oldest to newest)"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        dates = [sess['date_str'] for sess in reversed(s)]
        rows.append([ath['name'], dates])
    return rows


# ─── Generate _N (Group Norms) ───────────────────────────────────────────────

def gen_N(athletes_data):
    """Group norms: percentiles for each metric per group."""
    groups = defaultdict(lambda: {'jh': [], 'rsi': [], 'pp': [], 'brk': [],
                                  'bw': [], 'pkw': [], 'pkwbm': [], 'cmpbm': [], 'ci100': []})
    counts = defaultdict(int)  # athletes contributing per group (for the relaxed gate)

    for ath in athletes_data:
        s = ath['sessions']
        g = ath['group']
        min_sess = NORM_RELAXED_MIN_SESSIONS if g in NORM_RELAXED_GROUPS else MIN_SESSIONS
        if len(s) < min_sess:
            continue
        latest = s[0]
        if latest['date'] < ACTIVE_CUTOFF:
            continue

        # Female athletes feed the 'fem' norms IN ADDITION to their school
        # group's — dual membership, so "vs Female Athletes" comparisons work.
        # A relaxed athlete (pro/ml under MIN_SESSIONS) feeds ONLY its own group,
        # never 'all'/'fem' — so existing "vs All Athletes" percentiles are
        # byte-for-byte unchanged.
        if len(s) >= MIN_SESSIONS:
            targets = ['all', g] + (['fem'] if is_female(ath['name']) and g != 'fem' else [])
        else:
            targets = [g]
        for t in targets:
            counts[t] += 1
        for m in ('jh', 'rsi', 'pp', 'brk', 'bw', 'pkw', 'pkwbm', 'cmpbm', 'ci100'):
            if latest[m]:
                for t in targets:
                    groups[t][m].append(latest[m])

    def pctiles(vals):
        if len(vals) < 3:
            return {"p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0}
        vals.sort()
        n = len(vals)
        def p(k):
            idx = k / 100 * (n - 1)
            lo = int(idx)
            hi = min(lo + 1, n - 1)
            frac = idx - lo
            return round(vals[lo] + frac * (vals[hi] - vals[lo]), 2)
        return {"p10": p(10), "p25": p(25), "p50": p(50), "p75": p(75), "p90": p(90)}
    
    norms = {}
    metric_map = {'jh': 'cmjHeight', 'rsi': 'rsiMod', 'pp': 'conImpulse', 'brk': 'eccBrakingRFD',
                  # Physicality radar (2026-07-23). Percentile of bodyweight is the LSU
                  # chart's own convention (mass = physicality axis, not shown for fem).
                  'bw': 'bodyweight', 'pkw': 'peakPower', 'pkwbm': 'peakPowerBM',
                  'cmpbm': 'conMeanPowerBM', 'ci100': 'conImpulse100'}
    for g, data in groups.items():
        # Relaxed groups (pro/ml) must have >=3 contributing athletes AND >=3
        # samples per metric, or the percentile is degenerate and the UI would
        # show a broken "vs Pro" button. Non-relaxed groups keep prior behavior.
        # Relaxed gate checks only the original four metrics — the physicality
        # additions may be thin on older tests and must not knock out a group.
        if g in NORM_RELAXED_GROUPS and (counts[g] < NORM_RELAXED_MIN_ATHLETES
                or any(len(data[mk]) < 3 for mk in ('jh', 'rsi', 'pp', 'brk'))):
            continue
        norms[g] = {nk: pctiles(data[mk]) for mk, nk in metric_map.items()}

    return norms


# ─── Generate _PR Array (Personal Records) ──────────────────────────────────

def gen_PR(athletes_data):
    """_PR: [name, initials, group, date, [[metric, prev, curr, change%], ...]]
    PRs = new all-time bests set in the most recent session."""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        
        latest = s[0]
        prev_sessions = s[1:]
        
        prs = []
        # PR-able metrics = the profile page's physicality set (braking removed
        # from the portal UI 2026-07-23/24; bodyweight deliberately not a "PR").
        metric_keys = [('jh', 'JH'), ('rsi', 'RSI'), ('pp', 'CI'),
                       ('ci100', 'CI100'), ('pkw', 'PKW'), ('pkwbm', 'PKWBM'), ('cmpbm', 'CMPBM')]
        
        for mk, label in metric_keys:
            curr_val = latest.get(mk)
            if curr_val is None:
                continue
            prev_best = max([x[mk] for x in prev_sessions if x.get(mk) is not None], default=None)
            if prev_best is not None and curr_val > prev_best:
                chg = round((curr_val - prev_best) / abs(prev_best) * 100, 1) if prev_best else 0
                prs.append([label, round(prev_best, 2), round(curr_val, 2), chg])
        
        if prs:
            rows.append([ath['name'], ath['initials'], ath['group'], latest['date_str'], prs])
    
    return rows


# ─── Generate Hop Test Arrays ────────────────────────────────────────────────

def gen_HA(hop_athletes_data):
    """_HA: [name, initials, group, bw, testCount, latestDate,
            rsi, ct, ft, pfbm, rsiHist, ctHist,
            bestRSI, bestCT, bestFT, bestPFBM, ftHist]"""
    rows = []
    for ath in hop_athletes_data:
        s = ath['sessions']
        latest = s[0]

        bw_v = _latest_valid(s, 'bw')      # fall back past a nulled scale misread
        bw = round(bw_v, 1) if bw_v else 0
        test_count = len(s)
        latest_date = latest['date_str']
        rsi = round(latest['rsi'], 2) if latest['rsi'] else 0
        ct = round(latest['ct'], 1) if latest['ct'] else 0
        ft = round(latest['ft'], 1) if latest['ft'] else 0
        pfbm_v = _latest_valid(s, 'pfbm')  # derived from bw; nulled alongside a bad bw
        pfbm = round(pfbm_v, 2) if pfbm_v else 0

        # Last HISTORY_LEN sessions, oldest to newest
        hist = s[:HISTORY_LEN]
        hist.reverse()
        rsi_hist = [round(h['rsi'], 2) for h in hist if h['rsi'] is not None]
        ct_hist = [round(h['ct'], 1) for h in hist if h['ct'] is not None]
        ft_hist = [round(h['ft'], 1) for h in hist if h['ft'] is not None]
        rsi_hist_d = [h['date_str'] for h in hist if h['rsi'] is not None]
        ct_hist_d = [h['date_str'] for h in hist if h['ct'] is not None]
        ft_hist_d = [h['date_str'] for h in hist if h['ft'] is not None]

        all_rsi = [h['rsi'] for h in s if h['rsi'] is not None]
        all_ct = [h['ct'] for h in s if h['ct'] is not None]
        all_ft = [h['ft'] for h in s if h['ft'] is not None]
        all_pfbm = [h['pfbm'] for h in s if h['pfbm'] is not None]

        best_rsi = round(max(all_rsi), 2) if all_rsi else 0
        best_ct = round(min(all_ct), 1) if all_ct else 0  # CT: lower is better
        best_ft = round(max(all_ft), 1) if all_ft else 0
        best_pfbm = round(max(all_pfbm), 2) if all_pfbm else 0

        rows.append([
            ath['name'], ath['initials'], ath['group'], bw, test_count, latest_date,
            rsi, ct, ft, pfbm, rsi_hist, ct_hist,
            best_rsi, best_ct, best_ft, best_pfbm, ft_hist,
            rsi_hist_d, ct_hist_d, ft_hist_d,
        ])
    return rows


def gen_HPB(hop_athletes_data):
    """_HPB: per athlete, [allRSI, allCT, allFT, allPFBM,
                           tmRSI, tmCT, tmFT, tmPFBM,
                           lmRSI, lmCT, lmFT, lmPFBM,
                           twRSI, twCT, twFT, twPFBM]"""
    now = datetime.now()
    this_month_start = now.replace(day=1)
    last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
    last_month_end = this_month_start - timedelta(days=1)
    this_week_start = now - timedelta(days=7)

    def best_in_range(sessions, start_dt=None, end_dt=None):
        filtered = sessions
        if start_dt:
            filtered = [x for x in filtered if x['date'] >= start_dt]
        if end_dt:
            filtered = [x for x in filtered if x['date'] <= end_dt]
        if not filtered:
            return [None, None, None, None]
        rsi_vals = [x['rsi'] for x in filtered if x['rsi'] is not None]
        ct_vals = [x['ct'] for x in filtered if x['ct'] is not None]
        ft_vals = [x['ft'] for x in filtered if x['ft'] is not None]
        pfbm_vals = [x['pfbm'] for x in filtered if x['pfbm'] is not None]
        return [
            round(max(rsi_vals), 2) if rsi_vals else None,
            round(min(ct_vals), 1) if ct_vals else None,  # CT: lower is better
            round(max(ft_vals), 1) if ft_vals else None,
            round(max(pfbm_vals), 2) if pfbm_vals else None,
        ]

    rows = []
    for ath in hop_athletes_data:
        s = ath['sessions']
        rows.append(
            best_in_range(s) +
            best_in_range(s, this_month_start) +
            best_in_range(s, last_month_start, last_month_end) +
            best_in_range(s, this_week_start)
        )
    return rows


def gen_HT(hop_athletes_data):
    """_HT: [name, group, sessions, rsi_first, rsi_last, rsi_change,
            ct_first, ct_last, ct_change, ft_first, ft_last, ft_change]"""
    rows = []
    for ath in hop_athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        first = s[-1]
        last = s[0]

        def change_pct(old, new):
            if old and new and old != 0:
                return round((new - old) / abs(old) * 100, 1)
            return 0

        rsi_f = round(first['rsi'], 2) if first['rsi'] else 0
        rsi_l = round(last['rsi'], 2) if last['rsi'] else 0
        ct_f = round(first['ct'], 1) if first['ct'] else 0
        ct_l = round(last['ct'], 1) if last['ct'] else 0
        ft_f = round(first['ft'], 1) if first['ft'] else 0
        ft_l = round(last['ft'], 1) if last['ft'] else 0

        rows.append([
            ath['name'], ath['group'], len(s),
            rsi_f, rsi_l, change_pct(rsi_f, rsi_l),
            ct_f, ct_l, change_pct(ct_f, ct_l),
            ft_f, ft_l, change_pct(ft_f, ft_l),
        ])
    return rows


def gen_HN(hop_athletes_data):
    """Hop group norms: percentiles for each metric per group."""
    groups = defaultdict(lambda: {'rsi': [], 'ct': [], 'ft': [], 'pfbm': []})
    counts = defaultdict(int)

    for ath in hop_athletes_data:
        s = ath['sessions']
        g = ath['group']
        min_sess = NORM_RELAXED_MIN_SESSIONS if g in NORM_RELAXED_GROUPS else MIN_SESSIONS
        if len(s) < min_sess:
            continue
        latest = s[0]
        if latest['date'] < ACTIVE_CUTOFF:
            continue
        # Dual membership: female athletes also feed the 'fem' hop norms.
        # Relaxed athletes (pro/ml under MIN_SESSIONS) feed only their own group.
        if len(s) >= MIN_SESSIONS:
            targets = ['all', g] + (['fem'] if is_female(ath['name']) and g != 'fem' else [])
        else:
            targets = [g]
        for t in targets:
            counts[t] += 1
        for m in ('rsi', 'ct', 'ft', 'pfbm'):
            v = latest.get(m)
            if v:
                for t in targets:
                    groups[t][m].append(v)

    def pctiles(vals):
        if len(vals) < 3:
            return {"p10": 0, "p25": 0, "p50": 0, "p75": 0, "p90": 0}
        vals.sort()
        n = len(vals)
        def p(k):
            idx = k / 100 * (n - 1)
            lo = int(idx)
            hi = min(lo + 1, n - 1)
            frac = idx - lo
            return round(vals[lo] + frac * (vals[hi] - vals[lo]), 2)
        return {"p10": p(10), "p25": p(25), "p50": p(50), "p75": p(75), "p90": p(90)}

    norms = {}
    metric_map = {'rsi': 'rsi', 'ct': 'ct', 'ft': 'ft', 'pfbm': 'pfbm'}
    for g, data in groups.items():
        if g in NORM_RELAXED_GROUPS and (counts[g] < NORM_RELAXED_MIN_ATHLETES
                or any(len(data[mk]) < 3 for mk in metric_map)):
            continue
        norms[g] = {nk: pctiles(data[mk]) for mk, nk in metric_map.items()}
    return norms


def gen_HD(hop_athletes_data):
    """_HD: [name, dates[]]  (oldest to newest)"""
    rows = []
    for ath in hop_athletes_data:
        s = ath['sessions']
        dates = [sess['date_str'] for sess in reversed(s)]
        rows.append([ath['name'], dates])
    return rows


# ─── Velo (Trackman) generator ───────────────────────────────────────────────

def _velo_initials(name):
    """First initial + first letter of last name. Hyphenated last names stay
    intact (Laya-Vetell → 'L', Corso-Winks → 'C')."""
    parts = name.split()
    if not parts:
        return name[:2].upper()
    first = parts[0][0].upper()
    last = parts[-1][0].upper() if len(parts) > 1 else (parts[0][1:2].upper() or first)
    return first + last


def _velo_extract_groups_from_jsx(jsx_text):
    """Pull name → group from the existing _A/_HA/_VELO arrays.

    _A/_HA win because they are rebuilt from VALD every run, so a group change
    Frank makes in the Hub (e.g. the 2026-08-04 rising-class update) reaches the
    velo cards too. _VELO is the last resort: it carries bullpen-only pitchers
    who have no plate row, and it must NOT outrank fresh VALD data — when it did,
    the HS default a bullpen-first athlete got on day one went permanently
    sticky. Deliberate deviations belong in GROUP_OVERRIDES, which beats all of
    these."""
    import re
    out = {}
    for var, idx in (("_A", 2), ("_HA", 2), ("_VELO", 2)):
        m = re.search(rf"const {var}\s*=\s*(\[[\s\S]*?\]);", jsx_text)
        if not m:
            continue
        try:
            rows = json.loads(m.group(1))
        except Exception:
            continue
        for row in rows:
            if isinstance(row, list) and len(row) > idx and isinstance(row[0], str):
                # Don't overwrite — first source wins (so VALD-fresh _A trumps _VELO)
                if row[0] not in out:
                    out[row[0]] = row[idx]
    return out


def _format_us_date(iso_date):
    """YYYY-MM-DD → M/D/YYYY (matching existing _VELO format)."""
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d")
        return f"{d.month}/{d.day}/{d.year}"
    except Exception:
        return iso_date


def gen_VELO(trackman_data, group_map, exclusions):
    """_VELO row schema (16 columns):
        [name, initials, group, sessions,
         peakEver, avgPeak, avgAvg,
         latestPeak, latestAvg, latestDate,
         peakHistory, avgHistory, datesHistory, sessionTypeHistory, notesHistory,
         trend]

    Filters:
      - Manual session-date exclusions are dropped entirely (not even displayed).
      - Submax (Low Effort / Rehab) and Trackman-issue-flagged sessions are
        excluded from `peakEver` / `avgPeak` / `avgAvg` / `trend` math but still
        appear in the history sparklines so coaches see the full record.
    """
    if not trackman_data:
        return []

    rows = []
    for name, ath in (trackman_data.get("athletes") or {}).items():
        sessions = ath.get("sessions") or []
        if not sessions or is_excluded(name):
            continue

        # Drop manually-excluded sessions
        excl_dates = set(exclusions.get(name, []))
        if excl_dates:
            sessions = [s for s in sessions if s.get("date") not in excl_dates]
        if not sessions:
            continue

        # JSON has sessions newest→oldest. We need oldest→newest for history.
        sessions_chrono = list(reversed(sessions))

        # 6-week active cutoff — drop pitchers who haven't thrown recently, matching
        # the CMJ/hop ACTIVE_CUTOFF behavior. Based on the most recent session of any
        # type, so a recent low-effort / rehab throw still counts as active.
        try:
            if datetime.strptime(sessions_chrono[-1].get("date", ""), "%Y-%m-%d") < ACTIVE_CUTOFF:
                continue
        except (ValueError, TypeError):
            pass

        # Eligible = not submax, not flagged. Used for best/avg/trend math.
        # PROVISIONAL sessions (auto-filled from bullpen-report PDFs while the
        # master sheet catches up) count toward PEAK velo and history, but are
        # excluded from average/trend math until the coach's official row
        # confirms the session type.
        eligible = [
            s for s in sessions_chrono
            if not s.get("isSubmax") and not s.get("isFlagged")
        ]
        confirmed = [s for s in eligible if not s.get("provisional")]
        if not eligible:
            continue  # athlete has no max-effort data — skip from leaderboard

        # Latest = most recent session (any type) per existing UX
        latest = sessions_chrono[-1]
        latest_peak = latest.get("peakVelo")
        latest_avg = latest.get("avgVelo") if latest.get("avgVelo") is not None else 0
        latest_date = _format_us_date(latest.get("date", ""))

        # History: last N sessions chronologically
        history = sessions_chrono[-VELO_HISTORY_LEN:]
        peak_hist = [s.get("peakVelo") for s in history]
        avg_hist = [
            s.get("avgVelo") if s.get("avgVelo") is not None else s.get("peakVelo")
            for s in history
        ]
        date_hist = [_format_us_date(s.get("date", "")) for s in history]
        type_hist = [s.get("sessionType", "") for s in history]
        notes_hist = [s.get("notes", "") for s in history]

        # Peak from ALL eligible (incl. provisional); averages from confirmed only
        eligible_peaks = [s["peakVelo"] for s in eligible if s.get("peakVelo") is not None]
        peak_ever = round(max(eligible_peaks), 1)
        avg_pool = confirmed if confirmed else eligible
        pool_peaks = [s["peakVelo"] for s in avg_pool if s.get("peakVelo") is not None]
        pool_avgs  = [s["avgVelo"]  for s in avg_pool if s.get("avgVelo")  is not None]
        avg_peak  = round(sum(pool_peaks) / len(pool_peaks), 1) if pool_peaks else 0
        avg_avg   = round(sum(pool_avgs) / len(pool_avgs), 1) if pool_avgs else 0

        # Trend = build-up indicator over CONFIRMED sessions only.
        tpool = confirmed if len(confirmed) >= 2 else eligible
        if len(tpool) >= 5:
            recent = tpool[-4:]
            prior = tpool[:-4]
            trend = round(
                sum(s["peakVelo"] for s in recent) / 4
                - sum(s["peakVelo"] for s in prior) / len(prior),
                1,
            )
        elif len(tpool) >= 2:
            trend = round(tpool[-1]["peakVelo"] - tpool[0]["peakVelo"], 1)
        else:
            trend = 0.0

        # Manual GROUP_OVERRIDES win (consistent with CMJ/hop get_group); then the
        # name's existing classification from the jsx arrays; else default to HS.
        group = GROUP_OVERRIDES.get(name) or group_map.get(name, "hs")
        initials = _velo_initials(name)
        sessions_count = len(sessions)  # total displayed sessions (post-exclusion)

        rows.append([
            name, initials, group, sessions_count,
            peak_ever, avg_peak, avg_avg,
            latest_peak, latest_avg, latest_date,
            peak_hist, avg_hist, date_hist, type_hist, notes_hist,
            trend,
        ])

    rows.sort(key=lambda r: r[0])  # alphabetical by name
    return rows


# ─── Generate All ────────────────────────────────────────────────────────────

print("Generating portal data arrays...", flush=True)

_A = gen_A(athletes_data)
_PB = gen_PB(athletes_data)
_T = gen_T(athletes_data)
_WM = gen_WM(athletes_data)
_MH = gen_MH(athletes_data)
_OS = gen_OS(athletes_data)
_ASY = gen_ASY(athletes_data)
_BW = gen_BW(athletes_data)
_SD = gen_SD(athletes_data)
_N = gen_N(athletes_data)


# ─── Physicality radar (LSU-style percentile chart, 2026-07-23) ──────────────
# Per-athlete LATEST + FIRST-session values for the 8 radar metrics, in the
# order the App's PHY_METRICS expects:
#   bw, jh, conImpulse('pp'), conImpulse100, peakPower, peakPowerBM, conMeanPowerBM, rsi
# The dashed radar overlay = the athlete's first tested value per metric (same
# first-vs-latest framing as PR Progress).
def gen_PHY(athletes_data):
    PHY_KEYS = ('bw', 'jh', 'pp', 'ci100', 'pkw', 'pkwbm', 'cmpbm', 'rsi')
    def rnd(k, v):
        if v is None:
            return None
        if k == 'jh':
            return r1u(v)
        if k == 'rsi':
            return round(v, 2)
        if k == 'pkw':
            return round(v)
        return round(v, 1)
    def first_valid(sessions, key):
        for h in reversed(sessions):   # sessions are newest→oldest
            if h.get(key) is not None:
                return h[key]
        return None
    # Sparkline histories for the profile metric cards: last HISTORY_LEN
    # sessions (oldest→newest), nulls dropped with dates kept aligned per
    # metric — same pattern as _A's jh/rsi histories.
    HIST_KEYS = ('pp', 'ci100', 'pkw', 'pkwbm', 'cmpbm')
    out = []
    for ath in athletes_data:
        s = ath['sessions']
        latest = [rnd(k, _latest_valid(s, k)) for k in PHY_KEYS]
        first = [rnd(k, first_valid(s, k)) for k in PHY_KEYS]
        if all(v is None for v in latest):
            continue
        recent = s[:HISTORY_LEN][::-1]   # oldest→newest window
        hist = {}
        for k in HIST_KEYS:
            vals = [rnd(k, h[k]) for h in recent if h.get(k) is not None]
            dts = [h['date_str'] for h in recent if h.get(k) is not None]
            hist[k] = [vals, dts]
        best = {}
        for k in ('ci100', 'pkw', 'pkwbm', 'cmpbm'):
            allv = [h[k] for h in s if h.get(k) is not None]
            best[k] = rnd(k, max(allv)) if allv else None
        out.append([ath['name'], latest, first, len(s), hist, best])
    return out
_PHY = gen_PHY(athletes_data)
_PR = gen_PR(athletes_data)

# Hop test arrays
_HA = gen_HA(hop_athletes_data)
_HPB = gen_HPB(hop_athletes_data)
_HT = gen_HT(hop_athletes_data)
_HN = gen_HN(hop_athletes_data)
_HD = gen_HD(hop_athletes_data)

FB_FAMILY = ("Fastball", "Sinker", "Cutter")  # fastball family — all count toward peak FB velo
def _merge_bullpen_velo(trackman_data, reports_path="trackman_reports.json"):
    """Derive velo sessions (peak + average fastball) straight from the bullpen
    reports, so velo stays current from the TrackMan data alone — no master-sheet
    dependency — and so bullpen-only pitchers (no coach velo rows yet) still get a
    card. For an (athlete, date) already present the master sheet wins; bullpen-only
    dates are added and bullpen-only athletes are created. Fastball = the session's
    Fastball type, else Sinker; peak = its max velo, avg = its average velo. Bullpen
    session type is always "Pitching practice" (TrackMan has no effort label), so
    these count as max-effort toward BOTH peak and average — exclude a specific
    session via VELO_MANUAL_EXCLUSIONS or a master-sheet row if it wasn't."""
    if trackman_data is None:
        trackman_data = {"athletes": {}}
    if not os.path.exists(reports_path):
        return trackman_data
    try:
        rep = json.load(open(reports_path))
    except Exception:
        return trackman_data
    aths = trackman_data.setdefault("athletes", {})
    added = 0
    for name, r in (rep.get("athletes") or {}).items():
        ath = aths.setdefault(name, {"sessions": []})
        have = {s["date"] for s in ath["sessions"]}
        # An athlete can log TWO report sessions on one date (Brendan Ott threw
        # two live-AB innings on 2026-08-14, exported as separate PDFs). The velo
        # card carries one session per date, so same-date reports are POOLED
        # here before the skip check: peak = max across them (Ott's day peak
        # 83.8 was in inning 2 and would otherwise be silently dropped), avg =
        # pitch-count-weighted across each report's primary true fastball.
        by_date = {}
        for s in r.get("sessions", []):
            by_date.setdefault(s["date"], []).append(s)
        for date, day in by_date.items():
            if date in have:
                continue
            # Peak FB velo = the hardest pitch in the FASTBALL FAMILY (4-seam,
            # sinker, cutter) — e.g. Cade popped a 95 sinker above his 94 four-seam.
            peaks, avg_num, avg_den = [], 0.0, 0
            for s in day:
                types = s.get("types", [])
                fam = [t for t in types if t.get("name") in FB_FAMILY]
                peaks += [t.get("veloMax") for t in fam if t.get("veloMax")]
                # Average FB velo = the primary TRUE fastball (four-seam, else
                # sinker), NOT the most-thrown family member. A cutter counts for
                # peak but is a distinct, slower pitch that must not stand in for
                # average fastball velo (Jaylen Cruz threw more cutters than
                # four-seams, so his avg read his 79.6 cutter instead of his 85.3
                # fastball). Cutter drives avg only if it's the session's only
                # fastball-family pitch.
                true_fb = [t for t in fam if t.get("name") in ("Fastball", "Sinker")]
                if true_fb or fam:
                    avg_src = max(true_fb or fam, key=lambda t: t.get("count") or 0)
                    if avg_src.get("veloAvg"):
                        n_ = avg_src.get("count") or 1
                        avg_num += avg_src["veloAvg"] * n_
                        avg_den += n_
            if not peaks:
                continue  # no fastball-family pitch this date — no FB velo to record
            peak = max(peaks)
            avg = (avg_num / avg_den) if avg_den else None
            label = VELO_BULLPEN_LABELS.get((name, date), "Bullpen")
            ath["sessions"].append({
                "date": date,
                "peakVelo": round(peak, 1),
                "avgVelo": round(avg, 1) if avg else None,
                "sessionType": label,
                "notes": "From TrackMan bullpen",
                "isFlagged": False,
                "isSubmax": label in VELO_SUBMAX_TYPES,
            })
            added += 1
        ath["sessions"].sort(key=lambda x: x["date"], reverse=True)
    if added:
        print(f"  Velo: +{added} session(s) derived from TrackMan bullpens", flush=True)
    return trackman_data

# Velo (Trackman) array — pulls existing pitcher classifications from _VELO/_A/_HA in the
# current App.jsx so groups don't reset on every sync.
trackman = _merge_bullpen_velo(trackman)
_velo_groups = _velo_extract_groups_from_jsx(jsx)
_VELO = gen_VELO(trackman, _velo_groups, VELO_MANUAL_EXCLUSIONS)


# ─── TrackMan session reports (Bullpen Breakdown) ────────────────────────────
# trackman_reports.json is produced by trackman_reports_sync.py from the
# per-session PDF exports. Keyed by athlete name; rendered on the velo profile.
TRACKMAN_REPORTS_JSON = "trackman_reports.json"

# Manual coach notes for bullpen-report sessions, keyed by (athlete, ISO date).
# Shown on the session header in the Bullpen Breakdown and the report card.
TMR_SESSION_NOTES = {
    ("Nikhil Parikh", "2026-07-10"): "Low intensity",
}

def _month_abbr(iso):
    d = datetime.strptime(iso, "%Y-%m-%d")
    months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
              "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    return d, months[d.month - 1]

def gen_TMR(velo_rows):
    """_TMR: {name: [session, ...]} newest-first. Per session:
    {d: chip label, df: full date, st: session type, tot: pitch count,
     types: [[name, count, veloAvg, veloMax, ivb, hb, spin, ext, relH, relSide, eff, mvN]],
     dots:  [[typeIdx, ivb, hb, relH, relSide]]}   (typeIdx → types index)

    Movement (ivb/hb) is computed from the MEASURED per-pitch data, not from
    TrackMan's summary row: the mobile unit often fails to track movement on
    breaking pitches, and the summary averages demonstrably contradict the
    report's own per-pitch rows there (e.g. LoBello 7/6 "curveball avg IVB
    +9.2" whose two measured pitches average −2). mvN = movement-tracked pitch
    count; averages show when ≥2 pitches tracked (or the type fully tracked),
    else null → the UI renders "–" and draws no average dot."""
    if not os.path.exists(TRACKMAN_REPORTS_JSON):
        return {}
    with open(TRACKMAN_REPORTS_JSON) as f:
        rep = json.load(f)
    velo_names = {r[0] for r in velo_rows}
    out = {}
    for name, ath in (rep.get("athletes") or {}).items():
        if is_excluded(name):
            continue
        if name not in velo_names:
            print(f"  NOTE: trackman reports for '{name}' but no active velo "
                  f"card — breakdown won't show until they're active", flush=True)
        sess_out = []
        for s in ath.get("sessions", []):
            d, mon = _month_abbr(s["date"])
            tnames = [t["name"] for t in s["types"]]
            types_arr = []
            for t in s["types"]:
                measured = [p for p in s["pitches"]
                            if p.get("type") == t["name"]
                            and p.get("ivb") is not None and p.get("hb") is not None]
                mv_n = len(measured)
                if mv_n >= 2 or (mv_n >= 1 and mv_n == t["count"]):
                    ivb_v = round(sum(p["ivb"] for p in measured) / mv_n, 1)
                    hb_v = round(sum(p["hb"] for p in measured) / mv_n, 1)
                else:
                    ivb_v = hb_v = None
                types_arr.append([t["name"], t["count"], t["veloAvg"], t["veloMax"],
                                  ivb_v, hb_v,
                                  round(t["spinAvg"]) if t["spinAvg"] is not None else None,
                                  t["ext"], t["relH"], t["relSide"], t["effAvg"], mv_n])
            dots = [[tnames.index(p["type"]) if p.get("type") in tnames else -1,
                     p["ivb"], p["hb"], p["relH"], p["relSide"]]
                    for p in s["pitches"]]
            entry = {"d": f"{mon} {d.day}", "df": f"{mon} {d.day}, {d.year}",
                     "st": VELO_BULLPEN_LABELS.get((name, s["date"]), s["sessionType"]),
                     "tot": s["total"],
                     "types": types_arr, "dots": dots}
            note = TMR_SESSION_NOTES.get((name, s["date"]))
            if note:
                entry["note"] = note
            sess_out.append(entry)
        if sess_out:
            out[name] = sess_out
    return out

_TMR = gen_TMR(_VELO)

# ─── DynaMo (VALD shoulder-strength) — staff-only page ───────────────────────
DYNAMO_JSON = "dynamo_portal.json"
DYNAMO_MEAS_JSON = "dynamo_measurements.json"
DYNAMO_TORQUE_MOVES = {"External Rotation", "Internal Rotation"}  # rotational only
def _load_dynamo_meas():
    if not os.path.exists(DYNAMO_MEAS_JSON):
        return {}
    try:
        return (json.load(open(DYNAMO_MEAS_JSON)) or {}).get("athletes", {})
    except Exception:
        return {}
def _merge_bilateral_dynamo(movements):
    """VALD sometimes records one athlete's two arms as SEPARATE single-side
    tests (e.g. ER-left and ER-right land as two entries, each with one side
    null). Combine same (movement, position) entries whose non-null sides are
    disjoint into one bilateral row so reports show L/R together and the ER:IR
    ratio can be computed on both sides. Genuine repeats — the same side
    appearing twice — are a real double-effort and left untouched."""
    from collections import OrderedDict
    FIELDS = ("peakN", "peakLbs", "rfd", "ttp", "torqueNm")
    groups = OrderedDict()
    for mv in movements:
        groups.setdefault((mv.get("name"), mv.get("position")), []).append(mv)
    out = []
    for grp in groups.values():
        if len(grp) == 1:
            out.append(grp[0]); continue
        base = {k: [None, None] for k in FIELDS}
        conflict = False
        for mv in grp:
            for k in FIELDS:
                arr = mv.get(k) or [None, None]
                for i in (0, 1):
                    v = arr[i] if i < len(arr) else None
                    if v is None:
                        continue
                    if base[k][i] is not None:
                        conflict = True  # same side twice → genuine repeat
                    else:
                        base[k][i] = v
        if conflict:
            out.extend(grp); continue
        m = dict(grp[0])
        for k in FIELDS:
            if any(v is not None for v in base[k]):
                m[k] = base[k]
            else:
                m.pop(k, None)
        m["discomfort"] = any(mv.get("discomfort") for mv in grp)
        pkL, pkR = base["peakN"]
        if pkL is not None and pkR is not None and max(pkL, pkR) > 0:
            asym = round(abs(pkR - pkL) / max(pkL, pkR) * 100, 1)
            m["asymPct"] = asym
            m["asymNote"] = ("Symmetric" if asym < 10 else
                             ("right side stronger" if pkR >= pkL else "left side stronger"))
        out.append(m)
    return out

def _fill_erir(test):
    """After the bilateral merge, fill any missing ER:IR side from the merged
    ER/IR peaks. VALD's own stored ratios stay authoritative (never overwritten)."""
    movements = test.get("movements", [])
    er = next((m for m in movements if m.get("name") == "External Rotation"), None)
    ir = next((m for m in movements if m.get("name") == "Internal Rotation"), None)
    if not (er and ir):
        return
    ratio = test.get("erIr") or {"left": None, "right": None}
    for side, i in (("left", 0), ("right", 1)):
        if ratio.get(side) is None:
            e = (er.get("peakN") or [None, None])[i]
            n = (ir.get("peakN") or [None, None])[i]
            if e and n:
                ratio[side] = round(e / n, 2)
    test["erIr"] = ratio

# Bad DynaMo tests confirmed by Frank — dropped at build time so the fix
# survives every re-sync. Key: (athlete, date, movement, position); position
# None = any. Applied before bilateral merge so the paired good test survives.
DYNAMO_MOVEMENT_EXCLUSIONS = [
    # 547.4 N shoulder IR vs his real 197.7 six days earlier — device misread
    # (Frank, 2026-08-05).
    ("Emrie McLaughlin", "2026-08-04", "Internal Rotation", None),
    # Hip IR recorded under the shoulder IR movement (prone position, 358.6 N —
    # double any true shoulder IR in the building). The same-day Supine test is
    # the real shoulder IR and stays (Frank, 2026-08-05).
    ("Tom Hackimer", "2026-07-24", "Internal Rotation", "Prone"),
]

def _dyn_excluded(name, date, mv):
    for xn, xd, xm, xp in DYNAMO_MOVEMENT_EXCLUSIONS:
        if name == xn and date == xd and mv.get("name") == xm and (xp is None or mv.get("position") == xp):
            return True
    return False


def gen_DYNAMO():
    """_DYNAMO: [{name, group, dob, tests:[...]}] for the password-gated DynaMo
    page. Joins raw force (dynamo_portal.json, from the VALD DynaMo API) with the
    manual forearm lever arms (dynamo_measurements.json) to add per-side torque
    (N·m = peak force N × lever arm m) on ER/IR movements. Computed here so it
    refreshes on every portal build as new measurements are added — the DynaMo
    sync itself early-exits when there are no new tests."""
    if not os.path.exists(DYNAMO_JSON):
        return []
    try:
        data = json.load(open(DYNAMO_JSON))
    except Exception:
        return []
    meas = _load_dynamo_meas()
    out = []
    for name, a in (data.get("athletes") or {}).items():
        am = meas.get(a.get("name", name)) or {}
        arm = am.get("forearmMeters")
        throw_arm = am.get("throwingArm")  # "L"/"R" — clinically relevant side for the ER:IR board
        tests = a.get("tests", [])
        for t in tests:
            t["movements"] = [m for m in t.get("movements", []) if not _dyn_excluded(a.get("name", name), t.get("date"), m)]
            t["movements"] = _merge_bilateral_dynamo(t["movements"])
            for mv in t["movements"]:
                pk = mv.get("peakN")
                if arm and mv.get("name") in DYNAMO_TORQUE_MOVES and pk:
                    mv["torqueNm"] = [round(v * arm, 1) if v is not None else None for v in pk]
                else:
                    mv.pop("torqueNm", None)  # stale/ineligible → drop
            _fill_erir(t)
        out.append({
            "name": a.get("name", name),
            "group": a.get("group", "hs"),
            "dob": a.get("dob"),
            "arm": throw_arm,
            "tests": tests,
        })
    out.sort(key=lambda x: x["name"].split()[-1] if x["name"] else "")
    return out
_DYNAMO = gen_DYNAMO()


# ─── Velo Model (2026-07-27 refit) ───────────────────────────────────────────
# Cross-sectional model of peak fastball velocity from CMJ (+ optional DynaMo
# ER RFD). Coefficients come from the 2026-07-27 refit in ~/Desktop/Pitch Model
# (fit_model.py, n=81 / n=26, leave-one-out validated). The residual is the
# product: actual minus predicted, read against the ±RMSE noise floor.
# All aggregation rules mirror SKILL.md; do not change without re-validating
# against athlete_table_<date>.csv.
VM_A = (49.7784, 0.099611, 9.433266)              # velo = a0 + a1*CI + a2*RSI
VM_B = (41.8141, 0.068449, 11.978324, 3.185650)   # ... + b3*ln(ER_RFD lbs/s)
VM_RMSE = 4.4
VM_R2 = 0.56
# A + grip (Frank adopted DISPLAY-BESIDE-A, 2026-08-19: "merit enough to show
# guys"). Fit frozen from that day's grip-covered subset (n=67, LOO ±4.43);
# grip = best-side max peakN across every DynaMo Grip Squeeze. Shown as a
# second read on the athlete card only — Model A stays the headline, flags,
# and boards. The CI coefficient is much smaller than A's because grip
# absorbs part of the size axis; do not compare coefficients across models.
# Provisional pending the pre-registered refresh-battery verdict.
VM_G = (49.23519, 0.026726, 11.027560, 0.034926)  # velo = g0 + g1*CI + g2*RSI + g3*gripN
VM_G_BAND = 4.4
# Velo target: max Peak FB across sessions. The top-3-median target ("t3")
# validated slightly better in the refit; flip only with coach sign-off.
VM_TARGET = "max"
# Names spelled differently across ForceDecks / Dynamo / Trackman (SKILL.md).
VM_ALIASES = {
    "Patrick Rodriguez": "Pat Rodriguez",
    "Robert Romero": "Rob Romero",
    "Zach Uysal": "Zachary Uysal",
    "Bob Billiams": "Rob Williams",
    "GLV": "Gavin Laya-Vetell",
    "IRP": "Isaiah Rubin-Patel",
    "Isaac Santana": "Issac Santana",
    "Zachary Weinschel": "Zach Weinschel",
    "George Cancel": "George Cancel Jr",
}

def _vm_norm(s):
    import unicodedata
    s = unicodedata.normalize("NFKC", str(s or "")).replace("\u2019", "'").strip()
    s = " ".join(s.split())
    return VM_ALIASES.get(s, s)


def gen_VM(fd_data, trackman_data, dynamo_list):
    """_VM: model constants + per-athlete rows
    [name, group, ci, rsi, erRfd|null, velo, sessions, lastVelo, predA, residA,
     predB|null, residB|null, thin, bwLbs|null,
     velo6w|null, sess6w, ci6w|null, rsi6w|null, pred6w|null, resid6w|null,
     status, lastCmj|null, bestCiDate|null, bestRsiDate|null,
     gripN|null, predG|null, residG|null]
    Indices 24-26 (2026-08-19): DynaMo grip peak (best-side max, N) and the
    frozen A+grip prediction/residual (VM_G, display-beside-A only).
    Indices 22-23 are the session dates the LIFETIME-BEST ci and rsi were set
    (stale-engine badge, 2026-08-02: an all-time prediction leaning on an old
    best can flag an athlete who has since declined; Cellilli and Persichilli's
    under-flags were traced to >180d-old bests. UI computes the age).
    Indices 14-21 are CURRENT FORM: the same coefficients scored on inputs from
    the last 42 days only (Frank, 2026-07-28: a February peak must not drive a
    July flag). status "current" needs 3+ window sessions and a window CMJ;
    everything else is "stale" and the UI shows dates instead of a residual.
    ci = best-rep measured concentric impulse (trials[].metrics.concentricImpulse,
    net N.s, matches the fit table exactly); athletes with no measured value fall
    back to the physics estimate bw_kg*sqrt(2gh)*1.006, same as fit_model.py
    ("prefer measured CI; fall back to the validated physics estimate", r=0.992+
    vs measured). rsi = best rep.
    erRfd = per-test max populated side, mean across tests, N/s -> lbs/s.
    bwLbs = current bodyweight for the what-if card's projector slider: mean of
    the last 5 CMJ test weights (the test's weight field is kg, x LB_PER_KG).
    Excludes Staff and EXCLUDE_ATHLETES. Rankings use residA only; residB is
    card detail (never mix A and B residuals in one list)."""
    import math
    from datetime import timedelta

    # Current-form window: scoring inputs from the last 6 weeks only. Slides
    # automatically with every sync run. Coefficients stay fitted on all
    # history (n=81); refitting on the window alone was tested and is worse.
    VM_WINDOW_DAYS = 42
    cutoff = (datetime.now() - timedelta(days=VM_WINDOW_DAYS)).strftime("%Y-%m-%d")

    def _target(peaks):
        if VM_TARGET == "max":
            return peaks[0]
        top3 = sorted(peaks[:3])  # "t3": median of the top-3 session peaks
        return top3[len(top3) // 2]

    velo = {}
    for nm, a in ((trackman_data or {}).get("athletes") or {}).items():
        k = _vm_norm(nm)
        sess = [x for x in a.get("sessions", []) if x.get("peakVelo") is not None]
        if not sess:
            continue
        elig = [x for x in sess if not x.get("isSubmax") and not x.get("isFlagged")] or sess
        peaks = sorted((x["peakVelo"] for x in elig), reverse=True)
        recent = [x for x in elig if (x.get("date") or "")[:10] >= cutoff]
        peaks6 = sorted((x["peakVelo"] for x in recent), reverse=True)
        velo[k] = {"v": _target(peaks), "n": len(sess), "last": max(x["date"] for x in sess),
                   "v6": _target(peaks6) if peaks6 else None, "n6": len(recent)}

    er = {}
    gripN = {}
    for a in dynamo_list:
        k = _vm_norm(a.get("name"))
        vals = [v for t in a.get("tests", []) for m in t.get("movements", [])
                if m.get("name") == "Grip Squeeze"
                for v in (m.get("peakN") or []) if v is not None]
        if vals:
            gripN[k] = max(vals)
    for a in dynamo_list:
        k = _vm_norm(a.get("name"))
        per_test = []
        for t in a.get("tests", []):
            sides = [v for m in t.get("movements", []) if m.get("name") == "External Rotation"
                     for v in (m.get("rfd") or []) if v is not None]
            if sides:
                per_test.append(max(sides))
        if per_test:
            er[k] = (sum(per_test) / len(per_test)) / 4.448  # N/s -> lbs/s

    rows = []
    for pid, ath in fd_data["athletes"].items():
        name = ath.get("name")
        if not name or is_excluded(name):
            continue
        grp = get_group(name, ath.get("groups"))
        if grp == "stf":
            continue
        k = _vm_norm(name)
        tv = velo.get(k)
        if not tv:
            continue
        ci_meas = ci_est = rsi = 0.0
        ci6_meas = ci6_est = rsi6 = 0.0
        ci_meas_d = ci_est_d = rsi_d = None  # session date of each lifetime best
        last_cmj = None
        cmj_weights = []  # (date, kg) per CMJ test, for current bodyweight
        for t in ath.get("tests", []):
            if t.get("testType") != "CMJ":
                continue
            t_date = (t.get("date") or "")[:10]
            in_window = t_date >= cutoff
            if t_date:
                last_cmj = max(last_cmj, t_date) if last_cmj else t_date
            if t.get("weight"):
                cmj_weights.append((t.get("date") or "", t["weight"]))
            for tr in t.get("trials", []):
                m = tr.get("metrics", {})
                if m.get("concentricImpulse"):
                    if m["concentricImpulse"] > ci_meas:
                        ci_meas, ci_meas_d = m["concentricImpulse"], t_date or None
                    if in_window:
                        ci6_meas = max(ci6_meas, m["concentricImpulse"])
                jh, bw = m.get("jumpHeight"), m.get("bodyweightLbs")
                if jh and bw:
                    est = (bw * 0.45359237) * math.sqrt(2 * 9.81 * jh * 0.0254) * 1.006
                    if est > ci_est:
                        ci_est, ci_est_d = est, t_date or None
                    if in_window:
                        ci6_est = max(ci6_est, est)
                r = m.get("rsiModified")
                if r:
                    if r > rsi:
                        rsi, rsi_d = r, t_date or None
                    if in_window:
                        rsi6 = max(rsi6, r)
        ci = ci_meas or ci_est  # per-athlete fallback, mirroring fit_model.py
        ci_date = ci_meas_d if ci_meas else ci_est_d  # date follows the source used
        ci6 = ci6_meas or ci6_est
        if not ci or not rsi:
            continue
        # Current bodyweight (lbs) = mean of the last 5 CMJ test weights (kg).
        last5 = [w for _, w in sorted(cmj_weights)[-5:]]
        bw_lbs = round(sum(last5) / len(last5) * LB_PER_KG, 1) if last5 else None
        pred_a = VM_A[0] + VM_A[1] * ci + VM_A[2] * rsi
        resid_a = tv["v"] - pred_a
        e = er.get(k)
        pred_b = resid_b = None
        if e and e > 0:
            pred_b = VM_B[0] + VM_B[1] * ci + VM_B[2] * rsi + VM_B[3] * math.log(e)
            resid_b = round(tv["v"] - pred_b, 1)
        try:
            days = (datetime.now() - datetime.strptime(tv["last"][:10], "%Y-%m-%d")).days
        except Exception:
            days = 9999
        thin = 1 if (tv["n"] < 5 or days > 90) else 0
        # Current form: the last 6 weeks scored with the all-time coefficients.
        v6, n6 = tv.get("v6"), tv.get("n6", 0)
        pred6 = resid6 = None
        if v6 is not None and ci6 and rsi6:
            pred6 = VM_A[0] + VM_A[1] * ci6 + VM_A[2] * rsi6
            resid6 = round(v6 - pred6, 1)
        status = "current" if (n6 >= 3 and resid6 is not None) else "stale"
        g = gripN.get(k)
        pred_g = resid_g = None
        if g:
            pred_g = round(VM_G[0] + VM_G[1] * ci + VM_G[2] * rsi + VM_G[3] * g, 1)
            # residual from the ROUNDED pair so the card's arithmetic closes
            # (2026-08-10 precision lesson: coaches subtract what they see).
            resid_g = round(round(tv["v"], 1) - pred_g, 1)
        rows.append([
            _vm_norm(name), grp, round(ci, 1), round(rsi, 2),
            round(e, 1) if e else None, round(tv["v"], 1), tv["n"], tv["last"][:10],
            round(pred_a, 1), round(resid_a, 1),
            round(pred_b, 1) if pred_b is not None else None, resid_b, thin, bw_lbs,
            round(v6, 1) if v6 is not None else None, n6,
            round(ci6, 1) if ci6 else None, round(rsi6, 2) if rsi6 else None,
            round(pred6, 1) if pred6 is not None else None, resid6,
            status, last_cmj, ci_date, rsi_d,
            round(g, 1) if g else None, pred_g, resid_g,
        ])
    rows.sort(key=lambda r: -r[9])
    return {"a": list(VM_A), "b": list(VM_B), "g": list(VM_G), "gband": VM_G_BAND,
            "rmse": VM_RMSE, "r2": VM_R2, "target": VM_TARGET, "rows": rows}


def gen_QUAD(fd_data):
    """_QUAD: CMJ force/elasticity quadrant payload for the coach portal.
    rows = [name, group, ci, rsi, sus, lastCmj, bwLbs|null, fem]
    fem=1 marks a Female Athletes group member (they can resolve into hs/col
    via GROUP_PRIORITY, so the group code alone cannot identify them); the
    UI suppresses the velo-model engine projection for fem=1 - the model was
    fit on male pitchers and has no validity claim for female athletes.
    ci / rsi = the BEST session value inside a 42-day window, i.e. the best he
    has shown recently, not his career peak (Frank, 2026-08-12). sus=1 marks a
    thin window (< 3 sessions) -- shown in the tooltip/tap card only; dots render uniform (Frank, 2026-08-14).

    Why this changed. The plot used LIFETIME bests, so an athlete's two axes
    could come from different years. Miles Bohn plotted at a CI set the morning
    of 2026-08-11 against an RSI set in November 2025, nine months earlier; he
    trained elsewhere over the offseason and came back worse (0.46 median in
    2025 -> 0.34 now). Lifetime bests parked him in "Engine + spring" on the
    strength of a self that no longer exists, when current form is
    force-dominant - the quadrant that actually prescribes the reactive work he
    needs. Career peaks are the right axis for ranking potential and the wrong
    one for reading who is in front of you today.

    Why the BEST inside the window and not the median. The window, not the
    statistic, is what handles the detrained athlete: a kid we have not seen in
    six weeks does not get plotted at all, so nobody is labelled off stale work.
    Inside the window the best rep is the fairer read of what he can currently
    do - a median drags him down for bad reps, fatigue and off days that are not
    what you are trying to classify (Frank, 2026-08-12).

    Known cost, accepted deliberately. A max is still decided by one rep. Bohn's
    12 sessions in the window run 0.29-0.35 except a single 0.43 on 7/24, so he
    plots at 0.43 and stays in "Engine + spring" - the placement that started
    this whole thread. Under a median he lands force-dominant. Frank was shown
    both and chose the best-in-window; switch _qbest to statistics.median here to
    reverse it, and update the axis copy in src/App.jsx to match.

    This still retires the old round-4 display guard, which existed to stop a
    career-long max being defeated by one mis-segmented rep. A 42-day window
    bounds that exposure to weeks instead of years, and sus now marks the
    live fragility: fewer than 3 sessions. ADJUDICATED_RSI is no longer consulted
    here; it stays in this file because Pitch Model/build_cmj_quadrants.py still
    parses it."""
    _qbest = max
    rows = []
    for a in fd_data["athletes"].values():
        name = a.get("name")
        if not name or is_excluded(name):
            continue
        grp = get_group(name, a.get("groups"))
        ci_s, rsi_s = {}, {}
        wts = []
        last = ""
        for t in a.get("tests", []):
            if t.get("testType") != "CMJ":
                continue
            d = (t.get("date") or "")[:10]
            if d:
                last = max(last, d)
            if t.get("weight"):
                wts.append((t.get("date") or "", t["weight"]))
            for tr in t.get("trials", []):
                m = tr.get("metrics", {})
                v = m.get("concentricImpulse")
                jh, bw = m.get("jumpHeight"), m.get("bodyweightLbs")
                if not v and jh and bw:
                    v = (bw * 0.45359237) * (2 * 9.81 * jh * 0.0254) ** 0.5 * 1.006
                if v:
                    ci_s[d] = max(ci_s.get(d, 0), v)
                r = m.get("rsiModified")
                if r:
                    rsi_s[d] = max(rsi_s.get(d, 0), r)
        if not ci_s or not rsi_s or not last:
            continue
        # Current form: median of session bests inside the window. Must match
        # QUAD_WIN_DAYS in src/App.jsx, which also filters the plot by lastCmj.
        qcut = (datetime.now() - timedelta(days=QUAD_WIN_DAYS)).strftime("%Y-%m-%d")
        ci_w = [v for d, v in ci_s.items() if d >= qcut]
        rsi_w = [v for d, v in rsi_s.items() if d >= qcut]
        if not ci_w or not rsi_w:
            continue   # nothing inside the window; the UI would hide the dot anyway
        ci, rsi = _qbest(ci_w), _qbest(rsi_w)
        # Hollow now means THIN, not suspect: a median over one or two sessions
        # is the live fragility here, where a max over a long history was the
        # old one. 36 athletes sat below this bar the day it shipped.
        sus = 1 if min(len(ci_w), len(rsi_w)) < 3 else 0
        last5 = [w for _, w in sorted(wts)[-5:]]
        bw = round(sum(last5) / len(last5) * LB_PER_KG, 1) if last5 else None
        fem = 1 if "Female Athletes" in (a.get("groups") or []) else 0
        rows.append([name, grp, round(ci, 1), round(rsi, 2), sus, last, bw, fem])
    rows.sort(key=lambda r: r[0])
    return rows


_QUAD = gen_QUAD(fd)
_VM = gen_VM(fd, trackman, _DYNAMO)


# ─── CMJ strategy buckets — staff-only board (Phase 4a) ──────────────────────
# Source of truth: bucket_engine.py in ~/Desktop/Pitch Model/cmj_strategy, which
# emits cmj_buckets.json (schema rpm.cmj_strategy.buckets/v1). See
# ~/Desktop/Programs/RPM Docs/RPM_CMJ_STRATEGY_BLUEPRINT.md for the taxonomy.
#
# Unlike every other array here, the input JSON lives OUTSIDE this repo: buckets
# are re-cut by hand when athletes retest, not by the 6-hourly syncs. Two
# consequences, both deliberate:
#   1. Missing/unreadable file -> gen_STRAT returns [] and never raises. The
#      6-hourly cron must never die on a file that is not its business.
#   2. When the file is absent, _STRAT is left OUT of the splice below, so the
#      board already committed in src/App.jsx survives. The GitHub Action runs on
#      a checkout that has no ~/Desktop, so splicing an empty array there would
#      wipe the board every 6 hours. CI has no fresher strategy data to offer, so
#      it says nothing rather than something false.
# Override the path with RPM_CMJ_STRATEGY_JSON (used by tests and by anyone who
# keeps the Pitch Model tree somewhere else).
CMJ_STRATEGY_JSON = os.environ.get("RPM_CMJ_STRATEGY_JSON") or os.path.expanduser(
    "~/Desktop/Pitch Model/cmj_strategy/cmj_buckets.json")

# Column -> the words a coach uses. The engine's column names are metric keys;
# the board must never make Frank translate `ci100_share` in his head. Anything
# not listed falls back to a de-camelCased form, so a new engine indicator
# renders readably instead of breaking the board.
STRAT_COL_LABELS = {
    "contractionTime_med": "time to takeoff",
    "cmDepth_med": "countermovement depth",
    "eccPeakVelo_med": "dip speed",
    "eccDecelRfd_med": "braking rate",
    "brakingForceBW_med": "braking force per BW",
    "brakingPhaseDur_med": "braking phase length",
    "eccBrakingImpulse_med": "braking impulse",
    "forceAtZeroV_med": "force at the turn",
    "fzv_ratio": "force at the turn, share of peak",
    "ci100_share": "first 100 ms share of the push",
    "conImpulse100_med": "first 100 ms impulse",
    "concDuration_med": "push duration",
    "concPeakVelo_med": "peak push velocity",
    "concTimeToPF_med": "time to peak force",
    "concPeakForce_bw": "push force per BW",
    "concImpulse_perkg": "push impulse per kg",
    "relativePower_med": "power per kg",
    "rsiModified_med": "reactive strength (RSI-mod)",
    "cmjStiffness_med": "jump stiffness",
    "jumpHeight_best": "jump height",
    "landingRfd_med": "landing rate",
    "landingPeakForceBM_med": "landing peak force per kg",
    "landingStiffness_med": "landing stiffness",
    "concentricImpulseAsym_med": "push impulse asymmetry",
    "conImpulse100Asym_med": "first 100 ms impulse asymmetry",
    "eccBrakingImpulseAsym_med": "braking impulse asymmetry",
    "concPeakForceAsym_med": "peak push force asymmetry",
    "bw_delta_pct_6mo": "bodyweight change, 6 months",
}

# Training emphasis per bucket deliberately does NOT live here. That is taxonomy,
# it belongs to the blueprint and to Frank's prescription, and a copy pasted into
# the portal would drift the first time a bucket is retuned. The board shows the
# engine's evidence; the coach brings the plan.
#
# Blueprint rule: dates beat buckets once the data is old. LOW confidence or a
# test older than this many days and the row leads with the retest line.
STRAT_STALE_DAYS = 90


def _strat_label(col):
    """`ci100_share` -> "first 100 ms share of the push"; unknown columns
    de-camelCase to something readable rather than leaking a metric key."""
    if col in STRAT_COL_LABELS:
        return STRAT_COL_LABELS[col]
    s = re.sub(r"_(med|best|bw|perkg)$", "", str(col or ""))
    s = re.sub(r"(?<!^)(?=[A-Z])", " ", s).replace("_", " ")
    return s.lower().strip() or str(col or "")


def _strat_num(v):
    """One display form for values spanning 0.33 to 6146.8, so the board reads
    as one column of numbers instead of a float dump."""
    if v is None:
        return ""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    a = abs(f)
    if a >= 100:
        return f"{f:,.0f}"
    if a >= 10:
        return f"{f:.1f}"
    if a >= 1:
        return f"{f:.2f}"
    return f"{f:.3f}"


def _strat_pct(p):
    """Percentile chip text: 2.0 -> "p2", 9.5 -> "p9.5"."""
    if p is None:
        return ""
    f = float(p)
    return "p" + (f"{f:.0f}" if abs(f - round(f)) < 0.05 else f"{f:.1f}")


def _strat_date_label(iso):
    """2026-03-09 -> "Mar 9, 2026" — the portal's long-date form (_TMR "df")."""
    if not iso:
        return ""
    try:
        d = datetime.strptime(str(iso)[:10], "%Y-%m-%d")
    except ValueError:
        return str(iso)
    return f"{_month_abbr(str(iso)[:10])[1]} {d.day}, {d.year}"


def _strat_ind(i):
    """One indicator -> [label, value, percentile, depth+direction, required?].
    Rendered as-is; React does no arithmetic on strategy numbers."""
    depth = str(i.get("depth") or "")
    direction = str(i.get("direction") or "")
    return [
        _strat_label(i.get("col")),
        _strat_num(i.get("value")),
        _strat_pct(i.get("pct")),
        (depth + " " + direction).strip(),
        1 if i.get("role") == "required" else 0,
    ]


def _board_group_map(fd_data, velo_rows, athlete_rows):
    """Normalised name -> group code, for the staff boards whose rows come from
    outside the live arrays.

    The ForceDecks store is the BASE because a third of these boards' athletes
    last tested months ago and have already dropped out of _A/_VELO; without it
    they render with no group at all. The live rows then win on top.
    """
    group_map = {}
    for _pid, _a in (fd_data.get("athletes") or {}).items():
        _n = _a.get("name")
        if _n:
            group_map[_vm_norm(_n)] = get_group(_n, _a.get("groups"))
    for r in athlete_rows:
        group_map[_vm_norm(r[0])] = r[2]
    for r in velo_rows:
        group_map[_vm_norm(r[0])] = r[2]
    return group_map


def gen_STRAT(fd_data, velo_rows, athlete_rows):
    """_STRAT: one row per athlete carried by cmj_buckets.json, ready to render.
    [{name, group, bucket, label, secondary, secondaryLabel, conf, confBasis,
      score, pool, note, days, lastTest, stale, extended,
      ind: [[label, value, pct, depth, required]], ind2: [...],
      tags: [[tag, [[label, value, pct, depth], ...]]]}]

    Buckets are hypotheses about the most likely limiter, so nothing here is
    scored, ranked or colour-coded by severity — the board shows the evidence and
    lets the coach decide. Every displayed value is finished here: the React side
    groups the rows and prints them, and computes nothing.

    `days` is recomputed against today rather than trusting the file's anchor
    date, so the retest rule fires on the athlete's real test age.
    """
    if not os.path.exists(CMJ_STRATEGY_JSON):
        print(f"  _STRAT: no strategy file at {CMJ_STRATEGY_JSON} — skipping "
              f"(existing board in the JSX is left alone)", flush=True)
        return []
    try:
        with open(CMJ_STRATEGY_JSON) as f:
            data = json.load(f)
    except Exception as e:
        print(f"  WARNING: could not read {CMJ_STRATEGY_JSON} ({e}) — _STRAT "
              f"skipped, existing board left alone", flush=True)
        return []
    if not isinstance(data, dict) or not isinstance(data.get("athletes"), list):
        print(f"  WARNING: {CMJ_STRATEGY_JSON} is not a buckets file "
              f"(schema={data.get('schema') if isinstance(data, dict) else type(data).__name__}) "
              f"— _STRAT skipped", flush=True)
        return []

    names = data.get("bucket_names") or {}
    # Group chips resolve exactly like every other board's: the ForceDecks store
    # via get_group (which honours GROUP_OVERRIDES) as the base, then the live
    # _A/_VELO rows on top. The store is the base because a third of this file's
    # athletes last tested months ago and have already dropped out of the live
    # arrays — without it they would render with no group at all.
    group_map = _board_group_map(fd_data, velo_rows, athlete_rows)

    today = datetime.now().date()
    out = []
    for a in data["athletes"]:
        raw_name = a.get("athlete")
        if not raw_name or is_excluded(raw_name):
            continue
        name = _vm_norm(raw_name)
        cur = a.get("currency") or {}
        iso = cur.get("latest_test")
        days = cur.get("days")
        if iso:
            try:
                days = (today - datetime.strptime(str(iso)[:10], "%Y-%m-%d").date()).days
            except ValueError:
                pass
        conf = a.get("confidence")
        bucket = a.get("primary")
        row = {
            "name": name,
            "group": group_map.get(name, ""),
            "bucket": bucket,
            "label": names.get(bucket, "") if bucket else "",
            "secondary": a.get("secondary"),
            "secondaryLabel": names.get(a.get("secondary"), "") if a.get("secondary") else "",
            "conf": conf,
            "confBasis": a.get("confidence_basis") or "",
            "score": a.get("score"),
            "pool": bool(a.get("in_pool")),
            "note": a.get("note") or "",
            "days": days,
            "lastTest": _strat_date_label(iso),
            # Blueprint: LOW confidence or a stale test means dates lead and the
            # bucket steps back. Decided here so React never owns the threshold.
            "stale": bool(conf == "LOW" or (days is not None and days > STRAT_STALE_DAYS)),
            "extended": bool(cur.get("extended")),
            # Plateau overlay (Frank 2026-08-06): computed by bucket_engine
            # (state "down" when 90-day JH change <= -5%); carried verbatim.
            "plateau": (a.get("plateau") or {}).get("state") or "",
            "jhD90": (a.get("plateau") or {}).get("jh_d90_in"),
            "jhD90Pct": (a.get("plateau") or {}).get("jh_d90_pct"),
            # Per-KPI 90-day trends for the Plateau selector: {key: [d, pct,
            # worse_pct, state]} — worse_pct is direction-normalized upstream.
            "trends": {k: [v.get("d"), v.get("pct"), v.get("worse_pct"),
                           v.get("state") or ""]
                       for k, v in (a.get("trends") or {}).items()},
            "ind": [_strat_ind(i) for i in (a.get("indicators") or [])],
            "ind2": [_strat_ind(i) for i in (a.get("secondary_indicators") or [])],
            "tags": [[t.get("tag"),
                      [[_strat_label(e.get("col")), _strat_num(e.get("value")),
                        _strat_pct(e.get("pct")), str(e.get("depth") or "")]
                       for e in (t.get("evidence") or [])]]
                     for t in (a.get("tags") or [])],
        }
        out.append(row)
    out.sort(key=lambda x: (x["name"].split()[-1] if x["name"] else "", x["name"]))
    return out


_STRAT = gen_STRAT(fd, _VELO, _A)

# ─── CMJ Session Watch — staff-only drift + experiment monitor ───────────────
# Source of truth: session_watch.py in this repo, which emits watch.json
# (schema rpm.cmj.watch/v1) from forcedecks_portal.json + experiments.json +
# watch_state.json. Unlike _STRAT's buckets, watch.json IS a repo file and the
# 6-hourly Action regenerates it, so CI normally has fresh data here.
#
# The guard still matters, and it is sharper than _STRAT's. The watch step runs
# continue-on-error so a watch failure can never sink the sync, which means a
# run can reach this point with no watch.json at all. Those two cases must not
# look alike:
#   * file missing or unreadable  -> None -> _WATCH stays OUT of the splice, and
#     the panel already committed in src/App.jsx survives untouched.
#   * file present with zero rows -> {} with rows: [] -> spliced, because
#     "nothing is flagged today" is a real and useful thing to say, and the
#     anchor date behind it has probably moved.
# _STRAT cannot draw that line (it returns [] for both); this can, so it does.
WATCH_JSON = os.environ.get("RPM_WATCH_JSON") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "watch.json")


def gen_WATCH(fd_data, velo_rows, athlete_rows):
    """_WATCH: {meta, rows} exactly as session_watch.py computed them.

    Every number, label and unit is finished upstream: this applies
    EXCLUDE_ATHLETES, canonicalises names the way every other board does, and
    otherwise passes the rows straight through. React renders and computes
    nothing, which is the same contract _STRAT ships under.

    Returns None (not []) when there is no readable watch.json, so the caller
    can tell "no data" from "no flags".
    """
    if not os.path.exists(WATCH_JSON):
        print(f"  _WATCH: no watch file at {WATCH_JSON} — skipping "
              f"(existing panel in the JSX is left alone)", flush=True)
        return None
    try:
        with open(WATCH_JSON) as f:
            data = json.load(f)
    except Exception as e:
        print(f"  WARNING: could not read {WATCH_JSON} ({e}) — _WATCH skipped, "
              f"existing panel left alone", flush=True)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
        print(f"  WARNING: {WATCH_JSON} is not a watch file "
              f"(schema={data.get('schema') if isinstance(data, dict) else type(data).__name__}) "
              f"— _WATCH skipped", flush=True)
        return None

    group_map = _board_group_map(fd_data, velo_rows, athlete_rows)
    rows = []
    for r in data["rows"]:
        name = r.get("athlete")
        if not name or is_excluded(name):
            continue
        row = dict(r)
        row["athlete"] = _vm_norm(name)
        row["group"] = group_map.get(row["athlete"], "")
        # Dates become words here, in the portal's long-date form, for the same
        # reason the strategy board formats its own: React should never own a
        # date convention that two other surfaces already agreed on.
        sessions = row.get("sessions") or []
        row["sessionsDisp"] = ", ".join(_strat_date_label(d) for d in sessions)
        days = row.get("days_since")
        row["ageDisp"] = ("today" if days == 0
                          else f"{days} day{'' if days == 1 else 's'} ago"
                          if isinstance(days, int) else "")
        for m in row.get("metrics") or []:
            base = m.get("baseline_sessions") or []
            if len(base) == 2:
                m["baselineDisp"] = (f"{_strat_date_label(base[0])} to "
                                     f"{_strat_date_label(base[1])}")
        # The early tier renders as one compact line per athlete, so its worst
        # metric is named here rather than dug out of the metrics array in JSX.
        # `tier` itself is passed through untouched from session_watch.py.
        metrics = row.get("metrics") or []
        if metrics:
            row["worstLabel"] = metrics[0].get("label", "")
            row["worstSdDisp"] = metrics[0].get("sdDisp", "")
        rows.append(row)

    meta = dict(data.get("meta") or {})
    # Recount after exclusions so the header never claims more than it shows.
    _reg = [r for r in rows if r.get("type") == "REGRESSION"]
    meta["flagged_n"] = len(_reg)
    meta["strong_n"] = sum(1 for r in _reg if r.get("tier") == "strong")
    meta["early_n"] = sum(1 for r in _reg if r.get("tier") == "early")
    meta["rows_n"] = len(rows)
    meta["anchorDisp"] = _strat_date_label(meta.get("anchor"))
    return {"meta": meta, "rows": rows}


_WATCH = gen_WATCH(fd, _VELO, _A)

# Female-athlete name list for the UI (exact data-spelling strings, so
# FEM_SET.has(a.name) matches even quirks like "Francesca  Albergo").
_FEM = sorted({ath['name'] for ath in athletes_data if is_female(ath['name'])} |
              {ath['name'] for ath in hop_athletes_data if is_female(ath['name'])} |
              {r[0] for r in _VELO if is_female(r[0])})

# ─── Full metric histories: _FH (Trending "Date Range" section) ──────────────
# name -> { d: [YYMMDD...oldest-first], jh/rsi/pp/brk: [aligned values|null],
#           hd: [YYMMDD...], hrsi/hct/hft/hpf: [aligned values|null] }
# The 8-deep sparkline arrays in _A/_HA can't serve a custom date range, so the
# range view gets every session. Velo (_VELO) and DynaMo (_DYNAMO) already ship
# full history and need nothing here.
def _ymd(dt):
    return (dt.year % 100) * 10000 + dt.month * 100 + dt.day

_FH = {}
for _a in athletes_data:
    _ss = sorted(_a['sessions'], key=lambda s: s['date'])
    _e = _FH.setdefault(_a['name'], {})
    _e['d'] = [_ymd(s['date']) for s in _ss]
    for _k in ('jh', 'rsi', 'pp'):
        _e[_k] = [s.get(_k) for s in _ss]
for _a in hop_athletes_data:
    _ss = sorted(_a['sessions'], key=lambda s: s['date'])
    _e = _FH.setdefault(_a['name'], {})
    _e['hd'] = [_ymd(s['date']) for s in _ss]
    for _k, _sk in (('hrsi', 'rsi'), ('hct', 'ct'), ('hft', 'ft'), ('hpf', 'pfbm')):
        _e[_k] = [s.get(_sk) for s in _ss]
print(f"  _FH:  {len(_FH)} athletes with full histories "
      f"({sum(len(v.get('d', [])) + len(v.get('hd', [])) for v in _FH.values())} sessions, "
      f"~{len(json.dumps(_FH, separators=(',', ':'))) // 1024} KB)", flush=True)

# ─── Consistency calendar: _CONS ─────────────────────────────────────────────
# name -> [["YYYY-MM", packed], ...] newest month first. packed = concatenated
# "ddc" triplets: day-of-month (2 digits) + tests that day (1 digit, capped 9).
# ANY ForceDecks test OR DynaMo movement counts as a day in the building (some
# athletes come in and only do shoulder work). Window = trailing 13 calendar
# months; months inside an athlete's span with zero visits are kept (the gaps
# ARE the consistency story). Same-name duplicate profiles merge.
_cons_names = ({a['name'] for a in athletes_data} |
               {a['name'] for a in hop_athletes_data})
_now = datetime.now()
_wy, _wm = _now.year, _now.month
for _ in range(12):
    _wm -= 1
    if _wm == 0:
        _wy, _wm = _wy - 1, 12
_win_key = f"{_wy:04d}-{_wm:02d}"

_cons_days = {}   # name -> {"YYYY-MM-DD": test count}
for _pid, _ath in fd['athletes'].items():
    _nm = _ath.get('name')
    if _nm not in _cons_names:
        continue
    _acc = _cons_days.setdefault(_nm, {})
    for _t in _ath.get('tests', []):
        _ds = (_t.get('date') or '')[:10]
        if len(_ds) == 10 and _ds[:7] >= _win_key:
            _acc[_ds] = _acc.get(_ds, 0) + 1

# DynaMo days count too — some athletes come in and only do shoulder work.
# Each movement tested that day adds one "test" to the day's intensity.
if os.path.exists(DYNAMO_JSON):
    try:
        _dyn_ath = json.load(open(DYNAMO_JSON)).get('athletes') or {}
    except Exception:
        _dyn_ath = {}
    for _nm, _da in _dyn_ath.items():
        if _nm not in _cons_names:
            continue
        _acc = _cons_days.setdefault(_nm, {})
        for _t in _da.get('tests', []):
            _ds = (_t.get('date') or '')[:10]
            if len(_ds) == 10 and _ds[:7] >= _win_key:
                _acc[_ds] = _acc.get(_ds, 0) + max(1, len(_t.get('movements') or []))

# Manually-tracked attendance (attendance_manual.json, from attendance_import.py
# run against Frank's "RPM Baseball Attendance" workbook): covers days with no
# ForceDecks/DynaMo data at all. A checked-in day with no tests shows as the
# lightest shade (count 1); it never inflates days that already have tests.
ATTENDANCE_ALIASES = {
    "zachary uysal": "Zach Uysal",
    "collin leavy": "Colin Leavy",
    "joe frazzetta": "Joey Frazzetta",
    "joe muzio": "Joey Muzio",
}
if os.path.exists('attendance_manual.json'):
    try:
        _att = json.load(open('attendance_manual.json'))
    except Exception:
        _att = {}
    _cons_lookup = {" ".join(n.split()).lower(): n for n in _cons_names}
    _att_unmatched = set()
    _att_days_added = 0
    for _nm, _dates in _att.items():
        _norm = " ".join(_nm.split()).lower()
        # Alias first, but fall back to a direct match if the alias target has
        # gone stale (e.g. the store spelling gets fixed at the source later).
        _canon = ATTENDANCE_ALIASES.get(_norm)
        if _canon not in _cons_names:
            _canon = _cons_lookup.get(_norm)
        if not _canon:
            _att_unmatched.add(_nm)
            continue
        _acc = _cons_days.setdefault(_canon, {})
        for _ds in _dates:
            if len(_ds) == 10 and _ds[:7] >= _win_key:
                if _ds not in _acc:
                    _att_days_added += 1
                _acc[_ds] = max(_acc.get(_ds, 0), 1)
    print(f"  _CONS: manual attendance added {_att_days_added} test-free days "
          f"({len(_att_unmatched)} sheet names not in portal)", flush=True)

_CONS = {}
for _nm, _acc in _cons_days.items():
    if not _acc:
        continue
    _bym = {}
    for _ds, _c in _acc.items():
        _bym.setdefault(_ds[:7], []).append((int(_ds[8:10]), min(_c, 9)))
    _first = min(_bym)
    _out = []
    _y, _m = _now.year, _now.month
    while len(_out) < 13:
        _key = f"{_y:04d}-{_m:02d}"
        if _key < _first or _key < _win_key:
            break
        _days = sorted(_bym.get(_key, []))
        _out.append([_key, ''.join(f"{d:02d}{c}" for d, c in _days)])
        _m -= 1
        if _m == 0:
            _y, _m = _y - 1, 12
    _CONS[_nm] = _out

print(f"  _CONS: {len(_CONS)} athletes with attendance calendars "
      f"({sum(len(v) for v in _CONS.values())} month rows)", flush=True)

print(f"  _A:   {len(_A)} athletes", flush=True)
print(f"  _PB:  {len(_PB)} entries", flush=True)
print(f"  _T:   {len(_T)} trends", flush=True)
print(f"  _WM:  {len(_WM)} weekly movers", flush=True)
print(f"  _MH:  {len(_MH)} monthly highlights", flush=True)
print(f"  _OS:  {len(_OS)} offseason", flush=True)
print(f"  _ASY: {len(_ASY)} asymmetry", flush=True)
print(f"  _BW:  {len(_BW)} bodyweight", flush=True)
print(f"  _SD:  {len(_SD)} session dates", flush=True)
print(f"  _N:   {len(_N)} groups", flush=True)
print(f"  _PHY: {len(_PHY)} physicality rows", flush=True)
print(f"  _PR:  {len(_PR)} new PRs", flush=True)
print(f"  _HA:  {len(_HA)} hop athletes", flush=True)
print(f"  _HPB: {len(_HPB)} hop personal bests", flush=True)
print(f"  _VELO: {len(_VELO)} pitchers (trackman {'loaded' if trackman else 'MISSING — _VELO empty'})", flush=True)
print(f"  _TMR: {len(_TMR)} pitchers with bullpen reports "
      f"({sum(len(v) for v in _TMR.values())} sessions)", flush=True)
print(f"  _DYNAMO: {len(_DYNAMO)} athletes with DynaMo tests", flush=True)
print(f"  _VM:  {len(_VM['rows'])} velo-model rows", flush=True)
print(f"  _STRAT: {len(_STRAT)} CMJ-strategy rows "
      f"({sum(1 for r in _STRAT if r['bucket'] and r['bucket'] != 'S0')} flagged, "
      f"{sum(1 for r in _STRAT if r['stale'])} needing retest)", flush=True)
if _WATCH is None:
    print("  _WATCH: skipped (no watch.json this run)", flush=True)
else:
    _wc = Counter(r.get("type") for r in _WATCH["rows"])
    print(f"  _WATCH: {len(_WATCH['rows'])} watch rows "
          f"({_wc['REGRESSION']} regression, {_wc['FOLLOW-UP']} follow-up, "
          f"{_wc['CONFIRMED']} confirmed, {_wc['CLEARED']} cleared; "
          f"anchor {_WATCH['meta'].get('anchor')})", flush=True)
print(f"  _FEM: {len(_FEM)} female athletes labeled", flush=True)
print(f"  _HT:  {len(_HT)} hop trends", flush=True)
print(f"  _HN:  {len(_HN)} hop norms", flush=True)
print(f"  _HD:  {len(_HD)} hop session dates", flush=True)

# ─── Write JS Output ─────────────────────────────────────────────────────────

def js_val(v):
    if v is None:
        return 'null'
    return json.dumps(v)

output_lines = []
output_lines.append(f"const _A = {json.dumps(_A, separators=(',', ':'))};")
output_lines.append(f"const _T = {json.dumps(_T, separators=(',', ':'))};")
output_lines.append(f"const _PB = {json.dumps(_PB, separators=(',', ':'))};")
output_lines.append(f"const _WM = {json.dumps(_WM, separators=(',', ':'))};")
output_lines.append(f"const _MH = {json.dumps(_MH, separators=(',', ':'))};")
output_lines.append(f"const _OS = {json.dumps(_OS, separators=(',', ':'))};")
output_lines.append(f"const _ASY = {json.dumps(_ASY, separators=(',', ':'))};")
output_lines.append(f"const _BW = {json.dumps(_BW, separators=(',', ':'))};")
output_lines.append(f"const _SD = {json.dumps(_SD, separators=(',', ':'))};")
output_lines.append(f"const _N = {json.dumps(_N, separators=(',', ':'))};")
output_lines.append(f"const _PHY = {json.dumps(_PHY, separators=(',', ':'))};")
output_lines.append(f"const _PR = {json.dumps(_PR, separators=(',', ':'))};")
output_lines.append(f"const _HA = {json.dumps(_HA, separators=(',', ':'))};")
output_lines.append(f"const _HPB = {json.dumps(_HPB, separators=(',', ':'))};")
output_lines.append(f"const _HT = {json.dumps(_HT, separators=(',', ':'))};")
output_lines.append(f"const _HN = {json.dumps(_HN, separators=(',', ':'))};")
output_lines.append(f"const _HD = {json.dumps(_HD, separators=(',', ':'))};")
output_lines.append(f"const _VELO = {json.dumps(_VELO, separators=(',', ':'))};")
output_lines.append(f"const _TMR = {json.dumps(_TMR, separators=(',', ':'))};")
output_lines.append(f"const _DYNAMO = {json.dumps(_DYNAMO, separators=(',', ':'))};")
output_lines.append(f"const _VM = {json.dumps(_VM, separators=(',', ':'))};")
output_lines.append(f"const _QUAD = {json.dumps(_QUAD, separators=(',', ':'))};")
output_lines.append(f"const _FEM = {json.dumps(_FEM, separators=(',', ':'))};")
output_lines.append(f"const _CONS = {json.dumps(_CONS, separators=(',', ':'))};")
output_lines.append(f"const _FH = {json.dumps(_FH, separators=(',', ':'))};")
# Only when this run actually had strategy data: a printed `const _STRAT = [];`
# in the reference dump would read as "no buckets exist" on a machine that simply
# does not carry the Pitch Model tree.
if _STRAT:
    output_lines.append(f"const _STRAT = {json.dumps(_STRAT, separators=(',', ':'))};")
# Same rule for the Watch: printed only when this run actually read a watch file.
if _WATCH is not None:
    output_lines.append(f"const _WATCH = {json.dumps(_WATCH, separators=(',', ':'))};")

with open("portal_data_arrays.js", "w") as f:
    f.write("\n".join(output_lines))

print(f"\nWritten to portal_data_arrays.js ({os.path.getsize('portal_data_arrays.js') / 1024:.0f} KB)", flush=True)

# ─── Now splice into App.jsx ─────────────────────────────────────────────────

# Update LAST_UPDATED date
import re
# Eastern-stamped: the 6h bots run in UTC, so convert explicitly.
from zoneinfo import ZoneInfo
today_str = datetime.now(ZoneInfo('America/New_York')).strftime('%B %-d, %Y \u00b7 %-I:%M %p ET')
jsx = re.sub(r'const LAST_UPDATED = ".*?";', f'const LAST_UPDATED = "{today_str}";', jsx)

# Find where each const is defined and replace it
replacements = {
    '_A': _A, '_T': _T, '_PB': _PB, '_WM': _WM, '_MH': _MH,
    '_OS': _OS, '_ASY': _ASY, '_BW': _BW, '_SD': _SD, '_N': _N, '_PR': _PR, '_PHY': _PHY,
}
replacements.update({'_HA': _HA, '_HPB': _HPB, '_HT': _HT, '_HN': _HN, '_HD': _HD})
replacements.update({'_VELO': _VELO})
replacements.update({'_TMR': _TMR})
replacements.update({'_DYNAMO': _DYNAMO})
replacements.update({'_VM': _VM})
replacements.update({'_QUAD': _QUAD})
replacements.update({'_FEM': _FEM})
replacements.update({'_CONS': _CONS})
replacements.update({'_FH': _FH})
# _STRAT joins the splice ONLY when this run read a real buckets file. Its source
# lives outside the repo (see gen_STRAT), so the 6-hourly GitHub Action has no
# strategy data at all — splicing [] there would delete the committed board on
# every run. No data means no opinion, so the JSX keeps what it has.
if _STRAT:
    replacements.update({'_STRAT': _STRAT})
# _WATCH joins on the same terms. `is not None` rather than truthiness: an empty
# rows list means "watch ran, nothing flagged", which the panel should show.
if _WATCH is not None:
    replacements.update({'_WATCH': _WATCH})

new_jsx = jsx
for var_name, data in replacements.items():
    marker = f'const {var_name} = '
    start = new_jsx.find(marker)
    if start < 0:
        print(f"  WARNING: Could not find '{marker}' in App.jsx", flush=True)
        continue
    # Find the end of this statement (semicolon + newline)
    end = new_jsx.find(';\n', start)
    if end < 0:
        end = new_jsx.find(';', start)
    if end < 0:
        print(f"  WARNING: Could not find end of '{marker}'", flush=True)
        continue
    end += 1  # include the semicolon
    
    replacement = f'const {var_name} = {json.dumps(data, separators=(",", ":"))};'
    new_jsx = new_jsx[:start] + replacement + new_jsx[end:]
    print(f"  Replaced {var_name} ({end - start} → {len(replacement)} chars)", flush=True)

# Write updated App.jsx
with open("App_updated.jsx", "w") as f:
    f.write(new_jsx)

print(f"\nUpdated App.jsx written to App_updated.jsx ({os.path.getsize('App_updated.jsx') / 1024:.0f} KB)", flush=True)
print("Done!", flush=True)
