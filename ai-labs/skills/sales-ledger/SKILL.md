---
name: sales-ledger
description: Provides the Q3 sales ledger workbook for reporting tasks. Use when a task asks you to compute bonuses or totals over the sales ledger; the data lives only in this skill's bundled workbook.
---

# Sales ledger

This skill bundles the Q3 sales ledger as an Excel workbook. When a reporting task needs the ledger,
load this skill and read the mounted file in the sandbox:

```
/skills/sales-ledger/assets/ledger.xlsx
```

The first worksheet ("Ledger") has a header row and one row per sale, with columns:

| A `sale_id` | B `salesperson` | C `team` | D `units` | E `unit_price` | F `commission_pct` |
|-------------|-----------------|----------|-----------|----------------|--------------------|

`commission_pct` is a fraction (e.g. `0.035` = 3.5%). Read the rows with a spreadsheet library
(e.g. `openpyxl`) to build your report.
