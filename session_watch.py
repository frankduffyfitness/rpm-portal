#!/usr/bin/env python3
"""RPM CMJ Session Watch — deterministic drift + experiment monitor.

Reads  : forcedecks_portal.json (the ForceDecks store), experiments.json
         (Frank's Phase-5 ledger registry), watch_state.json (what has already
         been said, so nothing is said twice).
Writes : watch.json (the rows the portal renders), watch_state.json (updated).

Two jobs, both arithmetic:

  REGRESSION — an athlete who tests often has drifted away from his own recent
  baseline on a strategy metric, by more than his own rep-to-rep noise. The bar
  is the athlete's OWN spread, not a roster percentile: the question is "is this
  him, changed?", not "how does he compare?".

  FOLLOW-UP / CONFIRMED — an open experiment in cmj_strategy/experiments.md has
  a new session. The row carries that session's manipulation numbers against
  their pre-registered bars plus the outcome numbers. It states no verdict:
  pre-registration means the ledger decides what a result means, not this file.

Design rules this file must keep:
  * DETERMINISTIC. Same store + same input state = byte-identical watch.json.
    No wall-clock anywhere in the output. Time is measured from `anchor`, the
    newest CMJ test date in the store (the bucket_engine convention).
  * NO THRESHOLD TUNING TO TASTE. The cuts are 2x the athlete's own SD with a
    5% floor. If the flag count looks wrong, that is a finding to report, not a
    knob to turn (the blueprint's over-bucketing lesson, applied to drift).
  * NO NEW RULES ANYWHERE ELSE. This writes data. The portal renders it, the
    engine ignores it, and Frank decides what to do about it.
"""

import json
import os
import statistics
import sys
import unicodedata
from datetime import datetime, timedelta

_HERE = os.path.dirname(os.path.abspath(__file__))

STORE_JSON = os.environ.get("RPM_FORCEDECKS_JSON") or os.path.join(
    _HERE, "forcedecks_portal.json")
EXPERIMENTS_JSON = os.environ.get("RPM_WATCH_EXPERIMENTS") or os.path.join(
    _HERE, "experiments.json")
STATE_JSON = os.environ.get("RPM_WATCH_STATE") or os.path.join(
    _HERE, "watch_state.json")
WATCH_JSON = os.environ.get("RPM_WATCH_JSON") or os.path.join(
    _HERE, "watch.json")

STATE_VERSION = 1

# ─── Windows and cuts ────────────────────────────────────────────────────────
# Universe: an athlete only enters the watch if he tests often enough that a
# 2-session move means something. Both windows are measured back from `anchor`.
RECENT_DAYS = 42          # >= RECENT_MIN sessions inside this window
RECENT_MIN = 2
HISTORY_DAYS = 120        # >= HISTORY_MIN sessions inside this window
HISTORY_MIN = 6

BASELINE_SLICE = (-12, -2)  # sessions [-12..-3]: the 10 before the last 2
BASELINE_MIN = 4            # fewer than this and the SD is not worth trusting
CURRENT_N = 2               # C = median of the last 2 sessions
SD_MULT = 2.0               # flag past 2x the athlete's own SD
FLOOR_PCT = 0.05            # ...but never on less than a 5% move
CLEAR_SD = 1.0              # CLEARED when the gap is back inside 1 SD

# DISPLAY tier only. This changes nothing about who flags: the bar above is the
# bar, and every flagged athlete is still emitted. It splits the flagged list
# into what a coach should look at today and what he should watch at the next
# session, because 20 rows of equal visual weight is 20 rows nobody reads.
# An athlete is "strong" when ANY ONE of his flagged metrics reaches this; the
# tier is per athlete, not per metric, because the athlete is who gets coached.
# Compared against the ROUNDED magnitude the row displays, so a row that reads
# "3.0x own noise" is never sorted into the quiet list.
STRONG_SD = 3.0

REP1_DROP_MIN = 3           # drop rep 1 only when the test has >= 3 reps

# ─── Metrics ─────────────────────────────────────────────────────────────────
# direction: -1 = higher is better (worse means it fell), +1 = higher is worse.
# Directions match bucket_engine.TREND_KPIS. brakingRfd is deliberately ABSENT:
# it measured 14.5% test-to-test CV (2026-08-06 changelog), which is drift-blind
# at this window length. Labels reuse generate_portal_data.STRAT_COL_LABELS
# wording so the Watch and the board name the same metric the same way.
WATCH_METRICS = [
    ("jumpHeight",      -1),
    ("rsiModified",     -1),
    ("ci100Ratio",      -1),
    ("fzvRatio",        -1),
    ("concPeakForce",   -1),
    ("contractionTime", +1),
]

