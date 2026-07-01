"""Regenerate the two vendor-statement PDFs (staged to the agent) and the verifier-only
`expected/report.json` from one data source, so the PDF contents and the ground truth can never drift.

Not staged to the agent (only files named in a `[[stages.files]]` block are). Run with a Python that
has reportlab installed:

    python build_fixtures.py

The line items are deliberately small and the amounts distinct so the verifier can match each row by
(date, category, amount) without depending on how the model lays the workbook out.
"""

import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

HERE = Path(__file__).resolve().parent
INPUTS = HERE / "inputs"
EXPECTED = HERE / "expected"

# Reimbursable categories (used to derive the stage-2 ground truth).
REIMBURSABLE_CATEGORIES = {"Travel", "Meals"}

# Two corporate-card statements. Categories are mixed across both cards on purpose, so no vendor,
# card, or category alignment lets a model shortcut the per-row reimbursable classification. Each line
# item: (date, merchant, description, category, amount). All (date, category, amount) keys are unique.
STATEMENTS = [
    {
        "cardholder": "Dana Rivera",
        "card_last4": "4471",
        "period": "March 2026",
        "pdf": "card-statement-4471-march.pdf",
        "items": [
            ("2026-03-02", "Quill & Co", "Printer paper and toner", "Office Supplies", 62.10),
            ("2026-03-05", "Redline Rail", "Train fare to client site", "Travel", 88.00),
            ("2026-03-09", "The Copper Kettle", "Lunch with client", "Meals", 45.30),
            ("2026-03-14", "Summit Software", "Design tool seat (monthly)", "Software", 120.00),
        ],
    },
    {
        "cardholder": "Miguel Santos",
        "card_last4": "8820",
        "period": "March 2026",
        "pdf": "card-statement-8820-march.pdf",
        "items": [
            ("2026-03-06", "Metro Cab", "Taxi to airport", "Travel", 27.50),
            ("2026-03-12", "Deskworks", "Ergonomic chair", "Office Supplies", 149.99),
            ("2026-03-18", "Brightline Bistro", "Team dinner", "Meals", 76.40),
            ("2026-03-27", "Cloudstore", "Cloud storage (monthly)", "Software", 30.00),
        ],
    },
]


def build_pdf(statement: dict) -> None:
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(
        str(INPUTS / statement["pdf"]),
        pagesize=LETTER,
        title=f"Corporate Card Statement — card ending {statement['card_last4']}",
    )
    flow = [
        Paragraph("Corporate Card Statement", styles["Title"]),
        Paragraph(
            f"Card ending {statement['card_last4']} — {statement['cardholder']} — {statement['period']}",
            styles["Heading2"],
        ),
        Spacer(1, 0.25 * inch),
        Paragraph(
            "Transactions posted this period are listed below. All amounts are in USD.",
            styles["Normal"],
        ),
        Spacer(1, 0.2 * inch),
    ]

    rows = [["Date", "Merchant", "Description", "Category", "Amount (USD)"]]
    for date, merchant, desc, category, amount in statement["items"]:
        rows.append([date, merchant, desc, category, f"{amount:.2f}"])
    total = sum(item[4] for item in statement["items"])
    rows.append(["", "", "", "Total", f"{total:.2f}"])

    table = Table(
        rows,
        colWidths=[0.9 * inch, 1.5 * inch, 2.0 * inch, 1.4 * inch, 1.1 * inch],
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f3b57")),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("ALIGN", (4, 0), (4, -1), "RIGHT"),
                ("GRID", (0, 0), (-1, -2), 0.5, colors.grey),
                ("LINEABOVE", (0, -1), (-1, -1), 1, colors.black),
                ("FONTNAME", (3, -1), (4, -1), "Helvetica-Bold"),
                ("ROWBACKGROUNDS", (0, 1), (-1, -2), [colors.white, colors.HexColor("#eef2f6")]),
            ]
        )
    )
    flow.append(table)
    doc.build(flow)


def build_expected() -> dict:
    line_items = []
    category_totals: dict[str, float] = {}
    for statement in STATEMENTS:
        for date, merchant, desc, category, amount in statement["items"]:
            reimbursable = category in REIMBURSABLE_CATEGORIES
            line_items.append(
                {
                    "date": date,
                    "vendor": merchant,
                    "description": desc,
                    "category": category,
                    "amount": round(amount, 2),
                    "reimbursable": reimbursable,
                }
            )
            category_totals[category] = round(category_totals.get(category, 0.0) + amount, 2)

    reimbursable_total = round(
        sum(i["amount"] for i in line_items if i["reimbursable"]), 2
    )
    return {
        "line_items": line_items,
        "category_totals": category_totals,
        "reimbursable_total": reimbursable_total,
    }


def main() -> None:
    INPUTS.mkdir(parents=True, exist_ok=True)
    EXPECTED.mkdir(parents=True, exist_ok=True)
    for statement in STATEMENTS:
        build_pdf(statement)
    expected = build_expected()
    (EXPECTED / "report.json").write_text(json.dumps(expected, indent=2) + "\n")
    print("wrote", [s["pdf"] for s in STATEMENTS], "and expected/report.json")
    print(json.dumps(expected, indent=2))


if __name__ == "__main__":
    main()
