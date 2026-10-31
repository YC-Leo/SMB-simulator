"""Small changes to one input at a time, compared with what SMB theory and experience predict.

    python validation/sensitivity_study.py            # prints a table, writes sensitivity_results.md

Base case: the Case 2, Original mode, constant flow.
Expected directions follow equilibrium (triangle) theory and the standard non-ideal effects:
lower column efficiency (more dispersion, slower mass transfer, fewer columns) costs purity
and recovery; changing the column volume at fixed flows shifts every m-value.
"""
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from smbsim import case_2, run  # noqa: E402

KEYS = ("extract_purity", "extract_recovery", "raffinate_purity", "raffinate_recovery")


def perf(**over):
    cfg = case_2(**over)
    t = time.time()
    m = run(cfg)["metrics"]
    return {**{k: m[k] for k in KEYS}, "m": cfg.derived()["m_values"], "s": time.time() - t}


def worse_overall(s, b):
    return sum(s[k] for k in KEYS) < sum(b[k] for k in KEYS) - 0.5


# Triangle theory: m_j = (Q_j t* - eps V) / ((1 - eps) V).  Lowering every m holds the weakly adsorbed
# (unwanted) components back, so they leak into the extract: raffinate recovery and extract purity fall.
# Raising every m pushes the strongly adsorbed (wanted) components forward into the raffinate:
# extract recovery and raffinate purity fall.  In this case the window m2 < m < m3 is narrow
# (0.55-0.65), so even a few percent change in volume or switch time moves the operating point a lot.
M_DOWN = ("all m fall → unwanted held back into the extract: raffinate recovery and extract purity fall",
          lambda s, b: s["raffinate_recovery"] < b["raffinate_recovery"] and s["extract_purity"] < b["extract_purity"])
M_UP = ("all m rise → wanted pushed into the raffinate: extract recovery and raffinate purity fall",
        lambda s, b: s["extract_recovery"] < b["extract_recovery"] and s["raffinate_purity"] < b["raffinate_purity"])
EFF = ("lower column efficiency → fronts broaden → overall performance falls", worse_overall)

CASES = [
    ("Péclet 1000 → 250 (4× more axial dispersion)", dict(peclet=250.0), *EFF),
    ("Particle size 100 → 300 µm (Pe from particle size)", dict(dispersion_spec="particle", particle_diameter=300.0), *EFF),
    ("Mass-transfer k 4 → 2 /min (all components)", "kap", *EFF),
    ("Column radius +1% (area +2%, same flows)", dict(radius=0.470003 * 1.01), *M_DOWN),
    ("Column length +2% (same flows)", dict(length=20.4), *M_DOWN),
    ("Bed void fraction 0.387 → 0.395", dict(bed_porosity=0.395), *M_DOWN),
    ("Switch time −2%", dict(step_time=1.893 * 0.98), *M_DOWN),
    ("Switch time +2%", dict(step_time=1.893 * 1.02), *M_UP),
    ("Columns 3-7-4-2 → 3-6-5-2", dict(zones=[3, 6, 5, 2]),
     "m unchanged; longer zone III holds the wanted back (extract recovery up), shorter zone II cleans the extract less (extract purity down)",
     lambda s, b: s["extract_recovery"] > b["extract_recovery"] and s["extract_purity"] < b["extract_purity"]),
    ("Half the columns, same zone lengths (2-4-2-1 × 40 cm)", dict(zones=[2, 4, 2, 1], length=40.0, step_time=1.893 * 2),
     "m unchanged; coarser port movement is further from true counter-current flow → performance falls slightly",
     worse_overall),
    ("Volume change instead of constant flow", dict(flow_model="volume_change"),
     "flow varies with density changes; small shift expected (< 2 points)",
     lambda s, b: all(abs(s[k] - b[k]) < 2 for k in KEYS)),
]


def main():
    base = perf()
    rows = [("Base case", base, "", None)]
    for label, over, expect, check in CASES:
        if over == "kap":
            cfg = case_2()
            for c in cfg.components:
                c.kap = 2.0
            t = time.time(); m = run(cfg)["metrics"]
            s = {**{k: m[k] for k in KEYS}, "m": cfg.derived()["m_values"], "s": time.time() - t}
        else:
            s = perf(**over)
        rows.append((label, s, expect, check(s, base)))
        print(f"{label:58s} " + "  ".join(f"{s[k]:6.2f}" for k in KEYS) + f"   {'✓' if rows[-1][3] else '✗'}", flush=True)

    md = ["| Change | Extract purity | Extract recovery | Raffinate purity | Raffinate recovery | m₂ / m₃ | Expected | Agrees |",
          "|---|---|---|---|---|---|---|---|"]
    for label, s, expect, ok in rows:
        d = lambda k: f"{s[k]:.2f}" + ("" if s is base else f" ({s[k] - base[k]:+.2f})")
        md.append(f"| {label} | {d('extract_purity')} | {d('extract_recovery')} | {d('raffinate_purity')} | "
                  f"{d('raffinate_recovery')} | {s['m'][1]:.3f} / {s['m'][2]:.3f} | {expect} | "
                  f"{'' if ok is None else ('yes' if ok else 'no')} |")
    out = ROOT / "validation" / "sensitivity_results.md"
    out.write_text("# Sensitivity study (Case 2, Original mode, constant flow)\n\n"
                   "Group purities and recoveries in %, change from the base case in brackets.\n\n" + "\n".join(md) + "\n")
    print(f"\nwritten {out}")


if __name__ == "__main__":
    main()
