#!/usr/bin/env python3
"""RPM team velocity-model report, for a visiting school's coaching staff.

    python3 report_cards/gen_team_velo_report.py --team "St. Francis Prep" \
        --date "November 3, 2026" --names "Anthony Panetta,Jake Beaver,..."

One page (two if the roster is long): the portal's predicted-vs-actual chart
with every RPM pitcher in the model as a faded dot and the team's arms drawn
on top, numbered in the order given (Frank, 2026-11-03: "show them all of the
pitchers on their team's dots while the other dots around them are faded").
Under it, one row per arm: force plate inputs, grip, predicted and actual peak
fastball.

Reads the BUILT src/App.jsx _VM (never re-fits): row layout is documented in
generate_portal_data.gen_VM. The primary read matches the portal: the grip
model when the athlete has a grip test and bodyweight (predG at [25]), else
force plate only (predA at [8]). Bands are the portal's: gband / rmse.
Impulse / RSI percentiles use the portal's own cP interpolation against the
level's _N norms, exactly as each athlete's eval card does (Frank hands both
to the same staff). Grip percentile and the chart pool are the level's model
rows that have a grip prediction, the pool the eval card's velo chart plots.
"""
import argparse, json, os, re, subprocess, sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_eval_report import cP, arr  # same percentiles as the athletes' own eval cards

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FONT = os.path.join(HERE, "dmsans_embed.css")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
NAVY, INK, MUT, FAINT = "#16233C", "#1B2A44", "#5B6470", "#98A0AA"
LINE, PANEL = "#E3E6EA", "#F7F8FA"
# Model-read palette from the RPM Velocity Model flyer's sample card (2026-11-03):
# blue = below the model, tan = on it, red = above it.
BELOW, ONM, ABOVE = "#2F6BD0", "#D2C8B4", "#C8102E"
LVL = {"hs": "High school", "col": "College", "pro": "Pro"}


def pct(v, pool):
    pool = [p for p in pool if p is not None]
    if v is None or not pool:
        return None
    return round(100 * sum(1 for p in pool if p < v) / len(pool))


def ordinal(p):
    return "th" if 10 <= p % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(p % 10, "th")


def primary(r, vm):
    """(pred, band, model) exactly as the portal's VM_ROWS primary remap."""
    if len(r) > 25 and r[25] is not None:
        return r[25], vm["gband"], "grip"
    return r[8], vm["rmse"], "A"


