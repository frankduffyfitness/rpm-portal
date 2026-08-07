#!/usr/bin/env python3
"""RPM evaluation report card — one page, for any athlete in the portal data.

Built for NEW athletes: the public portal gates search at 5 sessions, so a
first-timer can't reach their own card there. This renders the same design
standalone from whatever data exists.

    python3 report_cards/gen_eval_report.py "Marcos Lopez"
    python3 report_cards/gen_eval_report.py "Marcos Lopez" --out ~/Desktop

Reads the BUILT src/App.jsx (never re-derives conventions): _A for CMJ,
_PHY for the power block, _HA for hop, _N/_HN for norms, _FEM for the
female-athlete rule, and RPM_LOGO_DARK for the mark. Percentiles use the
portal's own cP interpolation so the numbers match the site exactly.

This lives in the repo ON PURPOSE — two previous versions of this tool were
written to a scratchpad and lost when it was cleaned.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
APP = os.path.join(REPO, "src", "App.jsx")
FONT = os.path.join(HERE, "dmsans_embed.css")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

GROUP_LABEL = {"hs": "High School", "col": "College", "ms": "Middle School",
               "pro": "Pro", "stf": "Staff", "ml": "Men's League", "fem": "Female Athletes"}


def arr(src, name, opener="["):
    """Pull a top-level const array/object out of the built App.jsx."""
    pat = r"const " + name + r" = (\[.*?\]);\n" if opener == "[" else r"const " + name + r" = (\{.*?\});\n"
    m = re.search(pat, src, re.S)
    return json.loads(m.group(1)) if m else None


def cP(v, n, invert=False):
    """Verbatim port of the portal's percentile interpolation."""
    if v <= n["p10"]:
        raw = max(1, round((v / n["p10"]) * 10))
    elif v <= n["p25"]:
        raw = 10 + round(((v - n["p10"]) / (n["p25"] - n["p10"])) * 15)
    elif v <= n["p50"]:
        raw = 25 + round(((v - n["p25"]) / (n["p50"] - n["p25"])) * 25)
    elif v <= n["p75"]:
        raw = 50 + round(((v - n["p50"]) / (n["p75"] - n["p50"])) * 25)
    elif v <= n["p90"]:
        raw = 75 + round(((v - n["p75"]) / (n["p90"] - n["p75"])) * 15)
    else:
        raw = min(99, 90 + round(((v - n["p90"]) / (n["p90"] * 0.15)) * 9))
    return max(1, min(99, 100 - raw)) if invert else raw


def ordinal(p):
    return "th" if 10 <= p % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(p % 10, "th")


def tier(p):
    return ("Elite" if p >= 90 else "Above Average" if p >= 75 else
            "Average" if p >= 50 else "Developing" if p >= 25 else "Building")


def band(p):
    return "#1B7F4B" if p >= 75 else "#B7791F" if p >= 40 else "#C0392B"


def strip_tags(t):
    return re.sub(r"<[^>]+>", "", str(t)).strip()


