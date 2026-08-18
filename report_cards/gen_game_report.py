#!/usr/bin/env python3
"""RPM game report card — one-pager from a raw TrackMan GAME csv.

    python3 report_cards/gen_game_report.py <csv> "Athlete Name" \
        --event "Leiderman Cup · Jack Kaiser Stadium" --date "August 14, 2026"

Built for outings that happen OUTSIDE the facility pipeline (showcase games,
tournaments): the athlete may not be on any RPM board, the file is per-pitch
TrackMan v3 game output, and the operator's game-state fields are often frozen
(same batter/count/outs on every row), so the card is strictly STUFF +
LOCATION — no outcomes, no counts, no Shape+ (no honest pool to centre a game
guest against).

Attribution caveat that motivated this script: these private-event files can
carry a stale Pitcher name on every row (the operator never re-tagged). The
NAME ON THE CARD IS THE CALLER'S CLAIM, passed on the command line — this
script prints the csv's own Pitcher field to stderr so the mismatch is seen,
and refuses nothing. Frank owns the identification.

Same visual system as gen_pitching_report.py (navy hero, three panels, table).
This lives in the repo ON PURPOSE — scratchpad tools get lost.
"""
import argparse
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

NAVY, INK, MUT, FAINT = "#16233C", "#1B2A44", "#5B6470", "#98A0AA"
LINE, PANEL = "#E3E6EA", "#F7F8FA"
PC = {"Four-Seam": "#D93A3A", "Fastball": "#D93A3A", "Sinker": "#E0701B",
      "Two-Seam": "#E0701B", "Cutter": "#0E86A8", "Slider": "#8B4FD0",
      "Sweeper": "#C98A00", "Curveball": "#2F6FD0", "Changeup": "#12A06A",
      "Splitter": "#C93E86", "Other": "#6B7280"}
AB = {"Four-Seam": "FB", "Fastball": "FB", "Sinker": "SI", "Two-Seam": "2S",
      "Cutter": "CT", "Slider": "SL", "Sweeper": "SW", "Curveball": "CB",
      "Changeup": "CH", "Splitter": "SP", "Other": "OT"}
