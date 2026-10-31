"""Input definitions for an SMB simulation, derived quantities and the built-in test cases.

Unit layout
-----------
The unit is a ring of identical columns, grouped into zones in the direction of flow.
A port sits at the *start* of a zone (the junction just before that zone's first column):

* inlet ports  - ``desorbent`` and ``feed``  - add liquid of a fixed composition
* outlet ports - ``extract`` and ``raffinate`` - withdraw liquid leaving the previous column

The zone I flow (flow entering the first column of zone I) is specified.  All port flows are
specified except one outlet, the *balance* port, whose flow closes the liquid balance
(classically the raffinate).  In an open-loop unit nothing is recycled: everything reaching the
end of the last zone leaves through the balance port, so the zone I flow equals the inlet flow
at the start of zone I.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import List

ROLES = ("extract", "raffinate", "desorbent")   # which outlet a component should leave by
SCHEMES = ("original", "conservative")
FLOW_MODELS = ("constant", "volume_change")
PORT_KINDS = ("desorbent", "feed", "extract", "raffinate")
INLET_KINDS = ("desorbent", "feed")
MAX_COLUMNS = 16
MAX_ZONES = 6
ROMAN = ["I", "II", "III", "IV", "V", "VI"]


@dataclass
class Component:
    name: str
    role: str = "raffinate"      # 'extract' | 'raffinate' | 'desorbent'
    qsat: float = 0.4            # saturation capacity, g per mL solid
    keq: float = 10.0            # Langmuir affinity constant, mL/g
    kap: float = 1.0             # LDF mass-transfer coefficient, 1/min
    rho: float = 0.8             # pure-liquid density, g/mL
    feed_frac: float = 0.0       # volume fraction in the feed
    des_frac: float = 0.0        # volume fraction in the desorbent


@dataclass
class Port:
    kind: str                    # 'desorbent' | 'feed' | 'extract' | 'raffinate'
    zone: int                    # the port acts at the start of this zone (0 = zone I)
    flow: float = 0.0            # mL/min (ignored for the balance port)
    balance: bool = False        # outlet whose flow is computed from the liquid balance


def classic_ports(QD, QE, QF):
    return [Port("desorbent", 0, QD), Port("extract", 1, QE), Port("feed", 2, QF), Port("raffinate", 3, 0.0, True)]


@dataclass
class SMBConfig:
    components: List[Component]
    isotherm: str = "competitive_langmuir"
    scheme: str = "original"            # 'original' (clustered-node finite differences) | 'conservative' (finite volume)
    flow_model: str = "constant"        # 'constant' | 'volume_change'

    # ---- process layout and operation
    zones: List[int] = field(default_factory=lambda: [5, 4, 4, 3])        # columns per zone, in flow order
    ports: List[Port] = field(default_factory=lambda: classic_ports(5.71, 3.58, 1.32))
    open_loop: bool = False             # True: no recycle from the last zone back to zone I
    Q1: float = 6.85                    # zone I flow, mL/min (closed loop)
    step_time: float = 2.33333          # switching time t*, min

    # ---- columns
    length: float = 20.0                # packed length per column, cm
    radius: float = 0.47                # internal radius, cm  (area = pi r^2 = 0.694 cm2)
    dead_length: float = 2.0            # extra-column (dead) volume per column, expressed as tube length, cm
    dead_nodes: int = 8                 # grid points spanning the dead volume (Original mode)

    # ---- packing
    porosity_spec: str = "total"        # 'total' | 'split'
    porosity_total: float = 0.45        # total porosity (used when porosity_spec == 'total')
    bed_porosity: float = 0.387         # inter-particle void fraction eps_b
    particle_porosity: float = 0.461    # intra-particle porosity eps_p
    dispersion_spec: str = "peclet"     # 'peclet' | 'particle'
    peclet: float = 1000.0              # column Peclet number u L / D_ax
    particle_diameter: float = 100.0    # um, used when dispersion_spec == 'particle'
    particle_peclet: float = 0.5        # u d_p / D_ax for a packed bed (~0.5 at liquid-chromatography conditions)

    # ---- numerics
    nodes: int = 22                     # grid points per column (Original mode)
    cells: int = 20                     # finite volumes per packed column (Conservative mode)
    css_tol: float = 1e-5
    max_cycles: int = 150
    accelerate: bool = True

    # ================================================================ derived
    @property
    def n_columns(self) -> int:
        return int(sum(self.zones))

    @property
    def n_zones(self) -> int:
        return len(self.zones)

    @property
    def area(self) -> float:
        return math.pi * self.radius ** 2

    @property
    def porosity(self) -> float:
        """Total porosity eps_t = eps_b + (1 - eps_b) eps_p."""
        if self.porosity_spec == "split":
            return self.bed_porosity + (1 - self.bed_porosity) * self.particle_porosity
        return self.porosity_total

    @property
    def peclet_eff(self) -> float:
        """Column Peclet number used by the model (Pe = Pe_p * L / d_p when derived from particle size)."""
        if self.dispersion_spec == "particle":
            return self.particle_peclet * self.length / (self.particle_diameter * 1e-4)
        return self.peclet

    def zone_start(self, z: int) -> int:
        """Index of the first column of zone z (= junction where its ports act)."""
        return int(sum(self.zones[:z])) % max(1, self.n_columns)

    def flow_plan(self):
        """Junction additions/withdrawals and the balance port, for the constant-flow network.

        Returns dict with A[j] (inlet flow at junction j), W[j] (fixed outlet flow at junction j),
        jb (balance junction), Q1 (zone I flow actually used), QB (balance flow), zone_flows.
        """
        n = self.n_columns
        A = [0.0] * n
        W = [0.0] * n
        jb = None
        for p in self.ports:
            j = self.zone_start(p.zone)
            if p.kind in INLET_KINDS:
                A[j] += p.flow
            elif p.balance:
                jb = j
            else:
                W[j] += p.flow
        D = [A[j] - W[j] for j in range(n)]
        if self.open_loop:
            Q1 = A[0]
        else:
            Q1 = self.Q1
        # column inlet flows with zero balance flow
        Fin = [0.0] * n
        f = Q1
        for j in range(n):
            Fin[j] = f
            f = f + D[(j + 1) % n]
        if jb is None:
            QB = float("nan")
        elif self.open_loop:
            QB = Fin[n - 1] - W[0]
        else:
            QB = f - Q1
            if jb > 0:
                for j in range(jb, n):
                    Fin[j] -= QB
        zone_flows = [Fin[self.zone_start(z)] for z in range(self.n_zones)]
        return {"A": A, "W": W, "jb": jb, "Q1": Q1, "QB": QB, "Fin": Fin, "zone_flows": zone_flows}

    @property
    def zone_flows(self):
        return self.flow_plan()["zone_flows"]

    def port_flows(self):
        """Flow of every port in the order of self.ports (balance flow computed)."""
        QB = self.flow_plan()["QB"]
        return [QB if (p.balance and p.kind not in INLET_KINDS) else p.flow for p in self.ports]

    def total_flow(self, kind):
        return sum(f for p, f in zip(self.ports, self.port_flows()) if p.kind == kind)

    def port_labels(self):
        """Short labels D, F, E, R (numbered when a kind appears more than once)."""
        letter = {"desorbent": "D", "feed": "F", "extract": "E", "raffinate": "R"}
        count = {k: sum(1 for p in self.ports if p.kind == k) for k in PORT_KINDS}
        seen, out = {}, []
        for p in self.ports:
            seen[p.kind] = seen.get(p.kind, 0) + 1
            out.append(letter[p.kind] + (str(seen[p.kind]) if count[p.kind] > 1 else ""))
        return out

    def derived(self) -> dict:
        """Quantities shown in the setup panel."""
        plan = self.flow_plan()
        V = self.length * self.area
        eps = self.porosity
        Vd = self.dead_length * self.area
        zf = plan["zone_flows"]
        m = [(q * self.step_time - eps * V) / ((1 - eps) * V) for q in zf]
        md = [(q * self.step_time - eps * V - Vd) / ((1 - eps) * V) for q in zf]
        u = [q / (self.area * eps) for q in zf]                         # cm/min, total-porosity velocity
        pe = self.peclet_eff
        dax = [ui * self.length / pe for ui in u]
        QD, QF = self.total_flow("desorbent"), self.total_flow("feed")
        return {
            "n_columns": self.n_columns, "area": self.area, "porosity": eps, "peclet": pe,
            "zone_flows": zf, "m_values": m, "m_values_dead": md, "velocity": u, "dispersion": dax,
            "balance_flow": plan["QB"], "Q1": plan["Q1"], "port_flows": self.port_flows(),
            "port_labels": self.port_labels(),
            "desorbent_to_feed": QD / QF if QF > 0 else None,
            "bed_volume": self.n_columns * V, "column_volume": V, "pore_volume": eps * V,
            "dead_volume": Vd, "cycle_time": self.n_columns * self.step_time,
        }

    # ============================================================= validation
    def validate(self) -> List[str]:
        errs = []
        nz = self.n_zones
        if not 2 <= nz <= MAX_ZONES:
            errs.append(f"Use between 2 and {MAX_ZONES} zones.")
        if any(z < 1 for z in self.zones):
            errs.append("Each zone needs at least one column.")
        if self.n_columns > MAX_COLUMNS:
            errs.append(f"The unit can have at most {MAX_COLUMNS} columns (now {self.n_columns}).")
        if not 2 <= len(self.components) <= 10:
            errs.append("Use between 2 and 10 components.")
        if self.scheme not in SCHEMES:
            errs.append(f"Unknown scheme '{self.scheme}'.")
        if self.flow_model not in FLOW_MODELS:
            errs.append(f"Unknown flow model '{self.flow_model}'.")
        # ports
        if any(p.kind not in PORT_KINDS for p in self.ports):
            errs.append("Port type must be desorbent, feed, extract or raffinate.")
        if any(not 0 <= p.zone < nz for p in self.ports):
            errs.append("Every port must sit at the start of an existing zone.")
        kinds = [p.kind for p in self.ports]
        if "desorbent" not in kinds or "feed" not in kinds:
            errs.append("The unit needs at least one desorbent inlet and one feed inlet.")
        outlets = [p for p in self.ports if p.kind not in INLET_KINDS]
        if not outlets:
            errs.append("The unit needs at least one outlet (extract or raffinate).")
        nb = sum(1 for p in outlets if p.balance)
        if outlets and nb != 1:
            errs.append("Exactly one outlet must be the balance port (its flow is computed).")
        if self.open_loop and any(p.balance and p.zone != 0 for p in outlets):
            errs.append("In an open-loop unit the balance outlet must be at the end of the last zone.")
        if any(p.flow < 0 for p in self.ports if not p.balance):
            errs.append("Port flows cannot be negative.")
        if not errs and nz >= 2:
            plan = self.flow_plan()
            for i, q in enumerate(plan["zone_flows"]):
                if not q > 0:
                    errs.append(f"Zone {ROMAN[i]} flow is {q:.3g} mL/min; it must be positive.")
            if not plan["QB"] > 0:
                errs.append(f"The balance outlet flow is {plan['QB']:.3g} mL/min; it must be positive.")
            if min(plan["Fin"]) <= 0:
                errs.append("Some column has no flow; check the port flows.")
        # components
        if any(c.role not in ROLES for c in self.components):
            errs.append("Component role must be extract, raffinate or desorbent.")
        if not any(c.role == "desorbent" for c in self.components):
            errs.append("At least one component must be the desorbent.")
        fsum = sum(c.feed_frac for c in self.components)
        dsum = sum(c.des_frac for c in self.components)
        if abs(fsum - 1) > 1e-3:
            errs.append(f"Feed volume fractions sum to {fsum:.4g}; they must sum to 1.")
        if abs(dsum - 1) > 1e-3:
            errs.append(f"Desorbent volume fractions sum to {dsum:.4g}; they must sum to 1.")
        for c in self.components:
            if c.rho <= 0 or c.kap <= 0 or c.qsat < 0 or c.keq < 0:
                errs.append(f"{c.name}: density and k must be positive; Qsat and K non-negative.")
        # columns and packing
        if self.length <= 0 or self.radius <= 0:
            errs.append("Column length and radius must be positive.")
        if not 0 < self.porosity < 1:
            errs.append("Total porosity must be between 0 and 1.")
        if self.porosity_spec == "split" and not (0 < self.bed_porosity < 1 and 0 <= self.particle_porosity < 1):
            errs.append("Bed void fraction must be in (0, 1) and particle porosity in [0, 1).")
        if not self.peclet_eff > 0:
            errs.append("Péclet number must be positive (check particle diameter and particle Péclet number).")
        if self.dead_length < 0:
            errs.append("Dead-volume length cannot be negative.")
        if self.step_time <= 0:
            errs.append("Switch time must be positive.")
        if self.scheme == "original" and self.dead_length > 0 and not 2 <= self.dead_nodes < self.nodes - 3:
            errs.append("Dead-volume nodes must be at least 2 and leave 4 or more nodes in the packed bed.")
        if self.nodes < 6 or self.cells < 4:
            errs.append("Grid too coarse (Original: at least 6 nodes; Conservative: at least 4 cells).")
        return errs

    # ========================================================= (de)serialise
    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SMBConfig":
        d = dict(d)
        comps = [Component(**c) for c in d.pop("components")]
        # ---- files written by version 1 (fixed 4-zone layout, area, total porosity)
        if "ports" not in d and "QD" in d:
            d["ports"] = classic_ports(d.pop("QD"), d.pop("QE"), d.pop("QF"))
        if "area" in d and "radius" not in d:
            d["radius"] = math.sqrt(float(d.pop("area")) / math.pi)
        if "porosity" in d and "porosity_total" not in d:
            d["porosity_total"] = d.pop("porosity")
            d.setdefault("porosity_spec", "total")
        ports = [p if isinstance(p, Port) else Port(**p) for p in d.pop("ports", [])] or classic_ports(5.71, 3.58, 1.32)
        known = set(cls.__dataclass_fields__)
        return cls(components=comps, ports=ports, **{k: v for k, v in d.items() if k in known})


# ================================================================== presets
CASE_AREA = 0.693978                         # cm2, column cross-section of the test cases
CASE_RADIUS = math.sqrt(CASE_AREA / math.pi)


def case_1(**overrides) -> SMBConfig:
    """Case 1: three components (Wanted / Unwanted / Solvent), 16 columns in a 5-4-4-3 layout."""
    comps = [
        Component("Unwanted", "raffinate", qsat=0.493346, keq=11.6578, kap=1.0, rho=0.810, feed_frac=0.865),
        Component("Wanted", "extract", qsat=0.395771, keq=70.8559, kap=1.0, rho=0.903, feed_frac=0.135),
        Component("Solvent", "desorbent", qsat=0.327696, keq=79.24, kap=1.0, rho=0.902, des_frac=1.0),
    ]
    cfg = SMBConfig(components=comps, radius=CASE_RADIUS)
    return _apply(cfg, overrides)


def case_2(**overrides) -> SMBConfig:
    """Case 2: seven components, 16 columns in a 3-7-4-2 layout.

    Three wanted components go to the extract, three unwanted to the raffinate, with a
    single-component solvent as desorbent.  The total porosity is built from the bed void
    fraction and the particle porosity.
    """
    comps = [
        Component("Unwanted 1", "raffinate", qsat=0.401296, keq=1118.76, kap=4.0, rho=0.651, feed_frac=0.20),
        Component("Wanted 1", "extract", qsat=0.412099, keq=1420.32, kap=4.0, rho=0.733, feed_frac=0.20),
        Component("Solvent", "desorbent", qsat=0.347847, keq=1236.21, kap=4.0, rho=0.645, des_frac=1.0),
        Component("Wanted 2", "extract", qsat=0.52927, keq=1078.88, kap=4.0, rho=0.766, feed_frac=0.03),
        Component("Wanted 3", "extract", qsat=0.54785, keq=1119.52, kap=4.0, rho=0.908, feed_frac=0.07),
        Component("Unwanted 2", "raffinate", qsat=0.3221, keq=1376.6, kap=4.0, rho=0.588, feed_frac=0.20),
        Component("Unwanted 3", "raffinate", qsat=0.517374, keq=919.522, kap=4.0, rho=0.784, feed_frac=0.30),
    ]
    cfg = SMBConfig(components=comps, zones=[3, 7, 4, 2], ports=classic_ports(2.14, 0.721, 0.24),
                    Q1=6.96, step_time=1.893, radius=CASE_RADIUS, dead_length=0.0, nodes=15,
                    porosity_spec="split", bed_porosity=0.387, particle_porosity=0.461)
    return _apply(cfg, overrides)


CASE_3_OPERATION = dict(flow_model="volume_change", Q1=6.971362, QD=1.64, QE=0.880286, QF=0.387384,
                        step_time=1.92165)


def case_3(**overrides) -> SMBConfig:
    """Case 3: the Case 2 system at a different operating point (flows and switch time), volume change."""
    return case_2(**{**CASE_3_OPERATION, **overrides})


default_case = case_1


def _apply(cfg, overrides):
    for k, v in overrides.items():
        if k in ("QD", "QE", "QF"):
            kind = {"QD": "desorbent", "QE": "extract", "QF": "feed"}[k]
            for p in cfg.ports:
                if p.kind == kind:
                    p.flow = v
        else:
            setattr(cfg, k, v)
    return cfg


PRESETS = {
    "case1": ("Case 1 · 3 components", "Wanted / Unwanted / Solvent · 16 columns, 4 zones (5-4-4-3)"),
    "case2": ("Case 2 · 7 components", "3 wanted, 3 unwanted, solvent · 16 columns, 4 zones (3-7-4-2)"),
    "case3": ("Case 3 · 7 components, second operating point", "Case 2 system with other flows and switch time · volume change"),
}
_CASES = {"case1": case_1, "case2": case_2, "case3": case_3}


def preset(name: str) -> SMBConfig:
    return _CASES.get(name, case_1)()