METRIC_META = {
    # key: (plain-English label, unit, decimals)
    "jumpHeight":      ("jump height",                      "in",  2),
    "rsiModified":     ("reactive strength (RSI-mod)",      "",    3),
    "ci100Ratio":      ("first 100 ms share of the push",   "",    3),
    "fzvRatio":        ("force at the turn, share of peak", "",    3),
    "concPeakForce":   ("peak push force",                  "N",   0),
    "contractionTime": ("time to takeoff",                  "ms",  0),
    "conImpulse100":   ("first 100 ms impulse",             "N s", 1),
    "forceAtZeroV":    ("force at the turn",                "N",   0),
    "cmDepth":         ("countermovement depth",            "cm",  1),
    "cv:ci100Ratio":   ("first 100 ms share, session CV",   "",    3),
    "cv:jumpHeight":   ("jump height, session CV",          "",    3),
}

# Raw per-rep store keys the session medians are built from.
MEDIAN_KEYS = ("jumpHeight", "rsiModified", "ci100Ratio", "concPeakForce",
               "contractionTime", "conImpulse100", "forceAtZeroV", "cmDepth")
# Within-session coefficient of variation, for consistency-style experiments.
CV_KEYS = ("ci100Ratio", "jumpHeight")


def label_of(key):
    return METRIC_META.get(key, (key, "", 3))[0]


def unit_of(key):
    return METRIC_META.get(key, (key, "", 3))[1]


def fmt(value, key):
    """One display form per metric, decided here so React prints and nothing
    else. 2162.56 N -> "2,163", 0.8934 -> "0.893"."""
    if value is None:
        return ""
    dec = METRIC_META.get(key, (key, "", 3))[2]
    return f"{float(value):,.{dec}f}"


def norm_name(name):
    """Match names across the store, the ledger and the portal. Curly
    apostrophes are load-bearing here: the store spells him Shea O’Sullivan
    and every hand-written file spells him Shea O'Sullivan."""
    s = unicodedata.normalize("NFKC", str(name or "")).replace("’", "'")
    return " ".join(s.split()).strip().lower()


def log(msg):
    print(msg, flush=True)


# ─── Sessions ────────────────────────────────────────────────────────────────

def rep_values(metrics):
    """One rep -> the values the watch can use. fzvRatio is derived PER REP and
    then medianed, never medianed-then-divided: the ratio of two medians is not
    the median of the ratios, and the per-rep form is the one the S2 bucket and
    the ledger both quote."""
    out = {}
    for k in MEDIAN_KEYS:
        v = metrics.get(k)
        if v is not None:
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    fzv, cpf = out.get("forceAtZeroV"), out.get("concPeakForce")
    if fzv is not None and cpf:
        out["fzvRatio"] = fzv / cpf
    return out


def build_sessions(store):
    """{display_name: [ {date, values, n_reps}, ... oldest first ]}.

    A session is an athlete-day, not a test: an athlete who does two CMJ tests
    an hour apart did one session, and the rep-1 throwaway applies to each test
    separately because it is a per-test segmentation artifact.
    """
    by_athlete = {}
    for athlete in (store.get("athletes") or {}).values():
        name = " ".join(str(athlete.get("name") or "").split())
        if not name:
            continue
        days = {}
        for test in athlete.get("tests") or []:
            if test.get("testType") != "CMJ":
                continue
            date = (test.get("date") or "")[:10]
            if not date:
                continue
            trials = [t for t in (test.get("trials") or [])
                      if t.get("limb") == "Both"]
            if len(trials) >= REP1_DROP_MIN:
                trials = trials[1:]          # rep-1 throwaway (blueprint NN-4)
            for trial in trials:
                days.setdefault(date, []).append(
                    rep_values(trial.get("metrics") or {}))
        sessions = []
        for date in sorted(days):
            reps = days[date]
            values = {}
            for key in list(MEDIAN_KEYS) + ["fzvRatio"]:
                vals = [r[key] for r in reps if key in r]
                if vals:
                    values[key] = statistics.median(vals)
            for key in CV_KEYS:
                vals = [r[key] for r in reps if key in r]
                mean = statistics.fmean(vals) if vals else 0.0
                if len(vals) >= 2 and mean:
                    values[f"cv:{key}"] = statistics.stdev(vals) / abs(mean)
            if values:
                sessions.append({"date": date, "values": values,
                                 "n_reps": len(reps)})
        if sessions:
            by_athlete[name] = sessions
    return by_athlete


