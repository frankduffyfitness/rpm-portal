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
ACTIVE_CUTOFF = datetime.now() - timedelta(days=42)
MIN_SESSIONS = 5
HISTORY_LEN = 8  # last 8 sessions for sparklines

# ─── Load Data ───────────────────────────────────────────────────────────────

with open(PORTAL_JSON) as f:
    fd = json.load(f)

with open(CURRENT_JSX) as f:
    jsx = f.read()

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

def get_group(name):
    return GROUP_MAP.get(name, "hs")  # default to hs if unknown

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
        
        jh = compute_session_avg(test['trials'], 'jumpHeight')
        rsi = compute_session_avg(test['trials'], 'rsiModified')
        pp = compute_session_avg(test['trials'], 'relativePower')
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
        'group': get_group(name),
        'initials': get_initials(name),
        'sessions': sessions,
    })
# Filter out statistical outlier sessions (misreads)
# Override list: {athlete_name: [metrics to skip]}
OUTLIER_OVERRIDES = {
    "Rocco Rossi": ["rsi"],
}
for ath in athletes_data:
    skip = OUTLIER_OVERRIDES.get(ath['name'], [])
    for metric in ['jh', 'rsi', 'pp', 'brk']:
        if metric in skip:
            continue
        vals = [s[metric] for s in ath['sessions'] if s.get(metric) is not None]
        if len(vals) >= 5:
            mean = sum(vals) / len(vals)
            std = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
            if std > 0:
                for s in ath['sessions']:
                    if s.get(metric) is not None and abs(s[metric] - mean) > 3 * std:
                        s[metric] = None

# Filter out athletes with no test in the last 6 weeks
athletes_data = [a for a in athletes_data if a['sessions'][0]['date'] >= ACTIVE_CUTOFF]
# Sort athletes by name
athletes_data.sort(key=lambda a: a['name'])


# ─── Generate _A Array ───────────────────────────────────────────────────────

def gen_A(athletes_data):
    """_A: [name, initials, group, bw, testCount, latestDate, jh, rsi, pp, brk, jhHist, rsiHist, bestJH, bestRSI, bestPP, bestBRK]"""
    rows = []
    for ath in athletes_data:
        s = ath['sessions']
        latest = s[0]
        
        bw = round(latest['bw'], 1) if latest['bw'] else 0
        test_count = len(s)
        latest_date = latest['date_str']
        jh = round(latest['jh'], 1) if latest['jh'] else 0
        rsi = round(latest['rsi'], 2) if latest['rsi'] else 0
        pp = round(latest['pp'], 1) if latest['pp'] else 0
        brk = latest['brk'] or 0
        
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
