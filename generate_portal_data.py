#!/usr/bin/env python3
"""
Generate portal data arrays from forcedecks_portal.json
Outputs a JS snippet to paste into App.jsx, replacing the hardcoded arrays.
"""
import json, sys, os
from datetime import datetime, timedelta
from collections import defaultdict
import statistics

# ─── Config ──────────────────────────────────────────────────────────────────

PORTAL_JSON = sys.argv[1] if len(sys.argv) > 1 else "forcedecks_portal.json"
CURRENT_JSX = sys.argv[2] if len(sys.argv) > 2 else "App.jsx"
TRACKMAN_JSON = sys.argv[3] if len(sys.argv) > 3 else "trackman_portal.json"
ACTIVE_CUTOFF = datetime.now() - timedelta(days=42)
MIN_SESSIONS = 5
HISTORY_LEN = 8  # last 8 sessions for sparklines

# ─── Hop test metric keys ───────────────────────────────────────────────────
# vald_sync.py stores hop metrics under these keys (see PORTAL_METRICS in vald_sync).
# RSI displayed on the portal is VALD's "Mean RSI" (averaged across hops within a
# trial), to match VALD Hub's headline number. hopRsi (single-best-hop) is also
# captured but is no longer used as the displayed metric.
HOP_RSI_KEY        = "hopMeanRsi"       # Mean RSI (FT/CT averaged over hops) — ratio
HOP_CT_KEY         = "hopContactTime"   # Best Contact Time — milliseconds
HOP_FT_KEY         = "hopFlightTime"    # Best Flight Time — milliseconds
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

# ─── Velo (Trackman) config ──────────────────────────────────────────────────
VELO_HISTORY_LEN = 8                          # last N sessions in sparkline history
VELO_SUBMAX_TYPES = {"Low Effort", "Rehab"}   # excluded from "best ever" math
# Manual session exclusions for velo (mirror HOP_MANUAL_EXCLUSIONS pattern).
# Athletes -> list of session dates (YYYY-MM-DD) to skip entirely.
VELO_MANUAL_EXCLUSIONS = {}

# ─── Load Data ───────────────────────────────────────────────────────────────

with open(PORTAL_JSON) as f:
    fd = json.load(f)

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
EXCLUDE_ATHLETES = {"Liam Murphy"}

