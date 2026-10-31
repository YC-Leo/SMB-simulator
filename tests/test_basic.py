"""Quick sanity tests (run with:  python -m pytest tests  or  python tests/test_basic.py)."""
import math
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from smbsim import default_case, case_2, Simulator, SMBConfig  # noqa: E402
from smbsim.config import Port  # noqa: E402


def test_default_is_valid():
    assert default_case().validate() == []
    assert case_2().validate() == []


def test_roundtrip():
    c = default_case(scheme="conservative")
    assert SMBConfig.from_dict(c.to_dict()).to_dict() == c.to_dict()


def test_legacy_file_import():
    c = default_case()
    old = {"components": [x.__dict__ for x in c.components], "zones": [5, 4, 4, 3], "Q1": 6.85,
           "QD": 5.71, "QE": 3.58, "QF": 1.32, "area": 0.693978, "porosity": 0.45}
    n = SMBConfig.from_dict(old)
    assert n.validate() == [] and abs(n.area - 0.693978) < 1e-9 and n.zone_flows == c.zone_flows


def test_derived_quantities():
    c = case_2()
    assert abs(c.porosity - (0.387 + 0.613 * 0.461)) < 1e-12
    c.dispersion_spec, c.particle_diameter, c.particle_peclet = "particle", 100.0, 0.5
    assert abs(c.peclet_eff - 1000.0) < 1e-9                  # 0.5 * 20 cm / 0.01 cm
    zf = default_case().zone_flows
    assert [round(q, 6) for q in zf] == [6.85, 3.27, 4.59, 1.14]


def test_validation_catches_bad_input():
    assert any("flow" in e for e in default_case(QE=20.0).validate())
    assert any("16" in e for e in default_case(zones=[5, 5, 5, 3]).validate())


def test_three_zone_open_loop_balances():
    c = default_case(zones=[5, 6, 5], open_loop=True, step_time=2.0)
    c.ports = [Port("desorbent", 0, 4.0), Port("extract", 1, 2.5), Port("feed", 2, 1.0),
               Port("raffinate", 0, 0.0, True)]
    assert c.validate() == [], c.validate()
    plan = c.flow_plan()
    assert math.isclose(plan["Q1"], 4.0) and math.isclose(plan["QB"], 2.5)      # 4 - 2.5 + 1


def test_short_runs_are_finite():
    for scheme in ("original", "conservative"):
        for flow in ("constant", "volume_change"):
            cfg = default_case(scheme=scheme, flow_model=flow, max_cycles=1, accelerate=False)
            r = Simulator(cfg).run()
            m = r["metrics"]
            assert all(0 <= m[k] <= 100.0001 for k in ("extract_purity", "raffinate_purity"))
            assert r["frames"] and r["outlets"] and len(r["history"]) == 1


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"):
            f(); print("ok ", name)
