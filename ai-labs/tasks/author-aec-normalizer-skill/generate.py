#!/usr/bin/env python3
"""Regenerate fixtures for the aec-normalizer task. Deterministic: re-running produces byte-identical
files. Run with `uv run generate.py` from the task root.

Two vendor exports with different shapes, plus the verifier-only expected normalization of vendor_v2.
The canonical "upload CSV" row has columns in this order: material_name, quantity, unit_cost_cents,
level. Normalization: trim the material name; strip commas from the quantity string and parse to int;
round dollars*100 to cents (int); uppercase the level/floor string.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# vendor_v1: flat keys mat / qty(str w/ commas) / cost_ea(dollars) / lvl, names padded with spaces.
VENDOR_V1 = [
    {"mat": "  2x4 Lumber  ", "qty": "1,200", "cost_ea": 3.45, "lvl": "l1"},
    {"mat": "Drywall Sheet", "qty": "850", "cost_ea": 12.99, "lvl": "l2"},
    {"mat": " Rebar #4 ", "qty": "2,400", "cost_ea": 0.87, "lvl": "l1"},
    {"mat": "Concrete Mix Bag", "qty": "3,000", "cost_ea": 6.5, "lvl": "roof"},
    {"mat": "  Roofing Shingle ", "qty": "12,500", "cost_ea": 1.15, "lvl": "roof"},
    {"mat": "Insulation Roll", "qty": "640", "cost_ea": 42.0, "lvl": "l3"},
    {"mat": " PVC Pipe 2in ", "qty": "1,050", "cost_ea": 7.33, "lvl": "l2"},
    {"mat": "Door Frame", "qty": "75", "cost_ea": 88.49, "lvl": "l1"},
    {"mat": "  Window Unit", "qty": "120", "cost_ea": 245.0, "lvl": "l3"},
]

# vendor_v2: renamed + nested shape. materialName / quantity(str w/ commas) / unitPrice(dollars) /
# location.floor. Different rows from v1.
VENDOR_V2 = [
    {"materialName": " Steel Beam W12 ", "quantity": "320", "unitPrice": 412.75, "location": {"floor": "L2"}},
    {"materialName": "Ceiling Tile", "quantity": "4,800", "unitPrice": 2.39, "location": {"floor": "l4"}},
    {"materialName": "  Floor Joist  ", "quantity": "1,150", "unitPrice": 18.6, "location": {"floor": "l1"}},
    {"materialName": "Anchor Bolt", "quantity": "9,200", "unitPrice": 0.42, "location": {"floor": "basement"}},
    {"materialName": " Glass Panel ", "quantity": "260", "unitPrice": 134.95, "location": {"floor": "L3"}},
    {"materialName": "HVAC Duct Section", "quantity": "540", "unitPrice": 56.0, "location": {"floor": "roof"}},
    {"materialName": "  Copper Wire 12AWG", "quantity": "7,750", "unitPrice": 0.19, "location": {"floor": "l2"}},
    {"materialName": "Fire Sprinkler Head", "quantity": "430", "unitPrice": 22.5, "location": {"floor": "l4"}},
    {"materialName": "Sheet Metal Flashing ", "quantity": "1,600", "unitPrice": 9.08, "location": {"floor": "roof"}},
    {"materialName": "Ductile Iron Fitting", "quantity": "88", "unitPrice": 71.3, "location": {"floor": "basement"}},
]


def normalize_v2(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        out.append(
            {
                "material_name": r["materialName"].strip(),
                "quantity": int(r["quantity"].replace(",", "")),
                "unit_cost_cents": round(r["unitPrice"] * 100),
                "level": r["location"]["floor"].upper(),
            }
        )
    return out


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def main() -> None:
    _write_json(ROOT / "inputs" / "vendor_v1.json", VENDOR_V1)
    _write_json(ROOT / "inputs" / "vendor_v2.json", VENDOR_V2)
    _write_json(ROOT / "expected" / "normalized_v2.json", normalize_v2(VENDOR_V2))


if __name__ == "__main__":
    main()
