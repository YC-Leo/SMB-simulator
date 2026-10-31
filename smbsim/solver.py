"""
SMB simulator with two numerical schemes.

Physics (per column, component i):
    liquid :  dC/dt + 1/(A*eps) * d(F*C)/dx = D d2C/dx2 - (1-eps)/eps * dq/dt,   D = u L / Pe
    solid  :  dq/dt = k (q* - q),     q* from the selected isotherm
    flow   :  constant, or  dF/dx = -A(1-eps) * sum_i (dq_i/dt)/rho_i   (volume change)
    ports  :  mixing balance at every column inlet; outlets withdraw liquid leaving the previous column

eps is the total porosity, A the column cross-section (pi r^2) and Pe the column Peclet number.

Schemes
-------
original      Finite differences on a node grid whose first points are clustered over
              the dead-volume length at each column inlet: central differences, an
              inlet node set by the mixing balance, flow from the source/drain balance.
              The dead volume shapes the grid only; it is not modelled as open volume.
conservative  Finite-volume scheme (MUSCL / van Leer, Danckwerts inlet) in flux
              form, so component mass balances cell by cell.  The dead volume is
              modelled physically as an unpacked tube section (porosity 1, no
              adsorbent) at the inlet of every column.

Both schemes are integrated in time with SSP-RK3.  The state is stored in the frame of the
ports (column 0 = first column of zone I); after every switching period the columns are
re-indexed by one (np.roll), i.e. the condition C_end[j] = C_0[j-1].  Switching is
repeated from a unit full of desorbent until cyclic steady state (CSS).
"""
from __future__ import annotations

import math
import time
import numpy as np

from .config import SMBConfig, INLET_KINDS, ROMAN
from .isotherms import ISOTHERMS


ORIG_CFL = 0.9      # Courant number (based on the smallest node spacing) for the original scheme


def _vanleer(r):
    return (r + np.abs(r)) / (1.0 + np.abs(r))


class Cancelled(Exception):
    pass