def row(label, val, desc, pct):
    w = max(2, min(99, pct))
    return f"""
    <div class="mrow">
      <div class="mtop">
        <div class="mlab"><div class="mname">{label}</div><div class="mdesc">{desc}</div></div>
        <div class="mval">{val}</div>
        <div class="mpct" style="color:{band(pct)}"><span class="pnum">{pct}<span class="pord">{ordinal(pct)}</span></span><br><span class="ptier">{tier(pct)}</span></div>
      </div>
      <div class="bar"><div class="tick" style="left:25%"></div><div class="tick" style="left:50%"></div><div class="tick" style="left:75%"></div>
        <div class="fill" style="width:{w}%"><div class="grad" style="width:{10000 / w:.1f}%"></div></div>
      </div>
      <div class="bscale"><span>0</span><span>25th</span><span>50th</span><span>75th</span><span>99th</span></div>
    </div>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("athlete")
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop"))
    ap.add_argument("--summary", default=None,
                    help="Coach paragraph for the callout. Omit for a data-driven default.")
    a = ap.parse_args()

    src = open(APP).read()
    A, PHY, HA = arr(src, "_A"), arr(src, "_PHY"), arr(src, "_HA")
    N, HN = arr(src, "_N", "{"), arr(src, "_HN", "{")
    FEM = set(arr(src, "_FEM") or [])
    updated = re.search(r'const LAST_UPDATED = "([^"]*)"', src).group(1)

    want = " ".join(a.athlete.split()).casefold()
    hit = next((r for r in A if " ".join(r[0].split()).casefold() == want), None)
    if not hit:
        sys.exit(f"'{a.athlete}' not found in the portal CMJ data (_A). "
                 "Run a VALD sync + generate_portal_data.py first.")
    name, grp, bw, sessions, latest = hit[0], hit[2], hit[3], hit[4], hit[5]
    cmj = {"jh": hit[6], "rsi": hit[7], "ci": hit[8], "brk": hit[9], "depth": hit[18]}
    norms = N.get(grp) or N["all"]
    cohort = f"RPM {GROUP_LABEL.get(grp, grp)} athletes" if N.get(grp) else "all RPM athletes"
    female = name in FEM or grp == "fem"

    rows = []
    if not female and bw and norms.get("bodyweight"):
        rows.append(("Bodyweight", f"{bw} <span class='u'>lbs</span>",
                     "Body mass on the plates. Context for every force number below.",
                     cP(bw, norms["bodyweight"])))
    rows += [
        ("Jump Height", f"{cmj['jh']}&Prime;",
         "How high the athlete jumps. The headline measure of lower-body power.", cP(cmj["jh"], norms["cmjHeight"])),
        ("RSI-modified", f"{cmj['rsi']}",
         "Jump height relative to time on the ground. Explosiveness per second of effort.", cP(cmj["rsi"], norms["rsiMod"])),
        ("Concentric Impulse", f"{cmj['ci']} <span class='u'>N&middot;s</span>",
         "Total drive applied through the push-off. Closely tied to takeoff velocity.", cP(cmj["ci"], norms["conImpulse"])),
        ("Eccentric Braking Force", f"{cmj['brk']} <span class='u'>&times;BW</span>",
         "How forcefully the body absorbs and reverses the dip in a jump, relative to bodyweight."
         + (f" This jump: ~{round(cmj['depth'])} cm countermovement dip." if cmj.get("depth") else ""),
         cP(cmj["brk"], norms["eccBrakingRFD"])),
    ]
    phy = next((p for p in PHY if p[0] == name), None)
    if phy and phy[1]:
        lt = phy[1]   # [bw, jh, ci, ci100, peakPower, peakPowerBM, meanPowerBM, rsi]
        for idx, key, label, unit, desc in (
            (4, "peakPower", "Peak Power", "W", "Peak mechanical power in the jump. Raw engine output."),
            (5, "peakPowerBM", "Peak Power / BM", "W/kg", "Peak power per kilo of bodyweight — power independent of size."),
            (3, "conImpulse100", "Impulse @ 100ms", "N&middot;s", "Drive produced in the first tenth of a second — how fast force arrives."),
        ):
            if lt[idx] is not None and norms.get(key):
                rows.append((label, f"{round(lt[idx],1)} <span class='u'>{unit}</span>", desc, cP(lt[idx], norms[key])))

    hop = next((h for h in HA if h[0] == name), None)
    hop_rows = []
    if hop and HN.get(grp):
        hn = HN[grp]
        for val, key, label, unit, desc, inv in (
            (hop[6], "rsi", "Reactive Strength Index", "", "Flight time divided by contact time. How efficiently ground contact becomes explosive hops.", False),
            (hop[7], "ct", "Contact Time", " ms", "Time on the ground between hops. Shorter with maintained height shows better stiffness.", True),
            (hop[8], "ft", "Flight Time", " ms", "Time in the air between hops. Longer flight from short contact means more force, faster.", False),
        ):
            if val is not None:
                hop_rows.append(row(label, f"{val}<span class='u'>{unit}</span>", desc, cP(val, hn[key], inv)))

    logo = re.search(r'const RPM_LOGO_DARK = "(data:image/png;base64,[^"]+)"', src).group(1)
    fonts = open(FONT).read()
    first = sessions == 1
    title = "New Athlete Evaluation" if first else "Athlete Evaluation Report"
    sub = f"First session &middot; {latest}" if first else f"{sessions} sessions &middot; latest {latest}"
    banner = (f"Percentiles compare {name.split()[0]} with {cohort}. A first evaluation is a starting line, "
              "not a verdict: these numbers are the baseline every future test is measured against."
              if first else
              f"Percentiles compare {name.split()[0]} with {cohort}.")

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{name} - RPM Evaluation Report</title><style>
{fonts}
*{{margin:0;padding:0;box-sizing:border-box}}@page{{size:letter;margin:0}}
body{{font-family:'DM Sans','Helvetica Neue',sans-serif;color:#1B2A44;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.page{{width:816px;min-height:1056px;margin:0 auto;padding:44px 52px 40px;position:relative}}
.tophdr{{display:flex;justify-content:space-between;align-items:center}}
.gen{{text-align:right;font-size:9.5px;color:#5B6470;line-height:1.5}}
.rule{{border-bottom:3px solid #1B2A44;margin:9px 0 12px}}
.idrow{{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:6px}}
.aname{{font-size:22px;font-weight:800}}.asub{{font-size:10.5px;color:#5B6470;margin-top:1px}}
.rtitle{{font-size:14px;font-weight:800;color:#DD5228;text-align:right}}.rsub{{font-size:9.5px;color:#5B6470;text-align:right}}
.cohort{{font-size:9.5px;color:#5B6470;background:#F4F5F7;border-radius:6px;padding:7px 10px;margin:10px 0 4px;line-height:1.5}}
.cols{{display:flex;gap:26px}}.col{{flex:1;min-width:0}}
.sect{{font-size:12.5px;font-weight:800;color:#DD5228;margin:14px 0 1px}}.scap{{font-size:8.5px;color:#98A0AA;margin-bottom:4px}}
.mrow{{padding:8px 0 7px;border-bottom:1px solid #E3E6EA}}.mtop{{display:flex;align-items:flex-start;margin-bottom:5px}}
.mlab{{flex:1;padding-right:8px}}.mname{{font-size:11.5px;font-weight:800}}
.mdesc{{font-size:7.8px;color:#98A0AA;line-height:1.35;margin-top:1px}}
.mval{{width:92px;font-size:16px;font-weight:800;padding-top:1px}}
.u{{font-size:9px;font-weight:500;color:#98A0AA}}
.mpct{{width:74px;text-align:right;line-height:1.15}}.pnum{{font-size:14px;font-weight:800}}.pord{{font-size:8px}}.ptier{{font-size:8px;font-weight:700}}
.bar{{position:relative;height:7px;background:#EEF0F3;border-radius:4px}}
.tick{{position:absolute;top:0;width:1px;height:100%;background:#DDE1E6;z-index:1}}
.fill{{position:absolute;left:0;top:0;height:100%;border-radius:4px;overflow:hidden}}
.grad{{height:100%;background:linear-gradient(90deg,#C0392B 0%,#E8A13D 50%,#1B7F4B 100%)}}
.bscale{{display:flex;justify-content:space-between;font-size:6.5px;color:#98A0AA;margin-top:2px}}
.summary{{margin-top:16px;background:#F4F5F7;border-left:3px solid #1B2A44;border-radius:0 8px 8px 0;padding:11px 14px}}
.sumhd{{font-size:11px;font-weight:800;margin-bottom:3px}}.sumtx{{font-size:9.8px;color:#33405A;line-height:1.55}}
.foot{{position:absolute;left:52px;right:52px;bottom:26px;border-top:1px solid #E3E6EA;padding-top:8px;display:flex;justify-content:space-between;font-size:8.5px;color:#98A0AA}}
</style></head><body><div class="page">
<div class="tophdr"><img src="{logo}" style="height:30px" alt="RPM Strength"><div class="gen">Generated {updated}<br>rpmstrength.coach</div></div>
<div class="rule"></div>
<div class="idrow"><div><div class="aname">{name}</div><div class="asub">{GROUP_LABEL.get(grp, grp)}{'' if female else f' &middot; {bw} lbs'} &middot; Athlete Performance Report</div></div>
<div><div class="rtitle">{title}</div><div class="rsub">{sub} &middot; VALD ForceDecks</div></div></div>
<div class="cohort">{banner}</div>
<div class="cols"><div class="col">
  <div class="sect">Countermovement Jump</div><div class="scap">Lower-body explosive power &middot; VALD ForceDecks</div>
  {''.join(row(*r) for r in rows[:len(rows)//2 + len(rows)%2])}
</div><div class="col">
  <div class="sect">{'Hop Test (Reactivity)' if hop_rows else 'Power &amp; Rate'}</div>
  <div class="scap">{'Repeated-hop reactive ability' if hop_rows else 'How much, and how fast'}</div>
  {''.join(hop_rows) if hop_rows else ''.join(row(*r) for r in rows[len(rows)//2 + len(rows)%2:])}
</div></div>
<div class="summary"><div class="sumhd">{'What this baseline shows' if first else 'Where this athlete stands'}</div>
<div class="sumtx">{{SUMMARY}}</div></div>
<div class="foot"><span>RPM Strength &middot; Queens, NY</span><span>Data: VALD ForceDecks &middot; Percentiles vs {cohort}</span></div>
</div></body></html>"""

    if a.summary:
        summary = a.summary
    else:
        # Data-driven fallback: name the top and bottom of the profile honestly.
        ranked = sorted(rows, key=lambda r: -r[3])
        hi, lo = ranked[0], ranked[-1]
        strip = lambda t: re.sub(r"<[^>]+>", "", t).strip()
        summary = (f"<b>{name.split()[0]}'s standout number is {hi[0].lower()} at the "
                   f"{hi[3]}{ordinal(hi[3])} percentile ({strip(hi[1])}).</b> The lowest of the set is "
                   f"{lo[0].lower()} at the {lo[3]}{ordinal(lo[3])} ({strip(lo[1])}), which is the natural "
                   f"place to aim training first. "
                   + ("Every number here comes from a single session, so treat it as the starting line: "
                      "the value is in what the next test shows against it." if first else
                      "Percentiles move as the group changes, so read them alongside the raw numbers."))
    html = html.replace("{SUMMARY}", summary)

    os.makedirs(a.out, exist_ok=True)
    out_html = os.path.join(a.out, f"{name} - RPM Evaluation Report.html")
    out_pdf = os.path.join(a.out, f"{name} - RPM Evaluation Report.pdf")
    open(out_html, "w").write(html)
    if os.path.exists(CHROME):
        subprocess.run([CHROME, "--headless", "--disable-gpu", f"--print-to-pdf={out_pdf}",
                        "--no-pdf-header-footer", out_html], check=True, capture_output=True)
    print(json.dumps({"name": name, "group": grp, "bw": bw, "sessions": sessions,
                      "rows": [(r[0], strip_tags(r[1]), r[3]) for r in rows],
                      "hop": bool(hop_rows), "pdf": out_pdf}, indent=1))


if __name__ == "__main__":
    main()
