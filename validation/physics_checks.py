"""Checks that the results come from the physics, not from stored answers.

    python validation/physics_checks.py

1. Independent scheme: solve the Case 2 with the Conservative (finite-volume) mode,
   which shares no discretisation code with the Original mode, and compare.
2. Cause and effect: change one physical input at a time and check the response has the
   direction the physics requires.
3. Conservation: report how well the simulated outlet streams close the mass balance.
"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smbsim import case_2, run  # noqa: E402


def summary(cfg):
    t = time.time()
    r = run(cfg)
    m = r["metrics"]
    return {"EP": m["extract_purity"], "ER": m["extract_recovery"], "RP": m["raffinate_purity"],
            "RR": m["raffinate_recovery"], "closure": m["mass_closure_max_dev"], "s": time.time() - t,
            "comps": {c["name"]: c for c in m["components"]}}


def line(label, s):
    print(f"   {label:46s} ext pur {s['EP']:6.2f}  ext rec {s['ER']:6.2f}  raf pur {s['RP']:6.2f}  raf rec {s['RR']:6.2f}")


print("\n1) Same physics, two independent numerical schemes (Case 2, constant flow)")
a = summary(case_2(scheme="original"))
b = summary(case_2(scheme="conservative"))
line("Original (finite differences, clustered nodes)", a)
line("Conservative (finite volumes, own grid)", b)

print("\n2) Cause and effect, one input at a time (Original mode)")
base = a
cases = [
    ("extract flow +20%  (more liquid out at E)", dict(QE=0.721 * 1.2),
     "extract recovery should rise, extract purity should fall",
     lambda s: s["ER"] > base["ER"] and s["EP"] < base["EP"]),
    ("feed flow x2  (overloading the unit)", dict(QF=0.48),
     "higher zone III flow pushes wanted material to the raffinate: extract recovery and raffinate purity fall",
     lambda s: s["ER"] < base["ER"] and s["RP"] < base["RP"]),
    ("switch time -15%  (ports move faster)", dict(step_time=1.893 * 0.85),
     "every m falls; zone I no longer regenerates the adsorbent, so wanted material is carried round into the raffinate: raffinate purity falls",
     lambda s: s["RP"] < base["RP"]),
]
for label, over, expect, ok in cases:
    s = summary(case_2(**over))
    line(label, s)
    print(f"      expected: {expect}  ->  {'YES' if ok(s) else 'NO'}")

# isotherm: make 'Wanted 1' bind as weakly as the weakest unwanted component
cfg = case_2()
w1 = next(c for c in cfg.components if c.name == "Wanted 1")
w1.keq = 919.522
s = summary(cfg)
r0, r1 = base["comps"]["Wanted 1"]["to_extract"], s["comps"]["Wanted 1"]["to_extract"]
print(f"   Wanted 1 affinity K 1420 -> 920 (isotherm)      Wanted 1 extract recovery {r0:6.2f} -> {r1:6.2f}")
print(f"      expected: a weaker-binding component is carried to the raffinate  ->  {'YES' if r1 < r0 - 5 else 'NO'}")

print("\n3) Conservation: amount out (extract + raffinate) vs amount in, per component")
for name, c in base["comps"].items():
    print(f"   {name:11s} {c['closure']:7.2f} %")
print("   (computed from the simulated outlet streams; the code never forces these to 100 %)")
