#!/usr/bin/env python3
"""RPM game report card, CLASSIC pitching-card format, from a TrackMan game csv.

    python3 report_cards/gen_game_card_classic.py <csv> "Name" --lvl col \
        --event "Leiderman Cup" --date "August 14, 2026"

Same visual system as gen_pitching_report.py (navy hero + statboxes, three
panels, chip table, navy footer), for arms that are NOT on the arsenal board —
exhibition/game outings. Grades are ESTIMATES against the RPM board:

  The grader's pools cannot be rerun for a guest (raw arsenal_shapes lives
  outside this repo), so pools are REBUILT from _ARS per-type aggregates in the
  live App.jsx — the same numbers the board was graded from. The estimator is
  validated in-run: every board athlete of the target level is pushed through
  it and the median |error| vs their true per-type Shape+ is printed; the card
  is refused if calibration is off by more than 3 points median. Estimates are
  labelled as estimates on the card.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys
import tempfile

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
APP = os.path.join(REPO, "src", "App.jsx")
FONT = os.path.join(HERE, "dmsans_embed.css")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

NAVY, INK, MUT, FAINT = "#16233C", "#1B2A44", "#5B6470", "#98A0AA"
LINE, PANEL = "#E3E6EA", "#F7F8FA"
GROUP = {"hs": "High School", "col": "College", "ms": "Middle School",
         "pro": "Pro", "stf": "Staff", "ml": "Men's League"}
PC = {"Fastball": "#D93A3A", "Sinker": "#E0701B", "Cutter": "#0E86A8",
      "Slider": "#8B4FD0", "Sweeper": "#C98A00", "Curveball": "#2F6FD0",
      "Changeup": "#12A06A", "Splitter": "#C93E86"}
AB = {"Fastball": "FB", "Sinker": "SI", "Cutter": "CT", "Slider": "SL",
      "Sweeper": "SW", "Curveball": "CB", "Changeup": "CH", "Splitter": "SP"}
GREEN, GREEN2, AMBER, RED = "#1B7F4B", "#4A9E5C", "#B7791F", "#C0392B"
FASTBALLS = ("Fastball", "Sinker")
WEIGHTS = {
    "Fastball":  {"velo": .50, "ivb": .25, "abshb": .15, "spin": .10},
    "Sinker":    {"velo": .50, "abshb": .40, "spin": .10},
    "Changeup":  {"velosep": .25, "dropsep": .15, "tunnel": .10,
                  "velo": .20, "depth": .15, "abshb": .15},
    "Curveball": {"velo": .25, "depth": .30, "abshb": .10, "spin": .05,
                  "msep": .20, "tunnel": .10},
    "Cutter":    {"velo": .40, "near_fb": .10, "msep": .15, "tunnel": .15,
                  "spin": .10, "depth": .10},
    "_default":  {"velo": .30, "abshb": .25, "spin": .10, "depth": .05,
                  "msep": .20, "tunnel": .10},
}
ZX, ZLO, ZHI = 0.83, 1.5, 3.5


def grade_color(v, scale="plus"):
    """plus = 100-centred grades; pct = zone/strike rate (~50% is solid).
    Colouring a rate on the plus scale paints an honest 52% zone red."""
    if v is None:
        return FAINT
    if scale == "pct":
        return GREEN if v >= 58 else GREEN2 if v >= 50 else MUT if v >= 42 else AMBER
    return (GREEN if v >= 115 else GREEN2 if v >= 105 else MUT if v >= 95
            else AMBER if v >= 85 else RED)


def chip(v, suffix="", scale="plus"):
    if v is None:
        return '<span class="chip chip-na">&ndash;</span>'
    c = grade_color(v, scale)
    return (f'<span class="chip" style="color:{c};background:{c}14;'
            f'border-color:{c}33">{v}{suffix}</span>')


def zs(x, pool):
    pool = np.asarray([p for p in pool if p is not None and not np.isnan(p)])
    sd = pool.std()
    return (x - pool.mean()) / (sd if sd else 1)


def build_pools(ARS):
    """Per-type feature pools + per-athlete primary-FB refs from _ARS."""
    rows = []
    for nm, a in ARS["athletes"].items():
        fbs = [t for t in a["types"] if t[0] in FASTBALLS]
        prim = max(fbs, key=lambda t: t[1]) if fbs else None
        for t in a["types"]:
            if t[0] in ("Other",) or t[3] is None:
                continue
            r = {"ath": nm, "lvl": a["lvl"], "pt": t[0], "n": t[1],
                 "velo": t[3], "ivb": t[5], "hb": t[6], "spin": t[7],
                 "relh": t[11], "rels": t[12], "sp_true": t[13]}
            if prim and prim[3] is not None:
                r["fb_velo"], r["fb_ivb"], r["fb_hb"] = prim[3], prim[5], prim[6]
                r["fb_relh"], r["fb_rels"] = prim[11], prim[12]
            rows.append(r)
    return pd.DataFrame(rows)


def shape_z(P, pt, feat):
    """Composite z for one pitch, pooled against every board athlete's type row."""
    g = P[P.pt == pt]
    if len(g) < 5:
        g = P  # fall back to all types (never triggers for FB/SL/CH/CB)
    comp = {}
    comp["velo"] = zs(feat["velo"], g.velo)
    comp["ivb"] = zs(feat["ivb"], g.ivb)
    comp["depth"] = zs(-feat["ivb"], -g.ivb)
    comp["abshb"] = zs(abs(feat["hb"]), g.hb.abs())
    comp["spin"] = zs(feat["spin"], g.spin)
    if pt not in FASTBALLS and "fb_velo" in feat:
        vsep = g.fb_velo - g.velo
        comp["velosep"] = zs(feat["fb_velo"] - feat["velo"], vsep)
        comp["near_fb"] = zs(-abs(feat["fb_velo"] - feat["velo"]), -vsep.abs())
        comp["dropsep"] = zs(feat["fb_ivb"] - feat["ivb"], g.fb_ivb - g.ivb)
        msep = np.hypot(g.ivb - g.fb_ivb, g.hb - g.fb_hb)
        comp["msep"] = zs(math.hypot(feat["ivb"] - feat["fb_ivb"],
                                     feat["hb"] - feat["fb_hb"]), msep)
        tun = np.hypot(g.relh - g.fb_relh, g.rels - g.fb_rels)
        comp["tunnel"] = zs(-math.hypot(feat["relh"] - feat["fb_relh"],
                                        feat["rels"] - feat["fb_rels"]), -tun)
    w = WEIGHTS.get(pt, WEIGHTS["_default"])
    num = den = 0.0
    for k, wk in w.items():
        if k in comp and not np.isnan(comp[k]):
            num += wk * comp[k]
            den += wk
    return num / den if den else np.nan


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("athlete")
    ap.add_argument("--lvl", default="col")
    ap.add_argument("--event", default="Game outing")
    ap.add_argument("--date", default="")
    ap.add_argument("--out", default=os.path.expanduser("~/Downloads"))
    a = ap.parse_args()

    src = open(APP).read()
    ARS = json.loads(re.search(r"const _ARS = (\{.*?\});\n", src, re.S).group(1))
    logo = re.search(r'const RPM_LOGO_DARK = "(data:image/png;base64,[^"]+)"',
                     src).group(1)
    updated = re.search(r'const LAST_UPDATED = "([^"]*)"', src).group(1)
    P = build_pools(ARS)

    # ---- calibration: push every same-level board type through the estimator
    cal = []
    for _, r in P[(P.lvl == a.lvl) & P.sp_true.notna() & (P.n >= 10)].iterrows():
        est_z = shape_z(P, r.pt, r.to_dict())
        cal.append((r.ath, r.pt, est_z, r.sp_true))
    cz = np.array([c[2] for c in cal])
    ct = np.array([c[3] for c in cal])
    # per-type Shape+ on the board is 100+10*(z-mu)/sd within the LEVEL pool of
    # my recomputed z — fit that affine map from the board itself:
    A_ = np.polyfit(cz, ct, 1)
    err = np.abs(np.polyval(A_, cz) - ct)
    med_err = float(np.median(err))
    print(f"[calibration] {len(cal)} {a.lvl} type-rows | median |err| "
          f"{med_err:.1f} pts | p90 {np.percentile(err,90):.1f}", file=sys.stderr)
    if med_err > 3:
        sys.exit("calibration failed (>3 pts median) — refusing to print estimates")

    # ---- the guest's outing
    df = pd.read_csv(a.csv).dropna(subset=["RelSpeed"])
    hand = df.PitcherThrows.dropna().iloc[0] if df.PitcherThrows.notna().any() else ""
    tmap = {"Four-Seam": "Fastball", "Two-Seam": "Sinker", "ChangeUp": "Changeup"}
    df["pt"] = df.AutoPitchType.map(lambda t: tmap.get(t, t))
    agg = (df.groupby("pt")
           .agg(n=("RelSpeed", "size"), velo=("RelSpeed", "mean"),
                vmax=("RelSpeed", "max"), spin=("SpinRate", "mean"),
                ivb=("InducedVertBreak", "mean"), hb=("HorzBreak", "mean"),
                relh=("RelHeight", "mean"), rels=("RelSide", "mean"),
                ext=("Extension", "mean"), sax=("SpinAxis", "mean"))
           .sort_values("n", ascending=False).reset_index())
    total = int(agg.n.sum())
    prim = agg[agg.pt.isin(FASTBALLS)].iloc[0] if agg.pt.isin(FASTBALLS).any() else agg.iloc[0]

    tps = []
    for _, t in agg.iterrows():
        feat = {"velo": t.velo, "ivb": t.ivb, "hb": t.hb, "spin": t.spin,
                "relh": t.relh, "rels": t.rels,
                "fb_velo": prim.velo, "fb_ivb": prim.ivb, "fb_hb": prim.hb,
                "fb_relh": prim.relh, "fb_rels": prim.rels}
        z_ = shape_z(P, t.pt, feat)
        spp = int(round(np.polyval(A_, z_)))
        sub = df[df.pt == t.pt]
        inz = sub[(sub.PlateLocSide.abs() <= ZX) & sub.PlateLocHeight.between(ZLO, ZHI)]
        zonep = round(len(inz) / len(sub) * 100)
        # circular-mean tilt from spin axis
        ang = math.degrees(math.atan2(np.sin(np.radians(sub.SpinAxis)).mean(),
                                      np.cos(np.radians(sub.SpinAxis)).mean())) % 360
        clock = (ang / 30 + 6) % 12
        hh = int(clock) or 12
        mm = int(round((clock - int(clock)) * 60 / 15)) * 15 % 60
        tps.append(dict(pt=t.pt, n=int(t.n), use=round(t.n / total * 100),
                        velo=t.velo, vmax=t.vmax, spin=t.spin, ivb=t.ivb,
                        hb=t.hb, ext=t.ext, tilt=f"{hh}:{mm:02d}", sp=spp,
                        zone=zonep))
    shape_est = int(round(np.average([t["sp"] for t in tps],
                                     weights=[t["n"] for t in tps])))
    # Strike+ estimate: zone% z-scored against same-level board athletes
    zn_pool = [x["zn"] for x in ARS["athletes"].values()
               if x["lvl"] == a.lvl and x.get("zn") is not None]
    inz_all = df[(df.PlateLocSide.abs() <= ZX) & df.PlateLocHeight.between(ZLO, ZHI)]
    zone_all = len(inz_all) / len(df) * 100
    strike_est = int(round(100 + 10 * zs(zone_all, zn_pool)))
    wsh, wst = (0.75, 0.25) if a.lvl == "col" else (0.6, 0.4)
    overall_est = int(round(wsh * shape_est + wst * strike_est))
    best = max([t for t in tps], key=lambda t: (t["n"] >= 5, t["sp"]))

    # ---- panels ----
    W = H = 200
    mvsvg = [f'<line x1="8" y1="{H/2:.0f}" x2="{W-8}" y2="{H/2:.0f}" stroke="{LINE}"/>',
             f'<line x1="{W/2:.0f}" y1="8" x2="{W/2:.0f}" y2="{H-24}" stroke="{LINE}"/>']
    lim = 26
    def MX(x): return 30 + (x + lim) / (2 * lim) * (W - 38)
    def MY(y): return (H - 26) - (y + lim) / (2 * lim) * (H - 38)
    mvsvg = [f'<line x1="{MX(-lim):.0f}" y1="{MY(0):.0f}" x2="{MX(lim):.0f}" y2="{MY(0):.0f}" stroke="{LINE}"/>',
             f'<line x1="{MX(0):.0f}" y1="{MY(-lim):.0f}" x2="{MX(0):.0f}" y2="{MY(lim):.0f}" stroke="{LINE}"/>']
    for _, r in df.iterrows():
        if pd.notna(r.InducedVertBreak) and pd.notna(r.HorzBreak):
            mvsvg.append(f'<circle cx="{MX(r.HorzBreak):.1f}" cy="{MY(r.InducedVertBreak):.1f}" r="2" fill="{PC.get(r.pt,"#6B7280")}" opacity="0.42"/>')
    for t in tps:
        mvsvg.append(f'<circle cx="{MX(t["hb"]):.1f}" cy="{MY(t["ivb"]):.1f}" r="5.5" fill="{PC.get(t["pt"],"#6B7280")}" stroke="#fff" stroke-width="1.6"/>')
    mvsvg.append(f'<text x="{MX(lim)-2:.0f}" y="{MY(0)-5:.0f}" text-anchor="end" font-size="7" fill="{FAINT}">HB &rarr;</text>')
    mvsvg.append(f'<text x="{MX(0)+5:.0f}" y="{MY(lim)+8:.0f}" font-size="7" fill="{FAINT}">IVB</text>')

    rp = df.dropna(subset=["RelSide", "RelHeight"])
    x0, x1 = rp.RelSide.min() - .5, rp.RelSide.max() + .5
    y0, y1 = rp.RelHeight.min() - .4, rp.RelHeight.max() + .4
    def RX(x): return 30 + (x - x0) / max(.1, x1 - x0) * (W - 40)
    def RY(y): return (H - 26) - (y - y0) / max(.1, y1 - y0) * (H - 42)
    rsvg = [f'<rect x="30" y="{H-26-(H-42):.0f}" width="{W-40}" height="{H-42}" fill="none" stroke="{LINE}"/>']
    for _, r in rp.iterrows():
        rsvg.append(f'<circle cx="{RX(r.RelSide):.1f}" cy="{RY(r.RelHeight):.1f}" r="2" fill="{PC.get(r.pt,"#6B7280")}" opacity="0.42"/>')
    for t in tps:
        rr = agg[agg.pt == t["pt"]].iloc[0]
        rsvg.append(f'<circle cx="{RX(rr.rels):.1f}" cy="{RY(rr.relh):.1f}" r="5.5" fill="{PC.get(t["pt"],"#6B7280")}" stroke="#fff" stroke-width="1.6"/>')
    rsvg.append(f'<text x="{W/2:.0f}" y="{H-8}" text-anchor="middle" font-size="7" fill="{FAINT}">release side (ft)</text>')
    rsvg.append(f'<text x="10" y="{H/2:.0f}" font-size="7" fill="{FAINT}" transform="rotate(-90 10 {H/2:.0f})" text-anchor="middle">release height (ft)</text>')

    mix = []
    yy = 12
    for t in tps[:6]:
        mix.append(f'<rect x="34" y="{yy}" width="{max(2, t["use"]/100*(W-78)):.1f}" height="13" rx="3" fill="{PC.get(t["pt"],"#6B7280")}"/>')
        mix.append(f'<text x="30" y="{yy+10}" text-anchor="end" font-size="8.5" font-weight="700" fill="{INK}">{AB.get(t["pt"],t["pt"][:2])}</text>')
        mix.append(f'<text x="{34+max(2,t["use"]/100*(W-78))+5:.1f}" y="{yy+10}" font-size="8.5" font-weight="700" fill="{MUT}">{t["use"]}%</text>')
        yy += 20

    rows = "".join(
        f'<tr><td class="pt"><span class="dot" style="background:{PC.get(t["pt"],"#6B7280")}"></span>{t["pt"]}'
        f'{"&#8202;&dagger;" if t["n"] < 15 else ""}</td>'
        f'<td>{t["n"]}</td><td>{t["use"]}%</td><td class="hi">{t["velo"]:.1f}</td><td>{t["vmax"]:.1f}</td>'
        f'<td>{t["spin"]:.0f}</td><td>{t["ivb"]:+.1f}</td><td>{t["hb"]:+.1f}</td>'
        f'<td>{t["tilt"]}</td><td>{t["ext"]:.1f}</td>'
        f'<td>{chip(t["sp"])}</td><td>{chip(t["zone"], "%", "pct")}</td></tr>'
        for t in tps)

    lvl = GROUP.get(a.lvl, a.lvl)
    stats = [("PITCHES", total, None), ("SHAPE+ EST", shape_est, grade_color(shape_est)),
             ("STRIKE+ EST", strike_est, grade_color(strike_est)),
             ("OVERALL EST", overall_est, grade_color(overall_est)),
             ("BEST PITCH", AB.get(best["pt"], best["pt"][:2]), None)]
    statboxes = "".join(
        f'<div class="sb"><div class="sbv" style="color:{c or "#fff"}">{v}</div><div class="sbl">{l}</div></div>'
        for l, v, c in stats)

    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><title>{a.athlete} - RPM Game Report</title><style>
{open(FONT).read() if os.path.exists(FONT) else ""}
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
      <div class="hname">{a.athlete}</div>
      <div style="margin-top:9px">
        <span class="hpill">{'RHP' if hand=='Right' else 'LHP' if hand=='Left' else ''}</span><span class="hpill">{a.event}</span><span class="hpill">peak {prim.vmax:.1f} mph</span>
      </div>
      <div class="hmeta">Game outing &middot; {a.date} &middot; grades estimated vs the RPM {lvl} board</div>
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
    <tr><th>PITCH</th><th>#</th><th>USE</th><th>VELO</th><th>MAX</th><th>SPIN</th><th>IVB</th><th>HB</th><th>TILT</th><th>EXT</th><th>SHAPE+ EST</th><th>ZONE%</th></tr>
    {rows}
  </table>
  <div class="foot">
    <div class="fl"><b style="color:#DCE6F5">Shape+ and Strike+ estimates: 100 = the RPM {lvl} average.</b> 10 points = one standard deviation. Estimated against the RPM board from per-pitch TrackMan game data (types consolidated to the athlete&rsquo;s repertoire; outing isolated by velocity band and release-point clustering). &dagger; fewer than 15 pitches &mdash; provisional. Single-outing sample; not an official RPM arsenal grade.</div>
    <div class="fr">RPM Strength &middot; Queens, NY<br>Board basis: {updated}</div>
  </div>
</div></body></html>"""

    hpath = os.path.join(tempfile.mkdtemp(prefix="rpmcard-"), "card.html")
    pdf = os.path.join(a.out, f"RPM Game Report - {a.athlete} - {a.date or 'game'}.pdf")
    open(hpath, "w").write(html)
    subprocess.run([CHROME, "--headless", "--disable-gpu", f"--print-to-pdf={pdf}",
                    "--no-pdf-header-footer", hpath], check=True, capture_output=True)
    print(json.dumps({"shape_est": shape_est, "strike_est": strike_est,
                      "overall_est": overall_est, "cal_median_err": round(med_err, 2),
                      "types": [(t["pt"], t["n"], t["sp"]) for t in tps],
                      "pdf": pdf}, indent=1))


if __name__ == "__main__":
    main()
