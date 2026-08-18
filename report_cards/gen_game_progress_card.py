#!/usr/bin/env python3
"""RPM game card in the PROGRESS-REPORT page-2 format (light, red accents).

    python3 report_cards/gen_game_progress_card.py <csv> "Name" \
        --event "Leiderman Cup" --venue "Jack Kaiser Stadium" \
        --date "August 14, 2026" --lvl col

Rebuilt by eye from 'Ben Wallace Progress Report.pdf' page 2 (the original
generator predates the repo's report_cards/ and was lost to a scratchpad):
red small-caps kicker, black name, outlined stat boxes, red->green percentile
gradient with marker, red section header, per-type table, movement
(pitcher's view) + release panels with mound silhouette, sessions list,
centered footer line.

Game-csv adaptations, kept honest:
  - EFF (spin efficiency) is not in TrackMan v3 game csvs -> column is ZONE%.
  - 'Recent Velo Sessions' lists the game outing(s) in THIS csv - a guest arm
    has no RPM session history.
  - Percentile = peak FB among all active RPM pitchers (portal _VELO,
    peakEver), same population the original card used.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
APP = os.path.join(REPO, "src", "App.jsx")
FONT = os.path.join(HERE, "dmsans_embed.css")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

INK, MUT, FAINT, LINE = "#141821", "#5B6470", "#98A0AA", "#E6E8EC"
RED = "#C62828"
PC = {"Fastball": "#E05252", "Sinker": "#E0701B", "Cutter": "#29B6C8",
      "Slider": "#8B5CF6", "Sweeper": "#C98A00", "Curveball": "#6D9EEB",
      "Changeup": "#26A69A", "Splitter": "#E060A8"}
AB = {"Fastball": "FB", "Sinker": "SI", "Cutter": "CT", "Slider": "SL",
      "Sweeper": "SW", "Curveball": "CB", "Changeup": "CH", "Splitter": "SP"}
ZX, ZLO, ZHI = 0.83, 1.5, 3.5


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("athlete")
    ap.add_argument("--event", default="Game outing")
    ap.add_argument("--venue", default="")
    ap.add_argument("--date", default="")
    ap.add_argument("--lvl", default="col")
    ap.add_argument("--out", default=os.path.expanduser("~/Downloads"))
    a = ap.parse_args()

    src = open(APP).read()
    logo = re.search(r'const RPM_LOGO = "(data:image/[^"]+)"', src).group(1)
    VELO = json.loads(re.search(r"const _VELO = (\[.*?\]);\n", src, re.S).group(1))
    LVL = {"hs": "High School", "col": "College", "ms": "Middle School",
           "pro": "Pro"}.get(a.lvl, a.lvl)

    df = pd.read_csv(a.csv).dropna(subset=["RelSpeed"])
    hand = df.PitcherThrows.dropna().iloc[0] if df.PitcherThrows.notna().any() else ""
    tmap = {"Four-Seam": "Fastball", "Two-Seam": "Sinker", "ChangeUp": "Changeup"}
    df["pt"] = df.AutoPitchType.map(lambda t: tmap.get(t, t))
    agg = (df.groupby("pt")
           .agg(n=("RelSpeed", "size"), avg=("RelSpeed", "mean"),
                mx=("RelSpeed", "max"), spin=("SpinRate", "mean"),
                ivb=("InducedVertBreak", "mean"), hb=("HorzBreak", "mean"),
                relh=("RelHeight", "mean"), rels=("RelSide", "mean"))
           .sort_values("n", ascending=False).reset_index())
    total = int(agg.n.sum())
    fbfam = agg[agg.pt.isin(("Fastball", "Sinker"))]
    prim = fbfam.iloc[0] if len(fbfam) else agg.iloc[0]
    peak, fbavg = prim.mx, prim.avg

    peaks = [r[4] for r in VELO if r[4]]
    pct = round(sum(1 for x in peaks if x < peak) / len(peaks) * 100)
    ordsuf = "th" if 10 <= pct % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(pct % 10, "th")

    def zone(sub):
        z = sub[(sub.PlateLocSide.abs() <= ZX) & sub.PlateLocHeight.between(ZLO, ZHI)]
        return round(len(z) / len(sub) * 100) if len(sub) else 0

    rows = ""
    for _, t in agg.iterrows():
        c = PC.get(t.pt, "#6B7280")
        rows += (f'<tr><td class="pt"><span class="dot" style="background:{c}"></span>{t.pt}</td>'
                 f'<td>{int(t.n)}</td><td>{round(t.n/total*100)}%</td>'
                 f'<td>{t.avg:.1f}</td><td class="hi">{t.mx:.1f}</td>'
                 f'<td>{t.ivb:.1f}</td><td>{t.hb:.1f}</td><td>{t.spin:.0f}</td>'
                 f'<td>{zone(df[df.pt==t.pt])}%</td></tr>')

    # ---- movement panel, PITCHER'S view (HB mirrored vs catcher) ----
    W, H = 300, 250
    lim = 25
    def MX(x): return 36 + (x + lim) / (2 * lim) * (W - 48)   # raw TrackMan HB, matching the original card
    def MY(y): return (H - 26) - (y + lim) / (2 * lim) * (H - 40)
    mv = [f'<line x1="{MX(-lim):.0f}" y1="{MY(0):.0f}" x2="{MX(lim):.0f}" y2="{MY(0):.0f}" stroke="{LINE}"/>',
          f'<line x1="{MX(0):.0f}" y1="{MY(-lim):.0f}" x2="{MX(0):.0f}" y2="{MY(lim):.0f}" stroke="{LINE}"/>']
    for v in (-20, -10, 10, 20):
        mv.append(f'<text x="{MX(v):.0f}" y="{MY(0)+11:.0f}" text-anchor="middle" font-size="7" fill="{FAINT}">{v}</text>')
        mv.append(f'<text x="{MX(0)-5:.0f}" y="{MY(v)+2:.0f}" text-anchor="end" font-size="7" fill="{FAINT}">{v}</text>')
    for _, r in df.iterrows():
        if pd.notna(r.InducedVertBreak) and pd.notna(r.HorzBreak):
            mv.append(f'<circle cx="{MX(r.HorzBreak):.1f}" cy="{MY(r.InducedVertBreak):.1f}" r="4" fill="{PC.get(r.pt,"#6B7280")}" opacity="0.35"/>')
    for _, t in agg.iterrows():
        mv.append(f'<circle cx="{MX(t.hb):.1f}" cy="{MY(t.ivb):.1f}" r="6.5" fill="{PC.get(t.pt,"#6B7280")}"/>')

    # ---- release panel with mound silhouette ----
    RW, RH = 300, 250
    def RX(x): return RW / 2 + x / 4.0 * (RW / 2 - 30)       # raw RelSide, matching the original card
    def RY(y): return (RH - 44) - y / 7.0 * (RH - 74)
    rel = []
    for ft in (2, 4, 6):
        rel.append(f'<line x1="26" y1="{RY(ft):.0f}" x2="{RW-20}" y2="{RY(ft):.0f}" stroke="{LINE}" stroke-dasharray="3,3"/>')
        rel.append(f'<text x="22" y="{RY(ft)+3:.0f}" text-anchor="end" font-size="7.5" fill="{FAINT}">{ft}ft</text>')
    rel.append(f'<path d="M {RW/2-90:.0f} {RY(0)+14:.0f} Q {RW/2:.0f} {RY(0)-8:.0f} {RW/2+90:.0f} {RY(0)+14:.0f} Z" fill="#E9EBEE"/>')
    rel.append(f'<rect x="{RW/2-13:.0f}" y="{RY(0)-2:.0f}" width="26" height="4" rx="1.5" fill="#8A8F98"/>')
    for v in (-2, 2):
        rel.append(f'<text x="{RX(v):.0f}" y="{RY(0)+24:.0f}" text-anchor="middle" font-size="7" fill="{FAINT}">{v}</text>')
    for _, r in df.iterrows():
        if pd.notna(r.RelSide) and pd.notna(r.RelHeight):
            rel.append(f'<circle cx="{RX(r.RelSide):.1f}" cy="{RY(r.RelHeight):.1f}" r="4.5" fill="{PC.get(r.pt,"#6B7280")}" opacity="0.55"/>')
    legend = "".join(
        f'<tspan fill="{PC.get(t.pt,"#6B7280")}">&#9679;</tspan> <tspan fill="{MUT}">{AB.get(t.pt,t.pt[:2])}</tspan>&#160;&#160;'
        for _, t in agg.iterrows())
    rel.append(f'<text x="{RW/2:.0f}" y="{RH-6}" text-anchor="middle" font-size="8">{legend}</text>')

    # ---- sessions list: the outings in THIS csv ----
    sess_rows = (f'<div class="srow"><span class="sd">{a.date}</span>'
                 f'<span class="st">{a.event}{" (live game)" if "Cup" in a.event or "game" in a.event.lower() else ""}</span>'
                 f'<span class="sv"><b>{peak:.1f} mph</b> <em>avg {fbavg:.1f}</em></span></div>')

    gen = pd.Timestamp.now().strftime("%B %-d, %Y")
    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{a.athlete} - RPM Pitching Report</title><style>
{open(FONT).read() if os.path.exists(FONT) else ""}
*{{margin:0;padding:0;box-sizing:border-box}}@page{{size:letter;margin:0}}
body{{font-family:'DM Sans',sans-serif;color:{INK};background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.page{{width:816px;min-height:1056px;padding:44px 56px 30px;position:relative}}
.kick{{font-size:9px;font-weight:800;letter-spacing:1.6px;color:{RED}}}
.hname{{font-size:30px;font-weight:800;letter-spacing:-0.4px;margin-top:2px}}
.hsub{{font-size:11px;color:{MUT};margin-top:3px}}
.hdr{{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid {INK};padding-bottom:12px}}
.hdr img{{height:46px;margin-top:4px}}
.stats{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}}
.stat{{border:1px solid {LINE};border-radius:10px;padding:11px 10px;text-align:center}}
.sv1{{font-size:16px;font-weight:800}}
.sl1{{font-size:7.5px;font-weight:700;letter-spacing:1px;color:{FAINT};margin-top:4px}}
.bar{{height:7px;border-radius:4px;margin-top:14px;position:relative;background:linear-gradient(90deg,#C0392B,#E0701B,#D6B31C,#7CB342,#1B7F4B)}}
.mark{{position:absolute;top:-4px;width:3px;height:15px;background:{INK};border-radius:2px}}
.bscale{{display:flex;justify-content:space-between;font-size:7px;color:{FAINT};margin-top:3px}}
.bcap{{font-size:8.5px;color:{FAINT};margin-top:4px}}
.sec{{font-size:12.5px;font-weight:800;color:{RED};margin:22px 0 8px}}
table{{width:100%;border-collapse:collapse}}
th{{font-size:7.5px;font-weight:800;letter-spacing:.8px;color:{MUT};text-align:right;padding:6px 6px;border-bottom:1.5px solid {INK}}}
th:first-child{{text-align:left}}
td{{font-size:11px;font-weight:600;text-align:right;padding:7px 6px;border-bottom:1px solid {LINE}}}
td.pt{{text-align:left;font-weight:700}}
td.hi{{font-weight:800}}
.dot{{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;vertical-align:middle}}
.panels{{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:18px}}
.ptitle{{font-size:10.5px;font-weight:800;margin-bottom:2px}}
.ptitle em{{font-weight:500;font-style:normal;color:{FAINT};font-size:9px}}
.srow{{display:flex;align-items:baseline;gap:14px;padding:8px 2px;border-bottom:1px solid {LINE};font-size:10.5px}}
.sd{{color:{MUT};min-width:70px}}
.st{{flex:1;color:{INK}}}
.sv{{text-align:right}}
.sv em{{font-style:normal;color:{FAINT};font-size:9px;margin-left:6px}}
.foot{{position:absolute;left:56px;right:56px;bottom:22px;text-align:center;font-size:8px;color:{FAINT};border-top:1px solid {LINE};padding-top:9px}}
</style></head><body><div class="page">
  <div class="hdr">
    <div>
      <div class="kick">PITCHING REPORT &middot; TRACKMAN &middot; GAME</div>
      <div class="hname">{a.athlete}</div>
      <div class="hsub">{LVL}{' &middot; ' + ('RHP' if hand == 'Right' else 'LHP') if hand else ''} &middot; {a.event}{(' &middot; ' + a.venue) if a.venue else ''} &middot; {a.date}</div>
    </div>
    <img src="{logo}">
  </div>
  <div class="stats">
    <div class="stat"><div class="sv1">{peak:.1f} mph</div><div class="sl1">PEAK FB</div></div>
    <div class="stat"><div class="sv1">{fbavg:.1f} mph</div><div class="sl1">AVG FB</div></div>
    <div class="stat"><div class="sv1">{total}</div><div class="sl1">PITCHES</div></div>
    <div class="stat"><div class="sv1" style="color:#1B7F4B">{pct}{ordsuf}</div><div class="sl1">PERCENTILE</div></div>
  </div>
  <div class="bar"><div class="mark" style="left:calc({pct}% - 1px)"></div></div>
  <div class="bscale"><span>0</span><span>25th</span><span>50th</span><span>75th</span><span>99th</span></div>
  <div class="bcap">Peak fastball percentile among {len(peaks)} active RPM pitchers.</div>
  <div class="sec">{a.event} &middot; {a.date} &middot; Live game &middot; {total} pitches</div>
  <table>
    <tr><th>PITCH</th><th>#</th><th>USE</th><th>AVG</th><th>MAX</th><th>IVB</th><th>HB</th><th>SPIN</th><th>ZONE%</th></tr>
    {rows}
  </table>
  <div class="panels">
    <div><div class="ptitle">Pitch Movement <em>(pitcher&rsquo;s view)</em></div>
      <svg viewBox="0 0 {W} {H}" style="width:100%;display:block">{''.join(mv)}</svg></div>
    <div><div class="ptitle">Release Point</div>
      <svg viewBox="0 0 {RW} {RH}" style="width:100%;display:block">{''.join(rel)}</svg></div>
  </div>
  <div class="sec">Game Outings</div>
  {sess_rows}
  <div class="foot">RPM Strength &middot; Queens, NY&nbsp; | &nbsp;Data: TrackMan (game)&nbsp; | &nbsp;Generated {gen}&nbsp; | &nbsp;rpmstrength.coach<br>
  Pitch types consolidated to the athlete&rsquo;s repertoire; outing isolated from the event file by velocity band and release-point clustering. Zone = RPM house definition.</div>
</div></body></html>"""

    hpath = os.path.join(tempfile.mkdtemp(prefix="rpmcard-"), "card.html")
    pdf = os.path.join(a.out, f"RPM Pitching Report - {a.athlete} - {a.date or 'game'}.pdf")
    open(hpath, "w").write(html)
    subprocess.run([CHROME, "--headless", "--disable-gpu", f"--print-to-pdf={pdf}",
                    "--no-pdf-header-footer", hpath], check=True, capture_output=True)
    print(pdf)


if __name__ == "__main__":
    main()