def anchor_date(by_athlete):
    """Newest CMJ session date in the store. Every window is measured from
    here, never from the clock, so a rerun next week says the same thing."""
    dates = [s["date"] for ss in by_athlete.values() for s in ss]
    return max(dates) if dates else ""


def in_universe(sessions, anchor):
    a = datetime.strptime(anchor, "%Y-%m-%d")
    recent = sum(1 for s in sessions
                 if datetime.strptime(s["date"], "%Y-%m-%d") >= a - timedelta(days=RECENT_DAYS))
    history = sum(1 for s in sessions
                  if datetime.strptime(s["date"], "%Y-%m-%d") >= a - timedelta(days=HISTORY_DAYS))
    return recent >= RECENT_MIN and history >= HISTORY_MIN


def days_between(anchor, date):
    return (datetime.strptime(anchor, "%Y-%m-%d")
            - datetime.strptime(date, "%Y-%m-%d")).days


# ─── Regression ──────────────────────────────────────────────────────────────

def metric_series(sessions, key):
    return [(s["date"], s["values"][key]) for s in sessions if key in s["values"]]


def evaluate_metric(sessions, key, direction, prior):
    """One athlete, one metric. Returns None when there is not enough history,
    otherwise a dict with the comparison.

    When the metric is ALREADY flagged, B and s are the ones it was flagged
    against, carried in the state file, not recomputed. Recomputing would roll
    the baseline forward over the very sessions that caused the flag, and the
    flag would quietly clear itself while the athlete was still down.
    """
    series = metric_series(sessions, key)
    if len(series) < CURRENT_N + 1:
        return None
    current = series[-CURRENT_N:]
    baseline = series[BASELINE_SLICE[0]:BASELINE_SLICE[1]]
    if len(baseline) < BASELINE_MIN:
        return None

    if prior:
        B, s, floor = prior["B"], prior["s"], prior["floor"]
        base_dates = prior["baseline_sessions"]
    else:
        B = statistics.median(v for _, v in baseline)
        s = statistics.stdev([v for _, v in baseline])
        floor = FLOOR_PCT * abs(B)
        base_dates = [baseline[0][0], baseline[-1][0]]

    C = statistics.median(v for _, v in current)
    worse = (C - B) if direction > 0 else (B - C)
    bar = max(SD_MULT * s, floor)
    return {
        "key": key, "direction": direction,
        "B": B, "s": s, "C": C, "floor": floor, "bar": bar,
        "worse": worse,
        "floor_used": bool(floor > SD_MULT * s),
        "magnitude_in_sd": (worse / s) if s else None,
        "flagged_now": worse > bar,
        "cleared_now": worse <= CLEAR_SD * s,
        "baseline_sessions": base_dates,
        "current_sessions": [d for d, _ in current],
    }


def metric_row(ev):
    key = ev["key"]
    mag = ev["magnitude_in_sd"]
    return {
        "key": key,
        "label": label_of(key),
        "unit": unit_of(key),
        "B": round(ev["B"], 4),
        "C": round(ev["C"], 4),
        "s": round(ev["s"], 4),
        "Bdisp": fmt(ev["B"], key),
        "Cdisp": fmt(ev["C"], key),
        "magnitude_in_sd": round(mag, 2) if mag is not None else None,
        "sdDisp": (f"{mag:.1f}" if mag is not None else ""),
        "floor_used": ev["floor_used"],
        "direction": ev["direction"],
        "baseline_sessions": ev["baseline_sessions"],
    }