ZX, ZLO, ZHI = 0.83, 1.5, 3.5   # house zone (matches extract_arsenal.py)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("athlete")
    ap.add_argument("--event", default="Game outing")
    ap.add_argument("--date", default="")
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop"))
    ap.add_argument("--typenote", default="pitch types are TrackMan auto-classification",
                    help="footer wording for how types were assigned")
    a = ap.parse_args()

    df = pd.read_csv(a.csv)
    who = sorted(df.Pitcher.dropna().unique())
    print(f"[gen_game_report] csv Pitcher field says: {who} — card prints "
          f"'{a.athlete}' on the caller's identification", file=sys.stderr)
    hand = (df.PitcherThrows.dropna().iloc[0]
            if df.PitcherThrows.notna().any() else "")

    df = df.dropna(subset=["RelSpeed"])
    types = (df.groupby("AutoPitchType")
             .agg(n=("RelSpeed", "size"), vavg=("RelSpeed", "mean"),
                  vmax=("RelSpeed", "max"), spin=("SpinRate", "mean"),
                  ivb=("InducedVertBreak", "mean"), hb=("HorzBreak", "mean"),
                  relh=("RelHeight", "mean"), rels=("RelSide", "mean"),
                  ext=("Extension", "mean"), vaa=("VertApprAngle", "mean"))
             .sort_values("n", ascending=False).reset_index())
    total = int(types.n.sum())
    inz = df[(df.PlateLocSide.abs() <= ZX) & df.PlateLocHeight.between(ZLO, ZHI)]
    zone_pct = round(len(inz) / len(df) * 100)
    fb = types.iloc[0]

    logo = re.search(r'const RPM_LOGO_DARK = "(data:image/png;base64,[^"]+)"',
                     open(APP).read()).group(1)

    # ---- panels ----
    W = H = 200

    def panel_mv():
        lim = 26
        def X(v): return 30 + (v + lim) / (2 * lim) * (W - 38)
        def Y(v): return (H - 26) - (v + lim) / (2 * lim) * (H - 38)
        s = [f'<line x1="{X(-lim):.0f}" y1="{Y(0):.0f}" x2="{X(lim):.0f}" y2="{Y(0):.0f}" stroke="{LINE}"/>',
             f'<line x1="{X(0):.0f}" y1="{Y(-lim):.0f}" x2="{X(0):.0f}" y2="{Y(lim):.0f}" stroke="{LINE}"/>']
        for _, r in df.iterrows():
            c = PC.get(r.AutoPitchType, "#6B7280")
            if pd.notna(r.InducedVertBreak) and pd.notna(r.HorzBreak):
                s.append(f'<circle cx="{X(r.HorzBreak):.1f}" cy="{Y(r.InducedVertBreak):.1f}" r="3" fill="{c}" opacity="0.45"/>')
        for _, t in types.iterrows():
            c = PC.get(t.AutoPitchType, "#6B7280")
            s.append(f'<circle cx="{X(t.hb):.1f}" cy="{Y(t.ivb):.1f}" r="6" fill="{c}" stroke="#fff" stroke-width="1.6"/>')
        s.append(f'<text x="{X(lim)-2:.0f}" y="{Y(0)-5:.0f}" text-anchor="end" font-size="7" fill="{FAINT}">HB &rarr;</text>')
        s.append(f'<text x="{X(0)+5:.0f}" y="{Y(lim)+8:.0f}" font-size="7" fill="{FAINT}">IVB</text>')
        return "".join(s)

    def panel_loc():
        def X(v): return 30 + (v + 2.2) / 4.4 * (W - 38)
        def Y(v): return (H - 18) - (v - 0.4) / 4.4 * (H - 30)
        s = [f'<rect x="{X(-ZX):.1f}" y="{Y(ZHI):.1f}" width="{X(ZX)-X(-ZX):.1f}" height="{Y(ZLO)-Y(ZHI):.1f}" fill="none" stroke="{MUT}" stroke-width="1.2"/>']
        for _, r in df.iterrows():
            if pd.notna(r.PlateLocSide) and pd.notna(r.PlateLocHeight):
                c = PC.get(r.AutoPitchType, "#6B7280")
                s.append(f'<circle cx="{X(r.PlateLocSide):.1f}" cy="{Y(r.PlateLocHeight):.1f}" r="4" fill="{c}" opacity="0.8" stroke="#fff" stroke-width="0.7"/>')
        s.append(f'<text x="{W/2:.0f}" y="{H-4}" text-anchor="middle" font-size="7" fill="{FAINT}">catcher&rsquo;s view</text>')
        return "".join(s)

    def panel_rel():
        def X(v): return 30 + (v + 4) / 8 * (W - 38)
        def Y(v): return (H - 22) - v / 7.5 * (H - 34)
        s = [f'<line x1="{X(-4):.0f}" y1="{Y(0):.0f}" x2="{X(4):.0f}" y2="{Y(0):.0f}" stroke="{LINE}"/>']
        for _, r in df.iterrows():
            if pd.notna(r.RelSide) and pd.notna(r.RelHeight):
                c = PC.get(r.AutoPitchType, "#6B7280")
                s.append(f'<circle cx="{X(r.RelSide):.1f}" cy="{Y(r.RelHeight):.1f}" r="3" fill="{c}" opacity="0.5"/>')
        s.append(f'<text x="{W/2:.0f}" y="{H-8}" text-anchor="middle" font-size="7" fill="{FAINT}">release side (ft)</text>')
        return "".join(s)

    rows = ""
    for _, t in types.iterrows():
        c = PC.get(t.AutoPitchType, "#6B7280")
        rows += f"""<tr>
          <td><span class="sw" style="background:{c}"></span><b>{t.AutoPitchType}</b></td>
          <td>{int(t.n)}</td><td><b>{t.vavg:.1f}</b></td><td>{t.vmax:.1f}</td>
          <td>{t.spin:.0f}</td><td>{t.ivb:+.1f}</td><td>{t.hb:+.1f}</td>
          <td>{t.vaa:.1f}&deg;</td><td>{t.ext:.1f}</td><td>{t.relh:.1f} / {t.rels:.1f}</td>
        </tr>"""

    font_css = open(FONT).read() if os.path.exists(FONT) else ""
    html = f"""<!doctype html><meta charset="utf-8"><style>{font_css}
    * {{ margin:0; box-sizing:border-box; font-family:'DM Sans',-apple-system,sans-serif; }}
    body {{ width:8.5in; height:11in; padding:0.42in 0.46in; color:{INK}; background:#fff; }}
    .hero {{ background:{NAVY}; border-radius:14px; padding:22px 26px; color:#fff;
             display:flex; align-items:center; gap:22px; }}
    .hero img {{ height:44px; }}
    .hname {{ font-size:27px; font-weight:800; letter-spacing:-0.4px; }}
    .hsub {{ font-size:11px; color:#AEB8CC; margin-top:3px; }}
    .hstats {{ margin-left:auto; display:flex; gap:26px; text-align:center; }}
    .hstat b {{ display:block; font-size:23px; }}
    .hstat span {{ font-size:8.5px; color:#AEB8CC; letter-spacing:0.8px; }}
    .panels {{ display:flex; gap:14px; margin:16px 0; }}
    .panel {{ flex:1; background:{PANEL}; border:1px solid {LINE}; border-radius:11px; padding:10px 8px 4px; }}
    .ptitle {{ font-size:10px; font-weight:700; color:{MUT}; text-transform:uppercase;
               letter-spacing:0.8px; padding-left:6px; }}
    table {{ width:100%; border-collapse:collapse; font-size:11px; }}
    th {{ font-size:8.5px; color:{MUT}; text-transform:uppercase; letter-spacing:0.6px;
          text-align:left; padding:7px 8px; border-bottom:1.5px solid {LINE}; }}
    td {{ padding:8px; border-bottom:1px solid {LINE}; }}
    .sw {{ display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:7px; vertical-align:-1px; }}
    .foot {{ margin-top:14px; font-size:8.5px; color:{FAINT}; line-height:1.6; }}
    </style>
    <div class="hero">
      <img src="{logo}">
      <div><div class="hname">{a.athlete}</div>
        <div class="hsub">{'RHP' if hand=='Right' else 'LHP' if hand=='Left' else ''} &middot; {a.event}{(' &middot; ' + a.date) if a.date else ''}</div></div>
      <div class="hstats">
        <div class="hstat"><b>{total}</b><span>PITCHES</span></div>
        <div class="hstat"><b>{fb.vavg:.1f}</b><span>{AB.get(fb.AutoPitchType, 'FB')} AVG MPH</span></div>
        <div class="hstat"><b>{fb.vmax:.1f}</b><span>{AB.get(fb.AutoPitchType, 'FB')} MAX</span></div>
        <div class="hstat"><b>{zone_pct}%</b><span>IN ZONE</span></div>
      </div>
    </div>
    <div class="panels">
      <div class="panel"><div class="ptitle">Release point</div>
        <svg viewBox="0 0 {W} {H}" width="100%">{panel_rel()}</svg></div>
      <div class="panel"><div class="ptitle">Movement profile</div>
        <svg viewBox="0 0 {W} {H}" width="100%">{panel_mv()}</svg></div>
      <div class="panel"><div class="ptitle">Pitch locations</div>
        <svg viewBox="0 0 {W} {H}" width="100%">{panel_loc()}</svg></div>
    </div>
    <table><tr><th>Pitch</th><th>#</th><th>Avg</th><th>Max</th><th>Spin</th>
      <th>IVB</th><th>HB</th><th>VAA</th><th>Ext</th><th>Rel H/S</th></tr>{rows}</table>
    <div class="foot">Per-pitch TrackMan (v3) game data &middot; {a.typenote}
      &middot; zone = RPM house definition (&plusmn;0.83 ft, 1.5&ndash;3.5 ft) &middot; movement in inches,
      release/extension in feet &middot; RPM Strength &middot; rpmstrength.coach</div>"""

    safe = a.athlete.replace(" ", "")
    hpath = os.path.join(tempfile.mkdtemp(prefix="rpmcard-"), f"{safe}_game.html")
    pdf = os.path.join(a.out, f"RPM Game Report - {a.athlete} - {a.date or 'game'}.pdf")
    open(hpath, "w").write(html)
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    f"--print-to-pdf={pdf}", "--no-pdf-header-footer",
                    hpath], check=True, capture_output=True)
    os.remove(hpath)
    print(pdf)


if __name__ == "__main__":
    main()
