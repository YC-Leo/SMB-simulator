"""Run the test cases (Original mode) and compare them with their benchmark values.

    python validation/validate_cases.py               # all cases
    python validation/validate_cases.py 2 3           # only Cases 2 and 3
"""
import csv
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from smbsim import case_1, case_2, case_3, run  # noqa: E402

# ---------------------------------------------------------------- benchmark values
CASE_1 = {  # group values: extract purity / recovery of the wanted component, raffinate of the unwanted one
    "constant": {"Extract purity": 96.9608, "Extract recovery": 99.9150, "Raffinate purity": 99.9851, "Raffinate recovery": 99.4551},
    "volume_change": {"Extract purity": 98.6292, "Extract recovery": 99.0786, "Raffinate purity": 99.9642, "Raffinate recovery": 100.1000},
}

# per component: (extract recovery, extract purity, raffinate recovery, raffinate purity), desorbent-free purities
CASE_2_3 = {
    "Case 2, constant flow": (case_2, dict(flow_model="constant"), {
        "Unwanted 1": (1.227936, 0.669423, 98.772064, 26.942822),
        "Wanted 1": (92.034834, 56.493739, 7.965166, 2.446396),
        "Wanted 2": (87.795926, 8.447700, 12.204074, 0.587561),
        "Wanted 3": (95.045624, 25.294735, 4.954376, 0.659737),
        "Unwanted 2": (0.753089, 0.370824, 99.246911, 24.452445),
        "Unwanted 3": (8.858154, 8.723578, 91.141846, 44.911039)}),
    "Case 2, volume change": (case_2, dict(flow_model="volume_change"), {
        "Unwanted 1": (1.033749, 0.574112, 98.927762, 26.751741),
        "Wanted 1": (91.323898, 57.106970, 8.663336, 2.637801),
        "Wanted 2": (86.680234, 8.496515, 13.302732, 0.634912),
        "Wanted 3": (94.771749, 25.694105, 5.220943, 0.689217),
        "Unwanted 2": (0.630636, 0.316342, 99.332098, 24.261621),
        "Unwanted 3": (7.786671, 7.811957, 92.170237, 45.024708)}),
    "Case 3 (volume change)": (case_3, dict(), {
        "Unwanted 1": (1.319005, 0.850692, 98.648413, 24.985760),
        "Wanted 1": (75.460603, 54.798597, 24.517932, 6.992126),
        "Wanted 2": (67.085383, 7.636478, 32.889185, 1.470262),
        "Wanted 3": (87.550277, 27.564912, 12.435773, 1.537617),
        "Unwanted 2": (0.844143, 0.491743, 99.124160, 22.676620),
        "Unwanted 3": (7.430942, 8.657577, 92.533204, 42.337615)}),
}


def check_case_1():
    print("\n=== Case 1: 3 components (Original mode) ===")
    for flow, ref in CASE_1.items():
        t = time.time()
        m = run(case_1(scheme="original", flow_model=flow))["metrics"]
        got = {"Extract purity": m["extract_purity"], "Extract recovery": m["extract_recovery"],
               "Raffinate purity": m["raffinate_purity"], "Raffinate recovery": m["raffinate_recovery"]}
        print(f"\n{flow}  ({time.time() - t:.0f} s)")
        for k, v in ref.items():
            print(f"   {k:20s} sim {got[k]:8.3f}   benchmark {v:8.3f}   diff {got[k] - v:+6.3f}")


def check_cases_2_3(which):
    print("\n=== Cases 2 and 3: 7 components (Original mode, 3-7-4-2) ===")
    worst = 0.0
    for label, (make, over, ref) in CASE_2_3.items():
        if label.split()[1].rstrip(",") not in which:
            continue
        t = time.time()
        res = run(make(scheme="original", **over))
        comps = {c["name"]: c for c in res["metrics"]["components"]}
        print(f"\n{label}  ({time.time() - t:.0f} s, {res['cycles']:.1f} cycles)")
        print(f"   {'component':11s} {'ext rec':>17s} {'ext purity':>17s} {'raf rec':>17s} {'raf purity':>17s}")
        for name, r in ref.items():
            c = comps[name]
            g = (c["to_extract"], c["extract_purity"], c["to_raffinate"], c["raffinate_purity"])
            worst = max(worst, max(abs(a - b) for a, b in zip(g, r)))
            print(f"   {name:11s} " + " ".join(f"{a:7.2f} ({b:7.2f})" for a, b in zip(g, r)))
        if label == "Case 2, volume change":
            compare_profile(res)
    print(f"\n   values: simulator (benchmark).  Largest difference: {worst:.2f} percentage points")


def compare_profile(res):
    """End-of-switch axial profile against the benchmark profile."""
    path = ROOT / "validation" / "reference" / "case2_profile_end.csv"
    with open(path) as f:
        rows = list(csv.DictReader(f))
    names = [k for k in rows[0] if k not in ("column", "node")]
    ref = np.array([[float(r[n]) for n in names] for r in rows])          # (224, nc)
    cfg_names = [c["name"] for c in res["config"]["components"]]
    n, ncell = len(res["config"]["zones"]) and sum(res["config"]["zones"]), res["cells_per_column"]
    C = np.asarray(res["frames"][-1]["C"]).reshape(len(cfg_names), n, ncell)[:, :, 1:].reshape(len(cfg_names), -1)
    sim = np.stack([C[cfg_names.index(nm)] for nm in names], axis=1)
    d = np.abs(sim - ref)
    print(f"   end-of-switch profile, {ref.shape[0]} nodes x {len(names)} components: "
          f"max |diff| = {d.max():.4f} g/mL (peak concentration {ref.max():.3f} g/mL)")


if __name__ == "__main__":
    which = sys.argv[1:] or ["1", "2", "3"]
    if "1" in which:
        check_case_1()
    if "2" in which or "3" in which:
        check_cases_2_3(which)
