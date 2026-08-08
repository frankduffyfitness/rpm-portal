#!/usr/bin/env python3
"""RPM pitching report card — broadcast-style one-pager.

    python3 report_cards/gen_pitching_report.py "Thomas LoBello"

Design intent: the portal is the working tool (dark, dense, fast); THIS is the
artifact that leaves the building — parents, recruiters, the athlete's phone. So
it is light, printed, and built to be read cold by someone who has never seen a
Shape+ number before. Hence the scale legend in the footer: a grade nobody can
interpret is a grade nobody trusts.

Structure, in priority order:
  1. Navy hero — who, what level, what they threw, and the headline grades
  2. Three panels — release point, movement profile, pitch mix
  3. The table — the payload; only the three grade columns carry colour chips
     so the eye lands on them and the other ten columns stay available-but-quiet
  4. Footer — what the scale means

Pitch colour is one system across all three panels and the table, so the card
reads as a single object rather than three charts stapled together. Hues match
the portal's PITCH_COLORS (fastball red, changeup green, ...) but are darkened
for white paper — same identity, legible in print.

Reads the built src/App.jsx: _ARS (grades + per-type), _TMR (per-pitch dots),
_VELO (session velo), RPM_LOGO_DARK.
"""
import argparse
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

NAVY, INK, MUT, FAINT = "#16233C", "#1B2A44", "#5B6470", "#98A0AA"
LINE, PANEL = "#E3E6EA", "#F7F8FA"
GROUP = {"hs": "High School", "col": "College", "ms": "Middle School",
         "pro": "Pro", "stf": "Staff", "ml": "Men's League", "fem": "Female Athletes"}
# Portal hues, darkened for white paper.
PC = {"Fastball": "#D93A3A", "Sinker": "#E0701B", "Cutter": "#0E86A8",
      "Slider": "#8B4FD0", "Sweeper": "#C98A00", "Curveball": "#2F6FD0",
      "Changeup": "#12A06A", "Splitter": "#C93E86", "Other": "#6B7280"}
AB = {"Fastball": "FB", "Sinker": "SI", "Cutter": "CT", "Slider": "SL", "Sweeper": "SW",
      "Curveball": "CB", "Changeup": "CH", "Splitter": "SP", "Other": "OT"}


def arr(src, name, opener="["):
    pat = (r"const " + name + r" = (\[.*?\]);\n") if opener == "[" else (r"const " + name + r" = (\{.*?\});\n")
    m = re.search(pat, src, re.S)
    return json.loads(m.group(1)) if m else None


GREEN, GREEN2, AMBER, RED = "#1B7F4B", "#4A9E5C", "#B7791F", "#C0392B"


def grade_color(v, scale="plus"):
    """Three scales live on this card and they are NOT interchangeable:
      plus    100-centred (Shape+/Strike+/Overall), 10 pts = 1 SD
      scout   20-80 scouting scale, 50 = average, 60 = plus
      pct     zone/strike rate, higher better, ~50% is solid
    Colouring all three on the 100-centred scale paints every honest 60 grade
    red — which is what the first draft of this card did."""
    if v is None:
        return FAINT
    if scale == "scout":
        return GREEN if v >= 60 else GREEN2 if v >= 55 else MUT if v >= 45 else AMBER
    if scale == "pct":
        return GREEN if v >= 58 else GREEN2 if v >= 50 else MUT if v >= 42 else AMBER
    return GREEN if v >= 115 else GREEN2 if v >= 105 else MUT if v >= 95 else AMBER if v >= 85 else RED


def chip(v, scale="plus", suffix=""):
    if v is None:
        return '<span class="chip chip-na">&ndash;</span>'
    c = grade_color(v, scale)
    return f'<span class="chip" style="color:{c};background:{c}14;border-color:{c}33">{v}{suffix}</span>'


