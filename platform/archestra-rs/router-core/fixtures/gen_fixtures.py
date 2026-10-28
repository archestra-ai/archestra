# /// script
# requires-python = ">=3.12"
# dependencies = ["numpy==2.3.4", "scikit-learn==1.7.2"]
# ///
"""Writes parity.json: fully synthetic router-core inputs and reference outputs.

Run from this directory: `uv run gen_fixtures.py`. Reference fits use scikit-learn; the
policy is solved exactly (upper hull per session, breakpoints walked by descending λ).
"""

import json
import math
from pathlib import Path

import numpy as np
from sklearn.linear_model import LinearRegression, PoissonRegressor

SEED = 20261026
SESSIONS = 600
DAYS = 35
DAY_MS = 86_400_000
START_MS = 1_780_000_000_000
TOKEN_SCALE = 1e6
TOKEN_TYPES = ("input", "cache_read", "cache_write", "output")
BASELINE = "claude_main"
SOURCES = {"claude_main": 0.0, "claude_sub": -0.8, "codex_main": 0.3, "cursor_main": -0.4}
SOURCE_P = (0.45, 0.25, 0.2, 0.1)
# weakest adequate tier, in twentieths: few distinct values so sessions tie at λ*
TIER_NEEDED = ((14, 4, 2), (10, 6, 4), (6, 8, 6), (4, 6, 10), (2, 4, 14), (8, 8, 4), (2, 1, 17), (12, 1, 7))
# log-size effects of tier_needed normal and smart (fast is the reference level)
TIER_EFFECT = (0.8, -0.5)
BASE_MIX = (0.05, 0.80, 0.08, 0.07)
THRESHOLD = 100_000
# inverse inclusion weights: observed sessions count once, sampled history for several
WEIGHTS = (1.0, 1.0, 2.5)


def prices(input_usd: float) -> dict[str, float]:
    return dict(zip(TOKEN_TYPES, (input_usd, input_usd / 10, input_usd * 1.25, input_usd * 5)))


TIERS = [
    {"model_id": "synthetic-fast", "short": prices(1.0), "long": prices(5.0)},
    {"model_id": "synthetic-normal", "short": prices(3.0), "long": None},
    {"model_id": "synthetic-smart", "short": prices(15.0), "long": None},
]


def split(rng: np.random.Generator, tokens: float) -> dict[str, int]:
    mix = rng.dirichlet(200 * np.array(BASE_MIX))
    return dict(zip(TOKEN_TYPES, (int(v) for v in np.floor(tokens * mix))))


def history(rng: np.random.Generator) -> list[dict]:
    rows = []
    timestamps = np.sort(rng.integers(START_MS, START_MS + DAYS * DAY_MS, SESSIONS))
    for ts in timestamps:
        source = str(rng.choice(list(SOURCES), p=SOURCE_P))
        sub = source.endswith("_sub")
        p_long = int(rng.integers(0, 11)) / 10
        k = TIER_NEEDED[int(rng.integers(len(TIER_NEEDED)))]
        tier_effect = TIER_EFFECT[0] * k[1] / 20 + TIER_EFFECT[1] * k[2] / 20
        size = math.exp(math.log(3e5) + SOURCES[source] + 1.2 * p_long + tier_effect) * rng.lognormal(0, 0.6)
        share = float(np.clip(0.15 * math.log(size / 2e5) + 0.1 * sub - 0.05 + rng.normal(0, 0.05), 0, 0.95))
        rows.append({
            "features": {
                "tier_needed": [v / 20 for v in k],
                "p_long": p_long,
                "source": source,
            },
            "short": split(rng, (1 - share) * size),
            "long": split(rng, share * size),
            "timestamp_ms": int(ts),
        })
    weights = np.random.default_rng(SEED + 1).choice(WEIGHTS, len(rows))
    for row, weight in zip(rows, weights):
        row["weight"] = float(weight)
    return rows


def block_mix(blocks: list[dict], weights: np.ndarray) -> list[float]:
    sums = [sum(w * b[t] for b, w in zip(blocks, weights)) for t in TOKEN_TYPES]
    return [s / sum(sums) for s in sums]


def per_token(mix: list[float], p: dict[str, float]) -> float:
    return float(np.dot(mix, [p[t] for t in TOKEN_TYPES])) / TOKEN_SCALE


def hull(price: np.ndarray, adequacy: np.ndarray) -> tuple[list[int], list[float]]:
    n = len(price)
    kept = [
        t for t in range(n)
        if not any(
            s != t and price[s] <= price[t] and adequacy[s] >= adequacy[t]
            and (price[s] < price[t] or adequacy[s] > adequacy[t] or s < t)
            for s in range(n)
        )
    ]
    kept.sort(key=lambda t: price[t])

    def slope(a: int, b: int) -> float:
        return (adequacy[b] - adequacy[a]) / (price[b] - price[a])

    vertices: list[int] = []
    for t in kept:
        while len(vertices) >= 2 and slope(vertices[-2], vertices[-1]) <= slope(vertices[-1], t):
            vertices.pop()
        vertices.append(t)
    return vertices, [slope(a, b) for a, b in zip(vertices, vertices[1:])]


