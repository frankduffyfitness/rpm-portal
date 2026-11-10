"""Board data for the Training tab: visits per week and automatic targets.

    python board_data.py [forcedecks_portal.json.gz] [dynamo_portal.json] > src/board_data.json

Runs in the ForceDecks sync workflow right after generate_portal_data.py. Reads
only repo files, so it works on the GitHub runner.

Per athlete with any test in the last 200 days:
  days   every date in the last 70 days with ANY ForceDecks test (CMJ, hop,
         plyo push-up, ...) or a DynaMo test. Frank 2026-11-10: some athletes
         don't jump (Abe Florman tests plyo push-ups), so a visit is any test day.
  s      CMJ sessions in the last 200 days as [date, concentric impulse, RSI-mod]
         (median of the session's trials); the page reads targets off these.
  ciPct / rsiPct   where his last-3-session median sits inside his VALD group
         (0-100). The lower one is his target metric (Frank 2026-11-09: biggest
         gap vs his age group).
"""
import gzip, json, re, statistics as st, sys
from datetime import date, datetime, timedelta

FD = sys.argv[1] if len(sys.argv) > 1 else "forcedecks_portal.json.gz"
DY = sys.argv[2] if len(sys.argv) > 2 else "dynamo_portal.json"
TODAY = date.today()
GROUPS = [("Middle School", "ms"), ("High School", "hs"), ("College", "col"), ("Pro", "pro")]


def norm(s):
    s = (s or "").lower().replace("’", "'")
    return re.sub(r"[^a-z]", "", s)


def group_of(a):
    g = a.get("groups") or []
    if "Staff" in g:
        return "stf"
    return next((k for name, k in GROUPS if name in g), None)


def load(path):
    try:
        return json.load(gzip.open(path, "rt") if path.endswith(".gz") else open(path))
    except Exception:
        return {}


def pct(v, pool):
    return round(100 * sum(1 for x in pool if x < v) / len(pool)) if pool else None


def main():
    fd, dy = load(FD), load(DY)
    out = {}
    for a in (fd.get("athletes") or {}).values():
        days, sess = set(), []
        for t in a.get("tests") or []:
            try:
                d = datetime.fromisoformat(t["date"][:19]).date()
            except Exception:
                continue
            if (TODAY - d).days <= 70:
                days.add(d.isoformat())
            if t.get("testType") == "CMJ" and (TODAY - d).days <= 200:
                ms = [tr.get("metrics") or {} for tr in t.get("trials") or []]
                ci = [m["concentricImpulse"] for m in ms if isinstance(m.get("concentricImpulse"), (int, float))
                      and isinstance(m.get("jumpHeight"), (int, float)) and 4 <= m["jumpHeight"] <= 40]
                rs = [m["rsiModified"] for m in ms if isinstance(m.get("rsiModified"), (int, float))
                      and isinstance(m.get("jumpHeight"), (int, float)) and 4 <= m["jumpHeight"] <= 40]
                if ci and rs:
                    sess.append([d.isoformat(), round(st.median(ci), 1), round(st.median(rs), 3)])
        if not days and not sess:
            continue
        sess.sort()
        out[norm(a.get("name"))] = {"name": a.get("name"), "group": group_of(a), "days": days, "s": sess}
    dath = dy.get("athletes") or []
    for a in (dath.values() if isinstance(dath, dict) else dath):
        k = norm(a.get("name"))
        for t in a.get("tests") or []:
            try:
                d = date.fromisoformat(t["date"][:10])
            except Exception:
                continue
            if (TODAY - d).days <= 70:
                out.setdefault(k, {"name": a.get("name"), "group": None, "days": set(), "s": []})["days"].add(d.isoformat())
    # Group percentiles off each athlete's last three CMJ sessions (last 60 days).
    cur = {}
    for k, r in out.items():
        recent = [x for x in r["s"] if (TODAY - date.fromisoformat(x[0])).days <= 60][-3:]
        if recent and r["group"] in ("ms", "hs", "col", "pro"):
            cur[k] = (r["group"], st.median(x[1] for x in recent), st.median(x[2] for x in recent))
    for k, (g, ci, rs) in cur.items():
        pool = [v for v in cur.values() if v[0] == g]
        if len(pool) >= 8:
            out[k]["ciPct"] = pct(ci, [v[1] for v in pool])
            out[k]["rsiPct"] = pct(rs, [v[2] for v in pool])
    for r in out.values():
        r["days"] = sorted(r["days"])
    json.dump({"generated": TODAY.isoformat(), "athletes": out}, sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