def num(v, dec=0, suffix=""):
    """No trailing .0 — 2247 not 2247.0, 87% not 87.0%."""
    if v is None:
        return "&ndash;"
    f = float(v)
    return (f"{f:.{dec}f}" if dec else f"{round(f):g}") + suffix


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("athlete")
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop"))
    a = ap.parse_args()
    src = open(APP).read()
    ARS = arr(src, "_ARS", "{")
    TMR = arr(src, "_TMR", "{")
    VELO = arr(src, "_VELO")
    updated = re.search(r'const LAST_UPDATED = "([^"]*)"', src).group(1)
    logo = re.search(r'const RPM_LOGO_DARK = "(data:image/png;base64,[^"]+)"', src).group(1)

    want = " ".join(a.athlete.split()).casefold()
    name = next((n for n in ARS["athletes"] if " ".join(n.split()).casefold() == want), None)
    if not name:
        sys.exit(f"'{a.athlete}' is not on the arsenal board. Graded athletes:\n  "
                 + ", ".join(sorted(ARS["athletes"])[:12]) + " ...")
    ath = ARS["athletes"][name]
    types = [t for t in ath["types"] if t[0] != "Other" and t[2]]
    types.sort(key=lambda t: -(t[2] or 0))
    sessions = TMR.get(name, [])
    v = next((x for x in VELO if x[0] == name), None)

    # pooled per-pitch dots, mapped onto our sorted type order
    idx = {t[0]: i for i, t in enumerate(types)}
    dots = []
    for s in sessions:
        for d in (s.get("dots") or []):
            nm = (s["types"][d[0]] or [None])[0] if d[0] >= 0 and d[0] < len(s["types"]) else None
            if nm in idx:
                dots.append((idx[nm], d[1], d[2], d[3], d[4]))

    # ---- panel 1: movement profile (IVB vs HB) ----
    W = H = 200
    mv = [(i, x, y) for i, y, x, _, _ in dots if x is not None and y is not None]
    lim = max([20] + [abs(z) for _, x, y in mv for z in (x, y)])
    lim = min(26, lim * 1.12)
    def MX(x): return 30 + (x + lim) / (2 * lim) * (W - 38)
    def MY(y): return (H - 26) - (y + lim) / (2 * lim) * (H - 38)
    mvsvg = [f'<line x1="{MX(-lim):.0f}" y1="{MY(0):.0f}" x2="{MX(lim):.0f}" y2="{MY(0):.0f}" stroke="{LINE}" stroke-width="1"/>',
             f'<line x1="{MX(0):.0f}" y1="{MY(-lim):.0f}" x2="{MX(0):.0f}" y2="{MY(lim):.0f}" stroke="{LINE}" stroke-width="1"/>']
    for i, x, y in mv:
        mvsvg.append(f'<circle cx="{MX(x):.1f}" cy="{MY(y):.1f}" r="2" fill="{PC.get(types[i][0], "#6B7280")}" opacity="0.42"/>')
    for i, t in enumerate(types):
        if t[5] is None or t[6] is None:
            continue
        mvsvg.append(f'<circle cx="{MX(t[6]):.1f}" cy="{MY(t[5]):.1f}" r="5.5" fill="{PC.get(t[0],"#6B7280")}" stroke="#fff" stroke-width="1.6"/>')
    for lab, xx, yy, anc in (("HB &rarr;", MX(lim) - 2, MY(0) - 5, "end"), ("IVB", MX(0) + 5, MY(lim) + 8, "start")):
        mvsvg.append(f'<text x="{xx:.0f}" y="{yy:.0f}" text-anchor="{anc}" font-size="7" fill="{FAINT}">{lab}</text>')

    # ---- panel 2: release point ----
    rp = [(i, s, h) for i, _, _, h, s in dots if h is not None and s is not None]
    rsvg = []
    if rp:
        xs = [p[1] for p in rp]; ys = [p[2] for p in rp]
        x0, x1 = min(xs) - .5, max(xs) + .5
        y0, y1 = min(ys) - .4, max(ys) + .4
        def RX(x): return 30 + (x - x0) / max(.1, x1 - x0) * (W - 40)
        def RY(y): return (H - 26) - (y - y0) / max(.1, y1 - y0) * (H - 42)
        rsvg.append(f'<rect x="30" y="{H-26-(H-42):.0f}" width="{W-40}" height="{H-42}" fill="none" stroke="{LINE}" stroke-width="1"/>')
        for i, s_, h_ in rp:
            rsvg.append(f'<circle cx="{RX(s_):.1f}" cy="{RY(h_):.1f}" r="2" fill="{PC.get(types[i][0],"#6B7280")}" opacity="0.42"/>')
        for i, t in enumerate(types):
            if t[11] is None or t[12] is None:
                continue
            rsvg.append(f'<circle cx="{RX(t[12]):.1f}" cy="{RY(t[11]):.1f}" r="5.5" fill="{PC.get(t[0],"#6B7280")}" stroke="#fff" stroke-width="1.6"/>')
        rsvg.append(f'<text x="{W/2:.0f}" y="{H-8}" text-anchor="middle" font-size="7" fill="{FAINT}">release side (ft)</text>')
        rsvg.append(f'<text x="10" y="{H/2:.0f}" font-size="7" fill="{FAINT}" transform="rotate(-90 10 {H/2:.0f})" text-anchor="middle">release height (ft)</text>')

    # ---- panel 3: pitch mix ----
    mixw = W - 8
    mix = []
    yy = 12
    for t in types[:6]:
        pct = t[2] or 0
        mix.append(f'<rect x="34" y="{yy}" width="{max(2, pct/100*(mixw-70)):.1f}" height="13" rx="3" fill="{PC.get(t[0],"#6B7280")}"/>')
        mix.append(f'<text x="30" y="{yy+10}" text-anchor="end" font-size="8.5" font-weight="700" fill="{INK}">{AB.get(t[0],t[0][:2])}</text>')
        mix.append(f'<text x="{34+max(2,pct/100*(mixw-70))+5:.1f}" y="{yy+10}" font-size="8.5" font-weight="700" fill="{MUT}">{pct}%</text>')
        yy += 20

    rows = "".join(
        f'<tr><td class="pt"><span class="dot" style="background:{PC.get(t[0],"#6B7280")}"></span>{t[0]}</td>'
        f'<td>{t[1]}</td><td>{num(t[2],0,"%")}</td><td class="hi">{num(t[3],1)}</td><td>{num(t[4],1)}</td><td>{num(t[7])}</td>'
        f'<td>{num(t[5],1)}</td><td>{num(t[6],1)}</td>'
        f'<td>{t[8] or "&ndash;"}</td><td>{num(t[10],1)}</td><td>{num(t[9],0,"%")}</td>'
        f'<td>{chip(t[13],"plus")}</td><td>{chip(t[14],"scout")}</td><td>{chip(t[15],"pct","%")}</td></tr>'
        for t in types)

    # ---- velo trend: the development story, which is what a recruiter reads for ----
    trend = ""
    if v and len(v) > 12 and v[10] and len(v[10]) >= 2:
        peaks, dates, labels = v[10], v[12], (v[13] if len(v) > 13 else [])
        pts = [(i, p) for i, p in enumerate(peaks) if p is not None][-12:]
        if len(pts) >= 2:
            TW, TH = 740, 96
            lo = min(p for _, p in pts) - 1.2
            hi = max(p for _, p in pts) + 1.2
            def TX(k): return 34 + k / max(1, len(pts) - 1) * (TW - 70)
            def TY(p): return TH - 24 - (p - lo) / max(.1, hi - lo) * (TH - 40)
            poly = " ".join(f"{TX(k):.1f},{TY(p):.1f}" for k, (_, p) in enumerate(pts))
            g = [f'<line x1="34" y1="{TY(lo+1.2):.0f}" x2="{TW-36}" y2="{TY(lo+1.2):.0f}" stroke="{LINE}" stroke-width="1"/>',
                 f'<polyline points="{poly}" fill="none" stroke="{NAVY}" stroke-width="2" stroke-linejoin="round"/>']
            for k, (i, p) in enumerate(pts):
                sub = (labels[i] if i < len(labels) else "") or ""
                col = "#C98A00" if sub in ("Low Effort", "Rehab") else ("#0E86A8" if sub == "Live AB" else NAVY)
                g.append(f'<circle cx="{TX(k):.1f}" cy="{TY(p):.1f}" r="3.4" fill="{col}" stroke="#fff" stroke-width="1.4"/>')
                if k in (0, len(pts) - 1):
                    g.append(f'<text x="{TX(k):.0f}" y="{TY(p)-9:.0f}" text-anchor="middle" font-size="9" font-weight="800" fill="{INK}">{p}</text>')
                    d = dates[i] if i < len(dates) else ""
                    g.append(f'<text x="{TX(k):.0f}" y="{TH-8}" text-anchor="middle" font-size="7" fill="{FAINT}">{d}</text>')
            trend = (f'<div class="panel" style="margin-top:12px;padding:12px 10px 6px">'
                     f'<div class="ptitle" style="text-align:left;padding-left:14px">PEAK VELOCITY &middot; LAST {len(pts)} SESSIONS</div>'
                     f'<svg viewBox="0 0 {TW} {TH}" style="width:100%;display:block">{"".join(g)}</svg>'
                     f'<div style="display:flex;gap:14px;padding:2px 14px 4px;font-size:8px;color:{FAINT}">'
                     f'<span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:{NAVY};margin-right:4px"></span>bullpen</span>'
                     f'<span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#0E86A8;margin-right:4px"></span>live AB</span>'
                     f'<span><span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#C98A00;margin-right:4px"></span>low intent</span></div></div>')

    stats = [("PITCHES", ath["n"], None), ("SHAPE+", ath["sp"], grade_color(ath["sp"])),
             ("STRIKE+", ath["st"], grade_color(ath["st"])), ("OVERALL", ath["ov"], grade_color(ath["ov"])),
             ("BEST PITCH", AB.get(ath["bp"], ath["bp"] or "&ndash;"), None)]
    statboxes = "".join(
        f'<div class="sb"><div class="sbv" style="color:{c or "#fff"}">{v}</div><div class="sbl">{l}</div></div>'
        for l, v, c in stats)
    peak = f"{v[4]} mph" if v and len(v) > 4 else "&ndash;"
    pens = len(sessions)
    lvl = GROUP.get(ath["lvl"], ath["lvl"])
    last = sessions[0]["df"] if sessions else ""

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{name} - RPM Pitching Report</title><style>
{open(FONT).read()}
*{{margin:0;padding:0;box-sizing:border-box}}@page{{size:letter;margin:0}}
body{{font-family:'DM Sans',sans-serif;color:{INK};background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.page{{width:816px;min-height:1056px;padding:34px 36px;position:relative}}
.hero{{background:{NAVY};border-radius:16px;padding:22px 24px;display:flex;justify-content:space-between;align-items:center;gap:20px}}
.hname{{font-size:34px;font-weight:800;color:#fff;line-height:1.05;letter-spacing:-0.5px}}
.hmeta{{font-size:11px;color:#9FB0CC;margin-top:7px}}
.hpill{{display:inline-block;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:3px 10px;font-size:10px;font-weight:700;color:#DCE6F5;margin-right:6px}}
.sbwrap{{display:flex;gap:7px;flex-shrink:0}}
.sb{{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:9px 12px;text-align:center;min-width:64px}}
.sbv{{font-size:19px;font-weight:800;color:#fff;line-height:1}}
.sbl{{font-size:7.5px;font-weight:700;letter-spacing:.9px;color:#8FA3C2;margin-top:5px}}
.panels{{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:14px}}
.panel{{background:{PANEL};border:1px solid {LINE};border-radius:14px;padding:12px 10px 8px}}
.ptitle{{font-size:8.5px;font-weight:800;letter-spacing:1.1px;color:{MUT};text-align:center;margin-bottom:4px}}
table{{width:100%;border-collapse:collapse;margin-top:14px}}
th{{font-size:7.5px;font-weight:800;letter-spacing:.7px;color:{MUT};text-align:right;padding:0 5px 7px;border-bottom:2px solid {NAVY}}}
th:first-child{{text-align:left}}
td{{font-size:11px;font-weight:600;text-align:right;padding:8px 5px;border-bottom:1px solid {LINE};color:{INK}}}
td.pt{{text-align:left;font-weight:800}}
td.hi{{font-weight:800}}
.dot{{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}}
.chip{{display:inline-block;min-width:34px;padding:3px 7px;border-radius:6px;border:1px solid;font-size:11px;font-weight:800}}
.chip-na{{color:{FAINT};background:#F1F3F5;border-color:{LINE}}}
.foot{{position:absolute;left:36px;right:36px;bottom:26px;background:{NAVY};border-radius:12px;padding:11px 16px;display:flex;justify-content:space-between;align-items:center}}
.fl{{font-size:9px;color:#9FB0CC;line-height:1.5}}
.fr{{font-size:9px;color:#7E93B4;text-align:right}}
</style></head><body><div class="page">
  <div class="hero">
    <div>
      <div class="hname">{name}</div>
      <div style="margin-top:9px">
        <span class="hpill">{lvl}</span><span class="hpill">{pens} tracked pen{"" if pens==1 else "s"}</span><span class="hpill">peak {peak}</span>
      </div>
      <div class="hmeta">Arsenal grade from {ath['n']} tagged pitches &nbsp;·&nbsp; latest pen {last}</div>
    </div>
    <div class="sbwrap">{statboxes}</div>
  </div>
  <div class="panels">
    <div class="panel"><div class="ptitle">RELEASE POINT</div>
      <svg viewBox="0 0 {W} {H}" style="width:100%;display:block">{''.join(rsvg)}</svg></div>
    <div class="panel"><div class="ptitle">MOVEMENT PROFILE</div>
      <svg viewBox="0 0 {W} {H}" style="width:100%;display:block">{''.join(mvsvg)}</svg></div>
    <div class="panel"><div class="ptitle">PITCH MIX</div>
      <svg viewBox="0 0 {W} {H}" style="width:100%;display:block">{''.join(mix)}</svg></div>
  </div>
  <table>
    <tr><th>PITCH</th><th>#</th><th>USE</th><th>VELO</th><th>MAX</th><th>SPIN</th><th>IVB</th><th>HB</th><th>TILT</th><th>EXT</th><th>EFF</th><th>SHAPE+</th><th>GRADE</th><th>ZONE%</th></tr>
    {rows}
  </table>
  {trend}
  <div class="foot">
    <div class="fl"><b style="color:#DCE6F5">Shape+, Strike+ and Overall: 100 = the RPM {lvl} average.</b> 10 points = one standard deviation, so 120 is roughly the top 2% of that group.<br>Velo, spin and movement are session averages; MAX is the hardest pitch of that type. Grades update with every tracked bullpen.</div>
    <div class="fr">RPM Strength &middot; Queens, NY<br>Generated {updated}</div>
  </div>
</div></body></html>"""

    os.makedirs(a.out, exist_ok=True)
    oh = os.path.join(a.out, f"{name} - RPM Pitching Report.html")
    op = os.path.join(a.out, f"{name} - RPM Pitching Report.pdf")
    open(oh, "w").write(html)
    if os.path.exists(CHROME):
        subprocess.run([CHROME, "--headless", "--disable-gpu", f"--print-to-pdf={op}",
                        "--no-pdf-header-footer", oh], check=True, capture_output=True)
    print(json.dumps({"name": name, "level": lvl, "types": len(types), "dots": len(dots),
                      "shape": ath["sp"], "strike": ath["st"], "overall": ath["ov"], "pdf": op}, indent=1))


if __name__ == "__main__":
    main()
