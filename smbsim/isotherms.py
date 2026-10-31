"""Adsorption equilibrium models.

Every model is a function ``qeq(C, params) -> Q*`` working on arrays shaped
(n_components, ...).  Register new models in ``ISOTHERMS`` and they show up in
the web interface automatically.
"""
import numpy as np


def competitive_langmuir(C, p):
    """Q*_i = Qsat_i K_i C_i / (1 + sum_n K_n C_n)"""
    denom = 1.0 + np.sum(p["keq"] * C, axis=0, keepdims=True)
    return p["qsat"] * p["keq"] * C / denom


ISOTHERMS = {
    "competitive_langmuir": {
        "label": "Competitive Langmuir",
        "equation": "q*ᵢ = Qsatᵢ·Kᵢ·Cᵢ / (1 + Σₙ Kₙ·Cₙ)",
        "params": ["qsat", "keq"],
        "fn": competitive_langmuir,
    },
}