def chart(rows, team, vm, flagged=()):
    W, H = 736, 270
    L, R, T, B = 52, 18, 16, 44
    pts = [(primary(r, vm)[0], r[5]) for r in rows]
    lo = min(min(p) for p in pts) - 2
    hi = max(max(p) for p in pts) + 2
    lo, hi = 5 * int(lo // 5), 5 * int(-(-hi // 5))
    sx = lambda v: L + (v - lo) / (hi - lo) * (W - L - R)
    sy = lambda v: H - B - (v - lo) / (hi - lo) * (H - T - B)
    band = vm["gband"]
    o = [f'<svg viewBox="0 0 {W} {H}" width="{W}" height="{H}" xmlns="http://www.w3.org/2000/svg" font-family="DM Sans">']
    for t in range(lo, hi + 1, 5):
        o.append(f'<line x1="{L}" x2="{W-R}" y1="{sy(t):.1f}" y2="{sy(t):.1f}" stroke="{LINE}"/>')
        o.append(f'<line y1="{T}" y2="{H-B}" x1="{sx(t):.1f}" x2="{sx(t):.1f}" stroke="{LINE}"/>')
        o.append(f'<text x="{L-8}" y="{sy(t)+3.5:.1f}" font-size="10" fill="{MUT}" text-anchor="end">{t}</text>')
        o.append(f'<text x="{sx(t):.1f}" y="{H-B+16}" font-size="10" fill="{MUT}" text-anchor="middle">{t}</text>')
    # +/- band around the 1:1 line, clipped to the plot
    poly = [(lo, lo + band), (hi - band, hi), (hi, hi), (hi, hi - band), (lo + band, lo), (lo, lo)]
    o.append('<polygon points="' + " ".join(f"{sx(x):.1f},{sy(y):.1f}" for x, y in poly) +
             f'" fill="{NAVY}" fill-opacity="0.06"/>')
    o.append(f'<line x1="{sx(lo):.1f}" y1="{sy(lo):.1f}" x2="{sx(hi):.1f}" y2="{sy(hi):.1f}" '
             f'stroke="{NAVY}" stroke-opacity="0.45" stroke-dasharray="5 4"/>')
    o.append(f'<text x="{sx(hi)-6:.1f}" y="{sy(hi)+14:.1f}" font-size="9" fill="{MUT}" text-anchor="end">'
             f'Throwing exactly what the model predicts</text>')
    names = {r[0] for r, _ in team}
    for r in rows:
        if r[0] in names:
            continue
        p = primary(r, vm)[0]
        o.append(f'<circle cx="{sx(p):.1f}" cy="{sy(r[5]):.1f}" r="4" fill="#B8BFC9" fill-opacity="0.45"/>')
    for r, i in team:
        p = primary(r, vm)[0]
        # Flagged arms (model not valid for them) draw as an outlined ring.
        f = r[0] in flagged
        o.append(f'<circle cx="{sx(p):.1f}" cy="{sy(r[5]):.1f}" r="10" fill="{"#fff" if f else NAVY}" '
                 f'stroke="{NAVY if f else "#fff"}" stroke-width="2"/>')
        o.append(f'<text x="{sx(p):.1f}" y="{sy(r[5])+3.6:.1f}" font-size="10" font-weight="800" '
                 f'fill="{NAVY if f else "#fff"}" text-anchor="middle">{i}</text>')
    o.append(f'<text x="{(L+W-R)/2:.1f}" y="{H-6}" font-size="10.5" font-weight="700" fill="{INK}" text-anchor="middle">'
             f'PREDICTED PEAK FASTBALL (mph), from force plate + grip</text>')
    o.append(f'<text transform="translate(13 {(T+H-B)/2:.1f}) rotate(-90)" font-size="10.5" font-weight="700" fill="{INK}" '
             f'text-anchor="middle">ACTUAL PEAK FASTBALL (mph)</text>')
    o.append("</svg>")
    return "".join(o)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--team", required=True)
    ap.add_argument("--names", required=True, help="comma-separated, in display order")
    ap.add_argument("--date", default=date.today().strftime("%B %-d, %Y"))
    ap.add_argument("--out", default=os.path.expanduser("~/Desktop"))
    ap.add_argument("--flag", action="append", default=[], metavar="NAME=NOTE",
                    help="asterisk an arm the model can't read, with a footnote (repeatable)")
    a = ap.parse_args()

    src = open(os.path.join(REPO, "src", "App.jsx")).read()
    vm = json.loads(re.search(r"const _VM = (\{.*?\});\n", src, re.S).group(1))
    logo = re.search(r'const RPM_LOGO_DARK = "(data:image/png;base64,[^"]+)"', src).group(1)
    rows = vm["rows"]
    by = {r[0]: r for r in rows}
    want = [n.strip() for n in a.names.split(",") if n.strip()]
    missing = [n for n in want if n not in by]
    if missing:
        raise SystemExit(f"not in the velo model (need a CMJ + a bullpen): {missing}")
    team = [(by[n], i + 1) for i, n in enumerate(want)]
    flags = dict(f.split("=", 1) for f in a.flag)
    bad = [n for n in flags if n not in want]
    if bad:
        raise SystemExit(f"--flag names not in --names: {bad}")
    # Faded dots = the team's own level(s), the same pool the individual eval
    # cards plot and the percentiles below use.
    lvls = sorted({r[1] for r, _ in team})
    rows = [r for r in rows if r[1] in lvls and len(r) > 25 and r[25] is not None]
    N = arr(src, "_N", "{")

    trs = ""
    for r, i in team:
        lvl = r[1]
        pool = [x for x in rows if x[1] == lvl]
        pred, band, model = primary(r, vm)
        diff = r[5] - pred
        if abs(diff) <= band:
            read, col = "On the model", NAVY
        elif diff > 0:
            read, col = "Above the model", ABOVE
        else:
            read, col = "Below the model", BELOW
        norms = N.get(lvl) or N["all"]
        pc = cP(r[2], norms["conImpulse"])
        pr = cP(r[3], norms["rsiMod"])
        if r[24] is not None:
            pg = pct(r[24], [x[24] for x in pool])
            grip = (f'{r[24]/4.44822:.0f} lbs <span class="dt">{r[24]:.0f} N &middot; {pg}{ordinal(pg)}</span>')
        else:
            grip = f'<span style="color:{FAINT}">not tested</span>'
        mtag = "" if model == "grip" else ' <span class="dt">plate only</span>'
        # Flyer-style gauge: three equal zones, the middle one is the +/- band,
        # so the scale runs -3 to +3 bands and the marker clamps at the ends.
        x = max(0.0, min(1.0, (diff / band + 3) / 6))
        gauge = (f'<div class="gl" style="color:{col}">{read}</div>'
                 f'<div class="gb"><i style="background:{BELOW}"></i><i style="background:{ONM}"></i>'
                 f'<i style="background:{ABOVE}"></i><b style="left:{x*100:.1f}%"></b></div>')
        trs += (f'<tr><td><span class="num">{i}</span></td><td class="nm">{r[0]}{'*' if r[0] in flags else ''}</td>'
                f'<td>{r[2]:.0f} <span class="dt">{pc}{ordinal(pc)}</span></td>'
                f'<td>{r[3]:.2f} <span class="dt">{pr}{ordinal(pr)}</span></td>'
                f'<td>{grip}</td>'
                f'<td>{pred:.1f} <span class="dt">&plusmn;{band}</span>{mtag}</td>'
                f'<td><b>{r[5]:.1f}</b></td>'
                f'<td class="gc">{gauge}</td>'
                f'<td style="color:{col};font-weight:700">{diff:+.1f}</td></tr>')

    lvl_txt = " / ".join(LVL.get(l, l) for l in lvls).lower()
    font = open(FONT).read() if os.path.exists(FONT) else ""
    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>{font}
*{{margin:0;padding:0;box-sizing:border-box}}@page{{size:letter;margin:0}}
body{{font-family:'DM Sans',sans-serif;color:{INK};background:#fff}}
.page{{width:816px;height:1056px;padding:26px 40px 50px;position:relative;overflow:hidden}}
.hero{{background:{NAVY};border-radius:14px;padding:18px 26px;color:#fff;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center}}
.hname{{font-size:27px;font-weight:800;letter-spacing:-0.5px}}
.hsub{{font-size:12px;color:#9FB0CC;margin-top:5px}}
.hpill{{display:inline-block;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.16);border-radius:999px;padding:3px 10px;font-size:10px;font-weight:700;color:#DCE6F5;margin-right:6px;margin-top:10px}}
.logo{{height:46px;background:#fff;border-radius:10px;padding:6px 10px}}
.stitle{{font-size:12px;font-weight:800;letter-spacing:1.2px;color:{NAVY};margin:12px 0 6px}}
.ssub{{font-size:10px;color:{MUT};margin-bottom:6px}}
.leg{{display:flex;gap:18px;font-size:9.5px;color:{MUT};margin:2px 0 4px 52px;align-items:center}}
.leg i{{display:inline-block;vertical-align:middle;margin-right:5px}}
table{{width:100%;border-collapse:collapse;font-size:10.5px}}
th{{text-align:left;font-size:8px;letter-spacing:0.7px;color:{MUT};border-bottom:2px solid {NAVY};padding:5px 6px;white-space:nowrap}}
td{{padding:5px 6px;border-bottom:1px solid {LINE};white-space:nowrap}}
tr:nth-child(even) td{{background:{PANEL}}}
.nm{{font-weight:700}}
.dt{{color:{FAINT};font-size:8.5px}}
.num{{display:inline-block;width:18px;height:18px;border-radius:50%;background:{NAVY};color:#fff;font-size:9.5px;font-weight:800;text-align:center;line-height:18px}}
th,td{{text-align:center}}
td.nm,th.nm{{text-align:left}}
.gc{{width:128px}}
.fn{{font-size:9px;color:{MUT};margin-top:6px}}
.gl{{font-size:7.5px;font-weight:800;letter-spacing:0.7px;text-transform:uppercase;margin-bottom:3px}}
.gb{{position:relative;display:flex;gap:2px;height:7px;width:120px;margin:0 auto}}
.gb i{{flex:1;display:block;height:7px}}
.gb b{{position:absolute;top:-3px;width:3px;height:13px;margin-left:-1.5px;background:{INK};border-radius:1px}}
.note{{background:{PANEL};border:1px solid {LINE};border-radius:10px;padding:9px 14px;font-size:8.8px;color:{MUT};line-height:1.55;margin-top:12px}}
.foot{{position:absolute;bottom:24px;left:40px;right:40px;display:flex;justify-content:space-between;font-size:9px;color:{FAINT}}}
</style></head><body>
<div class="page">
  <div class="hero">
    <div>
      <div class="hname">{a.team} &middot; Pitching Testing Day</div>
      <div class="hsub">RPM velocity model &nbsp;&middot;&nbsp; {a.date}</div>
      <div><span class="hpill">{len(team)} pitchers tested</span><span class="hpill">VALD ForceDecks + DynaMo</span><span class="hpill">TrackMan bullpen</span></div>
    </div>
    <img class="logo" src="{logo}">
  </div>
  <div class="stitle">WHERE YOUR PITCHERS SIT IN THE RPM VELOCITY MODEL</div>
  <div class="ssub">Each grey dot is one of the {len(rows)} {lvl_txt} pitchers in the RPM model. Numbered dots are your staff, matching the table below.</div>
  <div class="leg"><span><i style="width:12px;height:12px;border-radius:50%;background:{NAVY}"></i>{a.team}</span><span><i style="width:8px;height:8px;border-radius:50%;background:#B8BFC9"></i>Other RPM pitchers</span><span><i style="width:16px;height:0;border-top:1.5px dashed {NAVY}"></i>Prediction line (shaded &plusmn;{vm['gband']} mph)</span></div>
  {chart(rows, team, vm, flags)}
  <div class="stitle">THE NUMBERS</div>
  <table>
    <tr><th>#</th><th class="nm">PITCHER</th><th>CON. IMPULSE (N&middot;s)</th><th>RSI-MOD</th><th>GRIP (throwing hand)</th><th>PREDICTED FB</th><th>ACTUAL PEAK FB</th><th>VS. THE MODEL</th><th>DIFF</th></tr>
    {trs}
  </table>
  {''.join(f'<div class="fn">* <b>{n}:</b> {t}</div>' for n, t in flags.items())}
  <div class="note"><b>How to read this.</b> The model predicts peak fastball velocity from three numbers. <b>Concentric impulse</b> (countermovement jump) is the total push-off force put into the ground, in Newton-seconds; it grows with strength and body mass. <b>RSI-modified</b> is jump height divided by the time it takes to jump, a measure of how quickly that force is produced. <b>Grip</b> is the strongest squeeze on the handheld dynamometer with the throwing hand, and the model reads it relative to bodyweight. Small grey numbers are percentiles among RPM {lvl_txt} athletes, the same comparison as each pitcher&rsquo;s own report. Force plate numbers are each pitcher&rsquo;s best jump on file, the values the model uses. <b>Actual peak FB</b> is the hardest fastball from today's TrackMan bullpen. Dots above the line are throwing harder than their strength profile predicts (efficient movers; strength is the next lever), dots below are leaving velocity on the table relative to the engine they already have (mechanics, intent or arm conditioning). Inside the shaded band the arm and the engine agree, within the model's typical error of &plusmn;{vm['gband']} mph.</div>
  <div class="foot"><div>RPM Strength &middot; Queens, NY</div><div>Prepared for the {a.team} coaching staff &middot; {a.date}</div></div>
</div>
</body></html>"""
    os.makedirs(a.out, exist_ok=True)
    stem = f"{a.team} - RPM Velocity Model Report"
    oh = os.path.join(a.out, stem + ".html")
    op = os.path.join(a.out, stem + ".pdf")
    open(oh, "w").write(html)
    subprocess.run([CHROME, "--headless", "--disable-gpu", f"--print-to-pdf={op}",
                    "--no-pdf-header-footer", oh], check=True, capture_output=True)
    os.remove(oh)
    print(op)


if __name__ == "__main__":
    main()