class Simulator:
    def __init__(self, cfg: SMBConfig):
        errs = cfg.validate()
        if errs:
            raise ValueError("\n".join(errs))
        self.cfg = cfg
        comps = cfg.components
        self.nc = len(comps)
        col = lambda a: np.array(a, float)[:, None, None]
        self.par = {"qsat": col([c.qsat for c in comps]), "keq": col([c.keq for c in comps])}
        self.qeq_fn = ISOTHERMS[cfg.isotherm]["fn"]
        self.kap = col([c.kap for c in comps])
        self.rho = col([c.rho for c in comps])
        self.cF = np.array([c.feed_frac * c.rho for c in comps])
        self.cD = np.array([c.des_frac * c.rho for c in comps])
        self.n = n = cfg.n_columns
        self.eps = cfg.porosity
        self.area = cfg.area
        self.pe = cfg.peclet_eff

        # ---------------- flow network from the port list
        plan = cfg.flow_plan()
        self.A_in = np.array(plan["A"])          # inlet flow added at junction j (before column j)
        self.W_fix = np.array(plan["W"])         # fixed outlet flow withdrawn at junction j
        self.jb = plan["jb"]                     # junction of the balance outlet
        self.Q1 = plan["Q1"]
        self.open = cfg.open_loop
        self.D_next = np.roll(self.A_in - self.W_fix, -1)   # change in flow entering column j+1
        self.c_add = np.zeros((self.nc, n))
        self.labels = cfg.port_labels()
        self.outs = []                           # (port index, junction, source column, fixed flow or None)
        for k, p in enumerate(cfg.ports):
            j = cfg.zone_start(p.zone)
            if p.kind == "desorbent":
                self.c_add[:, j] += self.cD * p.flow
            elif p.kind == "feed":
                self.c_add[:, j] += self.cF * p.flow
            else:
                self.outs.append((k, j, (j - 1) % n, None if p.balance else p.flow))
        self.out_src = np.array([o[2] for o in self.outs])
        self.out_fixed = np.array([o[3] if o[3] is not None else 0.0 for o in self.outs])
        self.out_isbal = np.array([o[3] is None for o in self.outs])
        self.prev = np.roll(np.arange(n), 1)

        self.vc = cfg.flow_model == "volume_change"
        self.phi = (1 - self.eps) / self.eps
        self.pitch = cfg.length + cfg.dead_length
        self.Fmax = 1.3 * max(plan["zone_flows"])
        if cfg.scheme == "original":
            self._setup_original()
        else:
            self._setup_conservative()
        self.Fin_const, self.QB_const = self.network(np.zeros(n))

    # ------------------------------------------------------------ flow network
    def network(self, dF):
        """Column inlet flows and the balance-outlet flow, given the flow change across each column."""
        n = self.n
        Fin = self.Q1 + np.concatenate([[0.0], np.cumsum(dF[:-1] + self.D_next[:-1])])
        if self.open:
            QB = Fin[-1] + dF[-1] - self.W_fix[0]          # everything reaching the end leaves
        else:
            wrap = Fin[-1] + dF[-1] + self.D_next[-1]      # flow that would re-enter zone I
            QB = wrap - self.Q1
            if self.jb:                                     # balance withdrawn before column jb
                Fin = Fin.copy(); Fin[self.jb:] -= QB
        return Fin, QB

    def qeq(self, C):
        return self.qeq_fn(C, self.par)

    def mix_inlet(self, Cout, Fin):
        """Column inlet concentration: liquid passed on from the previous column plus inlet ports."""
        pass_flow = Fin - self.A_in
        return (Cout[:, self.prev] * pass_flow + self.c_add) / Fin

    def outlet_rates(self, Cout, QB):
        """Mass flow (g/min) of every component in every outlet port, shape (n_out, nc)."""
        flows = np.where(self.out_isbal, QB, self.out_fixed)
        return Cout[:, self.out_src].T * flows[:, None]

    # ---------------------------------------------------------- original scheme
    def _setup_original(self):
        cfg = self.cfg
        NF, L, Ld = cfg.nodes, cfg.length, cfg.dead_length
        if Ld > 0:
            ns = cfg.dead_nodes
            HX = np.r_[0.0, [Ld / (L + Ld) / (ns - 1)] * (ns - 1), [L / (L + Ld) / (NF - ns)] * (NF - ns)]
        else:
            HX = np.r_[0.0, [1.0 / (NF - 1)] * (NF - 1)]
        self.h = HX * L                      # node spacing used by the difference formulas (scaled by L)
        self.ncell = NF
        self.xcol = np.cumsum(HX) * self.pitch  # node positions for display
        # flow from the source/drain balance: F[m+1]-F[m-1] = 2 h_m s_m ; 3F_N - 4F_N-1 + F_N-2 = (h_N + h_N-1) s_N
        K = NF - 1
        A = np.zeros((K, K)); B = np.zeros((K, NF))
        for m in range(1, NF - 1):
            if m + 1 <= K: A[m - 1, m + 1 - 1] += 1
            if m - 1 >= 1: A[m - 1, m - 1 - 1] -= 1
            B[m - 1, m] = 2 * self.h[m]
        A[K - 1, NF - 1 - 1] += 3; A[K - 1, NF - 2 - 1] -= 4; A[K - 1, NF - 3 - 1] += 1
        B[K - 1, NF - 1] = self.h[NF - 1] + self.h[NF - 2]
        M = np.zeros((NF, NF)); M[1:] = np.linalg.solve(A, B)
        self.Mflow = M
        hmin = self.h[1:].min()
        umax = self.Fmax / (self.area * self.eps)
        self.nsub = int(math.ceil(cfg.step_time / (ORIG_CFL * hmin / umax)))
        self.rhs = self._rhs_original

    def _rhs_original(self, C, Q):
        A, eb, L, h = self.area, self.eps, self.cfg.length, self.h
        dQt = self.kap * (self.qeq(C[:, :, 1:]) - Q[:, :, 1:])
        if self.vc:
            s = np.zeros((self.n, self.ncell))
            s[:, 1:] = -A * (1 - eb) * np.sum(dQt / self.rho, axis=0)
            G = s @ self.Mflow.T
            Fin, QB = self.network(G[:, -1])
            Fn = Fin[:, None] + G
        else:
            Fin, QB = self.Fin_const, self.QB_const
            Fn = np.broadcast_to(Fin[:, None], (self.n, self.ncell))
        Cin = self.mix_inlet(C[:, :, -1], Fin)
        C = C.copy(); C[:, :, 0] = Cin
        dQ = np.empty_like(Q)
        dQ[:, :, 1:] = dQt
        dQ[:, :, 0] = self.kap[:, :, 0] * (self.qeq(Cin[:, :, None])[:, :, 0] - Q[:, :, 0])
        d1 = np.empty_like(C); d2 = np.empty_like(C)
        hi = h[1:-1]
        d1[:, :, 1:-1] = (C[:, :, 2:] - C[:, :, :-2]) / (2 * hi)
        d2[:, :, 1:-1] = (C[:, :, 2:] - 2 * C[:, :, 1:-1] + C[:, :, :-2]) / hi ** 2
        hN = h[-1]
        d1[:, :, -1] = (3 * C[:, :, -1] - 4 * C[:, :, -2] + C[:, :, -3]) / (2 * hN)
        d2[:, :, -1] = (2 * C[:, :, -1] - 5 * C[:, :, -2] + 4 * C[:, :, -3] - C[:, :, -4]) / hN ** 2
        u = Fn / (A * eb)
        dC = -u * d1 + u * (L / self.pe) * d2 - self.phi * dQ
        if self.vc:
            dC -= C * (s / (A * eb))
        dC[:, :, 0] = 0.0
        return dC, dQ, self.outlet_rates(C[:, :, -1], QB), QB, Fn

    # ------------------------------------------------------- conservative scheme
    def _setup_conservative(self):
        cfg = self.cfg
        N, L, Ld = cfg.cells, cfg.length, cfg.dead_length
        nd = max(2, int(math.ceil(Ld / (L / N)))) if Ld > 0 else 0
        self.dx = np.r_[[Ld / nd] * nd, [L / N] * N] if nd else np.full(N, L / N)
        self.ebc = np.r_[[1.0] * nd, [self.eps] * N]
        self.solid = np.r_[[0.0] * nd, [1.0] * N]
        self.ncell = nd + N
        self.dxc = 0.5 * (self.dx[1:] + self.dx[:-1])
        self.vol = self.area * self.ebc * self.dx
        self.phic = (1 - self.ebc) / self.ebc
        self.xcol = np.cumsum(self.dx) - 0.5 * self.dx
        dt = 0.4 * (self.vol / self.Fmax).min()
        Dmax = self.Fmax * L / self.pe / (self.area * self.ebc.min())
        dt = min(dt, 0.3 * self.dx.min() ** 2 / Dmax)
        self.nsub = int(math.ceil(cfg.step_time / dt))
        self.rhs = self._rhs_conservative

    def _rhs_conservative(self, C, Q):
        L = self.cfg.length
        dQ = self.kap * (self.qeq(C) - Q) * self.solid
        if self.vc:
            dFc = -self.area * (1 - self.ebc) * self.dx * np.sum(dQ / self.rho, axis=0)
            Fin, QB = self.network(dFc.sum(axis=1))
            Ff = np.concatenate([Fin[:, None], Fin[:, None] + np.cumsum(dFc, axis=1)], axis=1)
        else:
            Fin, QB = self.Fin_const, self.QB_const
            Ff = np.broadcast_to(Fin[:, None], (self.n, self.ncell + 1))
        Cin = self.mix_inlet(C[:, :, -1], Fin)
        dp = np.diff(C, axis=2)
        dm = C[:, :, :-1] - np.concatenate([Cin[:, :, None], C[:, :, :-2]], axis=2)
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.where(np.abs(dp) > 1e-14, dm / dp, 0.0)
        Cf = C[:, :, :-1] + 0.5 * _vanleer(r) * dp
        flux = np.empty((self.nc, self.n, self.ncell + 1))
        flux[:, :, 0] = Fin * Cin
        flux[:, :, 1:-1] = Ff[:, 1:-1] * (Cf - (L / self.pe) * dp / self.dxc)
        flux[:, :, -1] = Ff[:, -1] * C[:, :, -1]
        dC = -(flux[:, :, 1:] - flux[:, :, :-1]) / self.vol - self.phic * dQ
        return dC, dQ, self.outlet_rates(C[:, :, -1], QB), QB, Ff

    # ----------------------------------------------------------------- driving
    def initial_state(self):
        shape = (self.nc, self.n, self.ncell)
        C = np.broadcast_to(self.cD[:, None, None], shape).copy()
        Q = self.qeq(C)
        if self.cfg.scheme == "conservative":
            Q = Q * self.solid
        return C, Q

    def advance(self, C, Q, record=False, n_frames=30, n_hist=120):
        """Integrate one switching period (SSP-RK3); returns outlet masses per port."""
        dt = self.cfg.step_time / self.nsub
        out = np.zeros((len(self.outs), self.nc)); qb = 0.0
        frames, hist = [], []
        fstep = max(1, self.nsub // (n_frames - 1)); hstep = max(1, self.nsub // n_hist)
        w = (1 / 6, 1 / 6, 2 / 3)
        for k in range(self.nsub):
            k1 = self.rhs(C, Q)
            if record and k % fstep == 0:
                frames.append(self._snapshot(C, Q, k * dt, k1))
            if record and k % hstep == 0:
                hist.append(self._outlets(C, k * dt, k1))
            C1 = C + dt * k1[0]; Q1 = Q + dt * k1[1]
            k2 = self.rhs(C1, Q1)
            C2 = 0.75 * C + 0.25 * (C1 + dt * k2[0]); Q2 = 0.75 * Q + 0.25 * (Q1 + dt * k2[1])
            k3 = self.rhs(C2, Q2)
            C = C / 3 + 2 / 3 * (C2 + dt * k3[0]); Q = Q / 3 + 2 / 3 * (Q2 + dt * k3[1])
            for wk, kk in zip(w, (k1, k2, k3)):
                out += dt * wk * kk[2]; qb += dt * wk * kk[3]
        if record:
            kf = self.rhs(C, Q)
            frames.append(self._snapshot(C, Q, self.cfg.step_time, kf))
            hist.append(self._outlets(C, self.cfg.step_time, kf))
        return C, Q, out, qb / self.cfg.step_time, frames, hist

    def _display_C(self, C, k):
        if self.cfg.scheme == "original":
            C = C.copy()
            Fin = k[4][:, 0] if self.vc else self.Fin_const
            C[:, :, 0] = self.mix_inlet(C[:, :, -1], Fin)
        return C

    def _snapshot(self, C, Q, t, k):
        Cd = self._display_C(C, k)
        Fn = np.asarray(k[4])
        return {"t": t, "C": Cd.reshape(self.nc, -1), "Q": Q.reshape(self.nc, -1),
                "Fin": np.array(Fn[:, 0]),
                "QB": k[3]}

    def _outlets(self, C, t, k):
        return {"t": t, "C": C[:, self.out_src, -1].T.copy(), "QB": k[3]}

    def run(self, progress=None, cancel=None):
        cfg = self.cfg
        t0 = time.time()
        C, Q = self.initial_state()
        history = []
        converged, res = False, np.inf
        max_steps = cfg.max_cycles * self.n
        step = 0
        snaps, rho_prev = [], None
        for step in range(max_steps):
            if cancel is not None and cancel():
                raise Cancelled()
            C0, Q0 = C, Q
            C, Q, out, qb, _, _ = self.advance(C, Q)
            C_end, Q_end = C, Q
            C = np.roll(C, -1, axis=1); Q = np.roll(Q, -1, axis=1)      # switch: ports advance one column
            res = float(max(np.abs(C - C0).max(), np.abs(Q - Q0).max()))
            if not np.isfinite(res):
                raise FloatingPointError("The simulation became unstable. Try a finer grid or check the inputs.")
            converged = res < cfg.css_tol and step >= 2 * self.n
            if (step + 1) % self.n == 0 or converged:
                m = self.metrics(out, qb)
                history.append({"cycle": (step + 1) / self.n, "residual": res,
                                "extract_purity": m["extract_purity"], "raffinate_purity": m["raffinate_purity"],
                                "extract_recovery": m["extract_recovery"], "raffinate_recovery": m["raffinate_recovery"]})
                if progress:
                    progress({"cycle": (step + 1) / self.n, "residual": res, "history": history,
                              "profile": self._profile_payload(C_end, Q_end), "elapsed": time.time() - t0})
            if converged:
                break
            if cfg.accelerate and (step + 1) % self.n == 0:
                # cycle-to-cycle extrapolation towards CSS (the approach is close to geometric)
                snaps = (snaps + [np.concatenate([C.ravel(), Q.ravel()])])[-3:]
                if len(snaps) == 3:
                    d1, d2 = snaps[1] - snaps[0], snaps[2] - snaps[1]
                    rho = float(d2 @ d1 / max(d1 @ d1, 1e-300))
                    if rho_prev is not None and 0.3 < rho < 0.985 and abs(rho - rho_prev) < 0.03:
                        x = snaps[2] + d2 * min(rho / (1 - rho), 25.0)
                        x = np.maximum(x, 0.0)
                        C = x[:C.size].reshape(C.shape); Q = x[C.size:].reshape(Q.shape)
                        snaps, rho_prev = [], None
                    else:
                        rho_prev = rho
        # one more period at CSS, recording frames and outlet histories
        C, Q, out, qb, frames, hist = self.advance(C, Q, record=True)
        return self._result(out, qb, frames, hist, history, converged, res, step + 2, time.time() - t0)

    # ------------------------------------------------------------- reporting
    def positions(self):
        return (np.arange(self.n)[:, None] * self.pitch + self.xcol[None, :]).ravel()

    def _profile_payload(self, C, Q):
        Cd = self._display_C(C, self.rhs(C, Q))
        return {"x": self.positions(), "C": Cd.reshape(self.nc, -1)}

    def metrics(self, out, qb):
        """Purity and recovery from the outlet masses collected over one switch."""
        cfg = self.cfg
        roles = np.array([c.role for c in cfg.components])
        T = cfg.step_time
        fed = (self.cF * cfg.total_flow("feed") + self.cD * cfg.total_flow("desorbent")) * T
        kinds = [cfg.ports[o[0]].kind for o in self.outs]
        ext = sum((out[i] for i, k in enumerate(kinds) if k == "extract"), np.zeros(self.nc))
        raf = sum((out[i] for i, k in enumerate(kinds) if k == "raffinate"), np.zeros(self.nc))
        nondes = roles != "desorbent"

        def grp(mass, role):
            tot = mass[nondes].sum()
            sel = roles == role
            pur = 100 * mass[sel].sum() / tot if tot > 0 else float("nan")
            rec = 100 * mass[sel].sum() / fed[sel].sum() if fed[sel].sum() > 0 else float("nan")
            return pur, rec
        ep, er = grp(ext, "extract")
        rp, rr = grp(raf, "raffinate")
        V = cfg.length * cfg.area
        eps = cfg.porosity
        zf = cfg.zone_flows
        m_vals = [(q * T - eps * V) / ((1 - eps) * V) for q in zf]
        e_nd, r_nd = ext[nondes].sum(), raf[nondes].sum()
        tot_out = out.sum(axis=0)
        per = []
        for i, c in enumerate(cfg.components):
            per.append({"name": c.name, "role": c.role,
                        "extract_purity": 100 * ext[i] / e_nd if nondes[i] and e_nd > 0 else None,
                        "raffinate_purity": 100 * raf[i] / r_nd if nondes[i] and r_nd > 0 else None,
                        "to_extract": 100 * ext[i] / fed[i] if fed[i] > 0 else None,
                        "to_raffinate": 100 * raf[i] / fed[i] if fed[i] > 0 else None,
                        "closure": 100 * tot_out[i] / fed[i] if fed[i] > 0 else None,
                        "extract_mass_frac": 100 * ext[i] / ext.sum() if ext.sum() > 0 else None,
                        "raffinate_mass_frac": 100 * raf[i] / raf.sum() if raf.sum() > 0 else None})
        streams = []
        for (k, j, src, fixed), mass in zip(self.outs, out):
            p = cfg.ports[k]
            flow = qb if fixed is None else fixed
            tot, tnd = mass.sum(), mass[nondes].sum()
            streams.append({"label": self.labels[k], "kind": p.kind, "flow": flow, "balance": fixed is None,
                            "mass": mass,
                            "composition": [100 * mass[i] / tnd if nondes[i] and tnd > 0 else None for i in range(self.nc)],
                            "product_fraction": 100 * tnd / tot if tot > 0 else None,
                            "recovery": [100 * mass[i] / fed[i] if fed[i] > 0 else None for i in range(self.nc)]})
        QF = cfg.total_flow("feed")
        return {"extract_purity": ep, "extract_recovery": er,
                "raffinate_purity": rp, "raffinate_recovery": rr,
                "balance_flow": qb, "desorbent_to_feed": cfg.total_flow("desorbent") / QF if QF > 0 else None,
                "productivity": 60 * QF / (self.n * V),          # mL feed per mL bed per hour
                "m_values": m_vals, "components": per, "streams": streams}

    def port_info(self):
        cfg = self.cfg
        flows = cfg.port_flows()
        return [{"label": lab, "kind": p.kind, "zone": p.zone, "junction": cfg.zone_start(p.zone),
                 "flow": f, "balance": bool(p.balance and p.kind not in INLET_KINDS)}
                for lab, p, f in zip(self.labels, cfg.ports, flows)]

    def _result(self, out, qb, frames, hist, history, converged, res, steps, elapsed):
        cfg = self.cfg
        m = self.metrics(out, qb)
        x = self.positions()
        last = frames[-1]
        vol = (last["C"] / self.rho[:, :, 0]).sum(axis=0)
        m["volume_closure_max_dev"] = float(np.abs(vol - 1).max())
        closures = [c["closure"] for c in m["components"] if c["closure"] is not None]
        m["mass_closure_max_dev"] = float(max(abs(c - 100) for c in closures)) if closures else 0.0
        return {
            "converged": bool(converged), "residual": res, "steps": steps,
            "cycles": steps / self.n, "elapsed": elapsed, "substeps_per_period": self.nsub,
            "metrics": m, "history": history,
            "x": x, "column_pitch": self.pitch, "cells_per_column": self.ncell,
            "frames": frames, "outlets": hist,
            "outlet_labels": [self.labels[o[0]] for o in self.outs],
            "outlet_kinds": [cfg.ports[o[0]].kind for o in self.outs],
            "volume_sum": vol,
            "ports": self.port_info(), "zones": list(cfg.zones), "zone_names": ROMAN[:cfg.n_zones],
            "zone_flows": cfg.zone_flows, "derived": cfg.derived(),
            "config": cfg.to_dict(),
        }


def run(cfg: SMBConfig, progress=None, cancel=None) -> dict:
    return Simulator(cfg).run(progress=progress, cancel=cancel)
