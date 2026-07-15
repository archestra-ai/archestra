"""Deterministically (re)generate inputs/materials.json and expected/takeoff.json.

Run with `uv run generate.py`. Re-running produces byte-identical output: all randomness is
seeded with a fixed constant and no wall-clock time is read. The expected takeoff is computed by the
same DETERMINISTIC RULES the verifier recomputes from, so expected/ is a cross-check, not the source
of truth.
"""

import json
import random
from pathlib import Path

SEED = 20260623
HERE = Path(__file__).resolve().parent

TRADES = ["Concrete", "Masonry", "Structural Steel", "Drywall", "Electrical"]
LEVELS = ["L01", "L02", "L03", "Roof"]
UNITS = ["SF", "CY", "EA", "LF"]


def parse_quantity(quantity: str) -> float:
    return float(quantity.replace(",", ""))


def _qty_string(rng: random.Random) -> str:
    value = rng.randint(50, 9999)
    return f"{value:,}" if value >= 1000 and rng.random() < 0.7 else str(value)


def build_materials() -> list[dict]:
    rng = random.Random(SEED)
    descriptions = {
        "Concrete": ["Slab on grade", "Footings", "Grade beams", "Topping slab"],
        "Masonry": ["CMU partition", "Brick veneer", "Block backup wall"],
        "Structural Steel": ["W-shape columns", "Roof joists", "Beam framing"],
        "Drywall": ["Type X gyp board", "Shaft wall assembly", "Ceiling board"],
        "Electrical": ["Branch wiring", "Panelboards", "Light fixtures", "Conduit runs"],
    }

    items: list[dict] = []
    for idx in range(20):
        trade = TRADES[idx % len(TRADES)]
        item = {
            "material_id": f"M-{idx + 1:03d}",
            "trade": trade,
            "level": rng.choice(LEVELS),
            "description": rng.choice(descriptions[trade]),
            "quantity": _qty_string(rng),
            "unit": rng.choice(UNITS),
            "unit_cost": round(rng.uniform(2.5, 480.0), 2),
            "spec_section": f"{rng.choice(['03', '04', '05', '09', '26'])} {rng.randint(10, 90):02d} 00",
        }
        items.append(item)

    # 3-4 items with missing spec (null or empty/whitespace); these still count toward cost totals.
    items[3]["spec_section"] = None
    items[8]["spec_section"] = ""
    items[14]["spec_section"] = None
    items[17]["spec_section"] = "   "

    # Exactly one voided line, excluded from all totals and the missing-spec list. It is ALSO blank on
    # spec_section, so a solver that collects missing-spec lines without first dropping voided ones
    # would wrongly include it (M-012) and fail.
    items[11]["status"] = "void"
    items[11]["spec_section"] = None

    return items


def compute_takeoff(materials: list[dict]) -> dict:
    totals_by_trade: dict[str, float] = {}
    totals_by_level: dict[str, float] = {}
    missing_spec_material_ids: list[str] = []
    grand_total_cost = 0.0

    for item in materials:
        if item.get("status") == "void":
            continue
        line_cost = parse_quantity(item["quantity"]) * item["unit_cost"]
        totals_by_trade[item["trade"]] = totals_by_trade.get(item["trade"], 0.0) + line_cost
        totals_by_level[item["level"]] = totals_by_level.get(item["level"], 0.0) + line_cost
        grand_total_cost += line_cost
        spec = item["spec_section"]
        if spec is None or not str(spec).strip():
            missing_spec_material_ids.append(item["material_id"])

    return {
        "totals_by_trade": totals_by_trade,
        "totals_by_level": totals_by_level,
        "missing_spec_material_ids": sorted(missing_spec_material_ids),
        "grand_total_cost": round(grand_total_cost, 2),
    }


def main() -> None:
    materials = build_materials()
    takeoff = compute_takeoff(materials)

    (HERE / "inputs" / "materials.json").write_text(
        json.dumps(materials, indent=2) + "\n", encoding="utf-8"
    )
    (HERE / "expected" / "takeoff.json").write_text(
        json.dumps(takeoff, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"grand_total_cost = {takeoff['grand_total_cost']}")
    print(f"missing_spec_material_ids = {takeoff['missing_spec_material_ids']}")
    print(f"trades = {sorted(takeoff['totals_by_trade'])}")
    print(f"levels = {sorted(takeoff['totals_by_level'])}")


if __name__ == "__main__":
    main()