# Manual group overrides — these always win, even over VALD.
# Keep this for athletes whose VALD group is wrong or who aren't yet in VALD.
GROUP_OVERRIDES = {
    "Nick Padilla": "pro",
    "Matt Bowman": "pro",
    "Julian Minaya": "pro",
    "Mike Sirota": "pro",
    # College pitchers
    "Joe Hauser": "col",
    "Shea O'Sullivan": "col",
    "Addison Hinz-Camarano": "col",
    "Zach Weinschel": "col",
    "Darren Espinal": "col",
    # Middle school
    "Josh Miller": "ms",
    # Men's league
    "Carlos Solorzano": "ml",
}

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
    """Average of (Left + Right) braking RFD across all trials."""
    vals = []
    for tr in trials:
        m = tr['metrics']
        bl = m.get('brakingRFDLeft')
        br = m.get('brakingRFDRight')
        if bl is not None and br is not None:
            vals.append(abs(bl) + abs(br))
    return round(sum(vals) / len(vals)) if vals else None

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
    if not name:
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
        pp = compute_session_best(test['trials'], 'relativePower')
        brk = compute_session_brk_avg(test['trials'])
        bw = compute_session_avg(test['trials'], 'bodyweightLbs')
        
        # Asymmetry
        con_asym, con_dom, con_l, con_r = compute_session_asym(test['trials'], 'concentricImpulse')
        ecc_asym, ecc_dom, ecc_l, ecc_r = compute_session_asym(test['trials'], 'eccBrakingImpulse')
        cpf_asym, cpf_dom, cpf_l, cpf_r = compute_session_asym(test['trials'], 'concPeakForce')
        
        sessions.append({
            'date': dt,
            'date_str': dt.strftime('%m/%d/%Y'),
            'jh': jh, 'rsi': rsi, 'pp': pp, 'brk': brk, 'bw': bw,
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
    'pp':  0.40,          # relative peak power — fairly stable
    'rsi': 0.55,          # RSI-modified — a bit noisier
    'brk': 0.80,          # eccentric braking RFD — genuinely noisy, stay loose
    'bw':  0.25,          # bodyweight — very stable; a 25%+ single-session swing = scale misread
}
ABS_BOUNDS = {            # hard sanity bounds; outside = sensor error, always drop
    'jh':  (2.0, 50.0),   # inches
    'rsi': (0.0, 5.0),    # RSI-mod realistically maxes well under 5
    'pp':  (0.0, 120.0),  # W/kg
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
    if not name:
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
        # True PFBM = (PeakForceLeft + PeakForceRight) / (BW_kg × g), giving body-weight units.
        # NOTE: VALD's bare `hopPeakForce` field is L/R asymmetry %, not Newtons — don't use it.
        pfL = m.get('hopPeakForceLeft')
        pfR = m.get('hopPeakForceRight')
        if pfL is not None and pfR is not None and bw:
            bw_kg = bw / LB_PER_KG
            pfbm = round((pfL + pfR) / (bw_kg * G), 2)
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


def gen_A(athletes_data):
    """_A: [name, initials, group, bw, testCount, latestDate, jh, rsi, pp, brk, jhHist, rsiHist, bestJH, bestRSI, bestPP, bestBRK]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        latest = s[0]

        test_count = len(s)
        latest_date = latest['date_str']
        bw_v, jh_v, rsi_v, pp_v, brk_v = (_latest_valid(s, k) for k in ('bw', 'jh', 'rsi', 'pp', 'brk'))
        bw = round(bw_v, 1) if bw_v else 0
        jh = round(jh_v, 1) if jh_v else 0
        rsi = round(rsi_v, 2) if rsi_v else 0
        pp = round(pp_v, 1) if pp_v else 0
        brk = brk_v or 0
        
        # History (last 8 sessions, oldest to newest)
        hist = s[:HISTORY_LEN]
        hist.reverse()
        jh_hist = [round(h['jh'], 1) for h in hist if h['jh'] is not None]
        rsi_hist = [round(h['rsi'], 2) for h in hist if h['rsi'] is not None]
        
        # All-time bests
        all_jh = [h['jh'] for h in s if h['jh'] is not None]
        all_rsi = [h['rsi'] for h in s if h['rsi'] is not None]
        all_pp = [h['pp'] for h in s if h['pp'] is not None]
        all_brk = [h['brk'] for h in s if h['brk'] is not None]
        
        best_jh = round(max(all_jh), 1) if all_jh else 0
        best_rsi = round(max(all_rsi), 2) if all_rsi else 0
        best_pp = round(max(all_pp), 1) if all_pp else 0
        best_brk = max(all_brk) if all_brk else 0
        
        rows.append([
            ath['name'], ath['initials'], ath['group'], bw, test_count, latest_date,
            jh, rsi, pp, brk, jh_hist, rsi_hist,
            best_jh, best_rsi, best_pp, best_brk
        ])
    
    return rows


# ─── Generate _PB Array ─────────────────────────────────────────────────────

def gen_PB(athletes_data):
    """_PB: per athlete, [allJH, allRSI, allPP, allBRK, tmJH, tmRSI, tmPP, tmBRK, lmJH, lmRSI, lmPP, lmBRK, twJH, twRSI, twPP, twBRK]
    tm=this month, lm=last month, tw=this week"""
    now = datetime.now()
    this_month_start = now.replace(day=1)
    last_month_start = (this_month_start - timedelta(days=1)).replace(day=1)
    last_month_end = this_month_start - timedelta(days=1)
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
        
        jh_f = round(first['jh'], 1) if first['jh'] else 0
        jh_l = round(last['jh'], 1) if last['jh'] else 0
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

def gen_WM(athletes_data):
    """_WM: [name, initials, group, jhPrev, jhCurr, jhChange%, rsiPrev, rsiCurr, rsiChange%, prevDate, currDate]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < 2:
            continue
        
        curr = s[0]
        prev = s[1]
        
        jh_c = round(curr['jh'], 1) if curr['jh'] else 0
        jh_p = round(prev['jh'], 1) if prev['jh'] else 0
        rsi_c = round(curr['rsi'], 2) if curr['rsi'] else 0
        rsi_p = round(prev['rsi'], 2) if prev['rsi'] else 0
        
        jh_chg = round((jh_c - jh_p) / jh_p * 100, 1) if jh_p else 0
        rsi_chg = round((rsi_c - rsi_p) / rsi_p * 100, 1) if rsi_p else 0
        
        rows.append([
            ath['name'], ath['initials'], ath['group'],
            jh_p, jh_c, jh_chg, rsi_p, rsi_c, rsi_chg,
            prev['date_str'], curr['date_str'],
        ])
    
    return rows


# ─── Generate _MH Array (Monthly Highlights) ────────────────────────────────

def gen_MH(athletes_data):
    """_MH: [name, initials, group, jhPrev, jhCurr, jhChange%, rsiPrev, rsiCurr, rsiChange%]
    Compares this month avg vs last month avg."""
    now = datetime.now()
    tm_start = now.replace(day=1)
    lm_start = (tm_start - timedelta(days=1)).replace(day=1)
    lm_end = tm_start - timedelta(days=1)
    
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
        
        rows.append([ath['name'], ath['initials'], ath['group'], lm_jh, tm_jh, jh_chg, lm_rsi, tm_rsi, rsi_chg])
    
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
        
        jf = round(first['jh'], 1) if first['jh'] else 0
        jl = round(last['jh'], 1) if last['jh'] else 0
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
        
        # Dominant side = whichever appears most
        sides = [con_d, ecc_d, cpf_d]
        dom = max(set(sides), key=sides.count) if sides else "="
        
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
    groups = defaultdict(lambda: {'jh': [], 'rsi': [], 'pp': [], 'brk': []})
    
    for ath in athletes_data:
        s = ath['sessions']
        if len(s) < MIN_SESSIONS:
            continue
        latest = s[0]
        if latest['date'] < ACTIVE_CUTOFF:
            continue
        
        g = ath['group']
        if latest['jh']: 
            groups[g]['jh'].append(latest['jh'])
            groups['all']['jh'].append(latest['jh'])
        if latest['rsi']:
            groups[g]['rsi'].append(latest['rsi'])
            groups['all']['rsi'].append(latest['rsi'])
        if latest['pp']:
            groups[g]['pp'].append(latest['pp'])
            groups['all']['pp'].append(latest['pp'])
        if latest['brk']:
            groups[g]['brk'].append(latest['brk'])
            groups['all']['brk'].append(latest['brk'])
    
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
    metric_map = {'jh': 'cmjHeight', 'rsi': 'rsiMod', 'pp': 'peakPowerBM', 'brk': 'eccBrakingRFD'}
    for g, data in groups.items():
        norms[g] = {}
        for mk, nk in metric_map.items():
            norms[g][nk] = pctiles(data[mk])
    
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
        metric_keys = [('jh', 'JH'), ('rsi', 'RSI'), ('pp', 'PP'), ('brk', 'BRK')]
        
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

    for ath in hop_athletes_data:
        s = ath['sessions']
        if len(s) < MIN_SESSIONS:
            continue
        latest = s[0]
        if latest['date'] < ACTIVE_CUTOFF:
            continue
        g = ath['group']
        for m in ('rsi', 'ct', 'ft', 'pfbm'):
            v = latest.get(m)
            if v:
                groups[g][m].append(v)
                groups['all'][m].append(v)

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
        norms[g] = {}
        for mk, nk in metric_map.items():
            norms[g][nk] = pctiles(data[mk])
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
    """Pull name → group from existing _VELO and _A/_HA arrays.
    Existing _VELO classifications win — they reflect Frank's pitcher-aware bucketing."""
    import re
    out = {}
    for var, idx in (("_VELO", 2), ("_A", 2), ("_HA", 2)):
        m = re.search(rf"const {var}\s*=\s*(\[[\s\S]*?\]);", jsx_text)
        if not m:
            continue
        try:
            rows = json.loads(m.group(1))
        except Exception:
            continue
        for row in rows:
            if isinstance(row, list) and len(row) > idx and isinstance(row[0], str):
                # Don't overwrite — first source wins (so _VELO trumps later)
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
        if not sessions:
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
        eligible = [
            s for s in sessions_chrono
            if not s.get("isSubmax") and not s.get("isFlagged")
        ]
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

        # Best / aggregate stats from eligible-only
        eligible_peaks = [s["peakVelo"] for s in eligible if s.get("peakVelo") is not None]
        eligible_avgs  = [s["avgVelo"]  for s in eligible if s.get("avgVelo")  is not None]
        peak_ever = round(max(eligible_peaks), 1)
        avg_peak  = round(sum(eligible_peaks) / len(eligible_peaks), 1)
        avg_avg   = round(sum(eligible_avgs) / len(eligible_avgs), 1) if eligible_avgs else 0

        # Trend = build-up indicator: mean(last 4 eligible peaks) − mean(prior eligible peaks)
        # Positive = trending above career baseline; negative = trending below.
        if len(eligible) >= 5:
            recent = eligible[-4:]
            prior = eligible[:-4]
            trend = round(
                sum(s["peakVelo"] for s in recent) / 4
                - sum(s["peakVelo"] for s in prior) / len(prior),
                1,
            )
        elif len(eligible) >= 2:
            trend = round(eligible[-1]["peakVelo"] - eligible[0]["peakVelo"], 1)
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
_PR = gen_PR(athletes_data)

# Hop test arrays
_HA = gen_HA(hop_athletes_data)
_HPB = gen_HPB(hop_athletes_data)
_HT = gen_HT(hop_athletes_data)
_HN = gen_HN(hop_athletes_data)
_HD = gen_HD(hop_athletes_data)

# Velo (Trackman) array — pulls existing pitcher classifications from _VELO/_A/_HA in the
# current App.jsx so groups don't reset on every sync.
_velo_groups = _velo_extract_groups_from_jsx(jsx)
_VELO = gen_VELO(trackman, _velo_groups, VELO_MANUAL_EXCLUSIONS)


# ─── TrackMan session reports (Bullpen Breakdown) ────────────────────────────
# trackman_reports.json is produced by trackman_reports_sync.py from the
# per-session PDF exports. Keyed by athlete name; rendered on the velo profile.
TRACKMAN_REPORTS_JSON = "trackman_reports.json"

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
            sess_out.append({"d": f"{mon} {d.day}", "df": f"{mon} {d.day}, {d.year}",
                             "st": s["sessionType"], "tot": s["total"],
                             "types": types_arr, "dots": dots})
        if sess_out:
            out[name] = sess_out
    return out

_TMR = gen_TMR(_VELO)

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
print(f"  _PR:  {len(_PR)} new PRs", flush=True)
print(f"  _HA:  {len(_HA)} hop athletes", flush=True)
print(f"  _HPB: {len(_HPB)} hop personal bests", flush=True)
print(f"  _VELO: {len(_VELO)} pitchers (trackman {'loaded' if trackman else 'MISSING — _VELO empty'})", flush=True)
print(f"  _TMR: {len(_TMR)} pitchers with bullpen reports "
      f"({sum(len(v) for v in _TMR.values())} sessions)", flush=True)
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
output_lines.append(f"const _PR = {json.dumps(_PR, separators=(',', ':'))};")
output_lines.append(f"const _HA = {json.dumps(_HA, separators=(',', ':'))};")
output_lines.append(f"const _HPB = {json.dumps(_HPB, separators=(',', ':'))};")
output_lines.append(f"const _HT = {json.dumps(_HT, separators=(',', ':'))};")
output_lines.append(f"const _HN = {json.dumps(_HN, separators=(',', ':'))};")
output_lines.append(f"const _HD = {json.dumps(_HD, separators=(',', ':'))};")
output_lines.append(f"const _VELO = {json.dumps(_VELO, separators=(',', ':'))};")
output_lines.append(f"const _TMR = {json.dumps(_TMR, separators=(',', ':'))};")

with open("portal_data_arrays.js", "w") as f:
    f.write("\n".join(output_lines))

print(f"\nWritten to portal_data_arrays.js ({os.path.getsize('portal_data_arrays.js') / 1024:.0f} KB)", flush=True)

# ─── Now splice into App.jsx ─────────────────────────────────────────────────

# Update LAST_UPDATED date
import re
today_str = datetime.now().strftime('%B %-d, %Y')
jsx = re.sub(r'const LAST_UPDATED = ".*?";', f'const LAST_UPDATED = "{today_str}";', jsx)

# Find where each const is defined and replace it
replacements = {
    '_A': _A, '_T': _T, '_PB': _PB, '_WM': _WM, '_MH': _MH,
    '_OS': _OS, '_ASY': _ASY, '_BW': _BW, '_SD': _SD, '_N': _N, '_PR': _PR,
}
replacements.update({'_HA': _HA, '_HPB': _HPB, '_HT': _HT, '_HN': _HN, '_HD': _HD})
replacements.update({'_VELO': _VELO})
replacements.update({'_TMR': _TMR})

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
