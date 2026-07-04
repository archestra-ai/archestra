# expense-report-continue (cross-conversation "pull up my report")

Tests whether an agent can find and keep working on a file the user produced in an **earlier chat** —
the read-side "take my report" behavior, where the referenced file lives in the user's persistent
files, not in the (empty) sandbox of the new conversation.

## Shape

- **Stage 1 (chat 1):** two March corporate-card statements are attached as PDFs. The user asks for a
  single Excel expense report (one row per transaction) and to "save it so I can pick it back up
  later." Persisting it to the user's files — not just leaving it in the sandbox — is left for the
  agent to work out; the prompt never names `save_file`/`download_file`/`search_files`.
- **Stage 2 (chat 2, `new_conversation = true`):** a fresh conversation with an empty sandbox and no
  attachments. The user asks to pull the report back up and extend it (a `reimbursable` column for
  Travel/Meals, plus a per-category totals sheet), then export it.

## Why the oracle is genuine, not a proxy

The eight March transactions exist **only** inside the report saved in stage 1 — the PDFs are gone in
stage 2 and the new sandbox starts empty. So a final workbook that reproduces those transactions can
only have come from discovering the saved report (via `search_files`) and reopening it. The
verifier's line-item fidelity check is therefore the real gate on the cross-conversation behavior, and
a model that regenerates from scratch or fails to find the report cannot pass it. The per-lane project
is what persists the file across the two conversations (see `envs/basic.toml` / `runner/src/run.rs`).

## Grading (`verifier.py`, openpyxl)

Against the never-staged `expected/report.json`:
1. **Line items recovered + extended** — all eight transactions present (matched on the unique
   `(category, amount)` pair, so column order / date format don't matter), each with the correct
   vendor and a correct `reimbursable` flag, and no extra rows (a leaked subtotal row fails).
2. **Second sheet** with the per-category totals is present.
3. **Submitted totals** — `category_totals` and `reimbursable_total` from `submit_result` match.

`build_fixtures.py` (task root, never staged) regenerates the two PDFs and `expected/report.json` from
one data source so they can't drift; run it with a Python that has `reportlab` installed. Categories
are mixed across both cards on purpose so no vendor/card/category alignment lets a model shortcut the
per-row reimbursable classification.