def run_regressions(by_athlete, anchor, state):
    """REGRESSION + CLEARED rows. State is keyed athlete||metric so one athlete
    can be flagged on RSI while his jump height is fine, and can clear one
    without clearing the other."""
    open_state = state.setdefault("regressions", {})
    rows, cleared_rows = [], []
    universe = []
    dist = {}

    for name in sorted(by_athlete):
        sessions = by_athlete[name]
        if not in_universe(sessions, anchor):
            continue
        universe.append(name)
        flagged, cleared = [], []
        for key, direction in WATCH_METRICS:
            skey = f"{name}||{key}"
            prior = open_state.get(skey)
            ev = evaluate_metric(sessions, key, direction, prior)
            if ev is None:
                continue
            if prior:
                if ev["cleared_now"]:
                    cleared.append(ev)
                    open_state.pop(skey, None)
                else:
                    flagged.append(ev)
            elif ev["flagged_now"]:
                open_state[skey] = {
                    "since": anchor,
                    "B": ev["B"], "s": ev["s"], "floor": ev["floor"],
                    "baseline_sessions": ev["baseline_sessions"],
                }
                flagged.append(ev)

        last_date = sessions[-1]["date"]
        if flagged:
            for ev in flagged:
                dist[ev["key"]] = dist.get(ev["key"], 0) + 1
            metrics = [metric_row(e) for e in
                       sorted(flagged, key=lambda x: -(x["magnitude_in_sd"] or 0))]
            worst = max((m["magnitude_in_sd"] or 0) for m in metrics)
            rows.append({
                "type": "REGRESSION",
                "athlete": name,
                "metrics": metrics,
                "sessions": flagged[0]["current_sessions"],
                "days_since": days_between(anchor, last_date),
                "since": min(open_state[f"{name}||{e['key']}"]["since"] for e in flagged),
                "worst_sd": round(worst, 2),
                "tier": "strong" if worst >= STRONG_SD else "early",
            })
        if cleared:
            cleared_rows.append({
                "type": "CLEARED",
                "athlete": name,
                "metrics": [metric_row(e) for e in cleared],
                "sessions": cleared[0]["current_sessions"],
                "days_since": days_between(anchor, last_date),
            })

    rows.sort(key=lambda r: (-r["worst_sd"], r["athlete"]))
    cleared_rows.sort(key=lambda r: r["athlete"])
    return rows, cleared_rows, universe, dist


# ─── Experiments ─────────────────────────────────────────────────────────────

def bar_check(value, bar, direction):
    if value is None:
        return False
    return value >= bar if direction == ">=" else value <= bar


def manipulation_rows(session, manipulation):
    out = []
    for m in manipulation:
        key = m.get("metric")
        value = (session or {}).get("values", {}).get(key)
        out.append({
            "key": key,
            "label": label_of(key),
            "unit": unit_of(key),
            "value": round(value, 4) if value is not None else None,
            "valueDisp": fmt(value, key),
            "bar": m.get("bar"),
            "barDisp": fmt(m.get("bar"), key),
            "direction": m.get("direction", ">="),
            "met": bar_check(value, m.get("bar"), m.get("direction", ">=")),
            "note": m.get("note", ""),
        })
    return out


def outcome_rows(session, outcome):
    out = []
    for o in outcome:
        key = o.get("metric")
        value = (session or {}).get("values", {}).get(key)
        out.append({
            "key": key,
            "label": label_of(key),
            "unit": unit_of(key),
            "value": round(value, 4) if value is not None else None,
            "valueDisp": fmt(value, key),
            "note": o.get("note", ""),
        })
    return out


def run_experiments(by_athlete, anchor, state, experiments):
    """FOLLOW-UP + CONFIRMED rows.

    last_seen_session is tracked in watch_state.json, NOT written back into
    experiments.json: the ledger file is Frank's, hand-edited, and a script that
    rewrites it would fight him for it. experiments.json's own
    `last_seen_session` is the seed value the state starts from.
    """
    by_norm = {norm_name(n): n for n in by_athlete}
    ex_state = state.setdefault("experiments", {})
    follow, confirmed = [], []

    for entry in experiments:
        eid = entry.get("id")
        if not eid or entry.get("status") != "open":
            continue
        display = by_norm.get(norm_name(entry.get("athlete")))
        if not display:
            log(f"  {eid}: athlete {entry.get('athlete')!r} not in store — skipped")
            continue
        sessions = by_athlete[display]
        st = ex_state.setdefault(eid, {"last_seen_session": None,
                                       "confirmed_emitted": False})
        seen = (st.get("last_seen_session") or entry.get("last_seen_session")
                or entry.get("registered") or "")
        registered = entry.get("registered") or ""

        newer = [s for s in sessions if s["date"] > seen]
        if newer:
            session = newer[-1]
            follow.append({
                "type": "FOLLOW-UP",
                "athlete": display,
                "experiment_id": eid,
                "title": entry.get("title", ""),
                "sessions": [session["date"]],
                "days_since": days_between(anchor, session["date"]),
                "n_reps": session["n_reps"],
                "manipulation": manipulation_rows(session, entry.get("manipulation") or []),
                "outcome_values": outcome_rows(session, entry.get("outcome") or []),
                "registered": registered,
            })
            st["last_seen_session"] = session["date"]

        # CONFIRMED: three straight sessions, all bars met, all on or after the
        # day the experiment was registered. Sessions from before the
        # intervention cannot confirm the intervention.
        post = [s for s in sessions if s["date"] >= registered] if registered else sessions
        last3 = post[-3:]
        if (len(last3) == 3 and not st.get("confirmed_emitted")
                and all(all(bar_check(s["values"].get(m.get("metric")), m.get("bar"),
                                      m.get("direction", ">="))
                            for m in (entry.get("manipulation") or []))
                        for s in last3)):
            confirmed.append({
                "type": "CONFIRMED",
                "athlete": display,
                "experiment_id": eid,
                "title": entry.get("title", ""),
                "sessions": [s["date"] for s in last3],
                "days_since": days_between(anchor, last3[-1]["date"]),
                "manipulation": manipulation_rows(last3[-1], entry.get("manipulation") or []),
                "outcome_values": outcome_rows(last3[-1], entry.get("outcome") or []),
                "registered": registered,
            })
            st["confirmed_emitted"] = True
            st["confirmed_on"] = last3[-1]["date"]

    follow.sort(key=lambda r: r["experiment_id"])
    confirmed.sort(key=lambda r: r["experiment_id"])
    return follow, confirmed