def main() -> None:
    rng = np.random.default_rng(SEED)
    rows = history(rng)
    features = [r["features"] for r in rows]
    total = np.array([sum(r["short"].values()) + sum(r["long"].values()) for r in rows], dtype=float)
    long_total = np.array([sum(r["long"].values()) for r in rows], dtype=float)
    p_long = np.array([f["p_long"] for f in features])
    tier_needed = np.array([f["tier_needed"] for f in features])
    w = np.array([r["weight"] for r in rows])

    others = sorted({f["source"] for f in features} - {BASELINE})
    x = np.column_stack(
        [*[[f["source"] == s for f in features] for s in others], p_long, tier_needed[:, 1], tier_needed[:, 2]]
    ).astype(float)
    glm = PoissonRegressor(alpha=1e-6, tol=1e-12, max_iter=10000, solver="newton-cholesky")
    glm.fit(x, total / TOKEN_SCALE, sample_weight=w)
    size = glm.predict(x) * TOKEN_SCALE

    ls_x = np.log(size)[:, None]
    ls = LinearRegression().fit(ls_x, long_total / total, sample_weight=total * w)
    share = np.clip(ls.predict(ls_x), 0.0, 1.0)

    mix_short, mix_long = block_mix([r["short"] for r in rows], w), block_mix([r["long"] for r in rows], w)
    short_pi = np.array([per_token(mix_short, t["short"]) for t in TIERS])
    long_pi = np.array([per_token(mix_long, t["long"] or t["short"]) for t in TIERS])
    pi = (1 - share)[:, None] * short_pi + share[:, None] * long_pi

    def adequacy(t: list[float]) -> np.ndarray:
        s = t[0] + t[1] + t[2]
        n = [v / s for v in t]
        return np.array([n[0], n[0] + n[1], n[0] + n[1] + n[2]])

    hulls = [hull(pi[i], adequacy(f["tier_needed"])) for i, f in enumerate(features)]

    tokens_per_day = float((w * total).sum()) / DAYS
    weight = tokens_per_day * w * size / (w * size).sum()
    cheapest = float(sum(weight[i] * pi[i, v[0]] for i, (v, _) in enumerate(hulls)))
    best = float(sum(weight[i] * pi[i, v[-1]] for i, (v, _) in enumerate(hulls)))
    budget = cheapest + 0.2 * (best - cheapest)

    steps = sorted(
        ((lam, weight[i] * (pi[i, v[j + 1]] - pi[i, v[j]])) for i, (v, lams) in enumerate(hulls)
         for j, lam in enumerate(lams)),
        key=lambda s: -s[0],
    )
    spend, lam_star, q, j = cheapest, 0.0, 0.0, 0
    while j < len(steps):
        k = j
        while k < len(steps) and steps[k][0] == steps[j][0]:
            k += 1
        cost = sum(c for _, c in steps[j:k])
        if spend + cost > budget:
            lam_star, q = steps[j][0], (budget - spend) / cost
            break
        spend += cost
        j = k

    expected_spend, routes = 0.0, []
    for i, (v, lams) in enumerate(hulls):
        base = v[0]
        tie = None
        for vertex, lam in zip(v[1:], lams):
            if lam > lam_star:
                base = vertex
            elif lam == lam_star:
                tie = vertex
        expected_spend += weight[i] * (pi[i, base] if tie is None else (1 - q) * pi[i, base] + q * pi[i, tie])
        if all(abs(lam - lam_star) >= 1e-6 * lam_star for lam in lams):
            routes.append({"session": i, "tier_index": base})

    fixture = {
        "input": {
            "history": rows,
            "tiers": {"tiers": TIERS, "long_context_threshold": THRESHOLD},
            "budget": budget,
            "volume": {"kind": "flat", "sessions_per_day": float(w.sum()) / DAYS, "tokens_per_day": tokens_per_day},
            "baseline_source": BASELINE,
        },
        "expected": {
            "size_intercept": float(glm.intercept_),
            "size_source_effects": dict(zip(others, map(float, glm.coef_[:-3]))),
            "size_p_long": float(glm.coef_[-3]),
            "size_p_normal": float(glm.coef_[-2]),
            "size_p_smart": float(glm.coef_[-1]),
            "long_share": {"intercept": float(ls.intercept_), "log_size": float(ls.coef_[0])},
            "policy": {"lam_star": float(lam_star), "q": float(q)},
            "expected_spend": float(expected_spend),
            "routes": routes,
        },
    }
    Path(__file__).with_name("parity.json").write_text(json.dumps(fixture, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