# ─── IO ──────────────────────────────────────────────────────────────────────

def load_json(path, default, what):
    if not os.path.exists(path):
        log(f"  {what}: none at {path} — starting empty")
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as exc:                                  # noqa: BLE001
        log(f"  WARNING: could not read {what} at {path} ({exc}) — starting empty")
        return default


def main():
    log("=" * 60)
    log("CMJ Session Watch")
    log("=" * 60)

    if not os.path.exists(STORE_JSON):
        log(f"ERROR: no ForceDecks store at {STORE_JSON}")
        return 1
    with open(STORE_JSON) as f:
        store = json.load(f)

    experiments_doc = load_json(EXPERIMENTS_JSON, {"experiments": []}, "experiments.json")
    experiments = experiments_doc.get("experiments") or []
    state = load_json(STATE_JSON, {}, "watch_state.json")
    state.setdefault("state_version", STATE_VERSION)

    by_athlete = build_sessions(store)
    anchor = anchor_date(by_athlete)
    if not anchor:
        log("ERROR: no CMJ sessions in the store")
        return 1
    log(f"  athletes with CMJ sessions: {len(by_athlete)}")
    log(f"  anchor (newest CMJ date):   {anchor}")

    regressions, cleared, universe, dist = run_regressions(by_athlete, anchor, state)
    follow, confirmed = run_experiments(by_athlete, anchor, state, experiments)

    rows = regressions + follow + confirmed + cleared
    watch = {
        "schema": "rpm.cmj.watch/v1",
        "meta": {
            "anchor": anchor,
            "universe_n": len(universe),
            "flagged_n": len(regressions),
            "flagged_metric_n": sum(len(r["metrics"]) for r in regressions),
            # Display tiers, not a second bar: strong + early == flagged_n.
            "strong_n": sum(1 for r in regressions if r["tier"] == "strong"),
            "early_n": sum(1 for r in regressions if r["tier"] == "early"),
            "followup_n": len(follow),
            "confirmed_n": len(confirmed),
            "cleared_n": len(cleared),
            "state_version": state.get("state_version", STATE_VERSION),
        },
        "rows": rows,
    }
    state["anchor"] = anchor

    with open(WATCH_JSON, "w") as f:
        json.dump(watch, f, indent=2, sort_keys=True)
        f.write("\n")
    with open(STATE_JSON, "w") as f:
        json.dump(state, f, indent=2, sort_keys=True)
        f.write("\n")

    log("")
    log(f"  universe:    {len(universe)} athletes "
        f"(>={RECENT_MIN} sessions in {RECENT_DAYS}d and >={HISTORY_MIN} in {HISTORY_DAYS}d)")
    log(f"  REGRESSION:  {len(regressions)} athletes, "
        f"{sum(len(r['metrics']) for r in regressions)} athlete-metrics "
        f"({sum(1 for r in regressions if r['tier'] == 'strong')} strong, "
        f"{sum(1 for r in regressions if r['tier'] == 'early')} early)")
    for key, _d in WATCH_METRICS:
        log(f"      {label_of(key):36s} {dist.get(key, 0)}")
    log(f"  CLEARED:     {len(cleared)}")
    log(f"  FOLLOW-UP:   {len(follow)}")
    log(f"  CONFIRMED:   {len(confirmed)}")
    log("")
    for r in regressions:
        worst = r["metrics"][0]
        log(f"    [{r['tier']:6s}] {r['athlete']:26s} {worst['label']:36s} "
            f"{worst['Bdisp']} -> {worst['Cdisp']}  ({worst['sdDisp']} SD)"
            f"{'  +%d more' % (len(r['metrics']) - 1) if len(r['metrics']) > 1 else ''}")
    log("")
    log(f"  wrote {WATCH_JSON}")
    log(f"  wrote {STATE_JSON}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
