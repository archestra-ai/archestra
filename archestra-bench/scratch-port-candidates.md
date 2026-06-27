# 25 candidate tasks to port from task-evals-for-skills → archestra-bench

## The binding constraint

All 1,110 source tasks are graded by an **LLM-judge weighted-checklist rubric**. archestra-bench grades **only** with deterministic pytest verifiers (exact-match/bounds/set-membership on a submitted JSON `result`, file-artifact inspection, recomputation from staged fixtures, tool-call/state inspection). So every port follows the same reframe:

> Drop the prose deliverable (`report.md`, `briefing.docx`, …) and the rubric. Require a **structured `result`** (or a single exported artifact). Replace the rubric with a verifier that **recomputes ground truth from the staged fixtures** — never hardcode answers.

The fertile domains were: financial modeling, data/SQL transforms, static-vuln detection (rubrics already enumerate planted findings + locations), and document/web extraction. Subjective domains (content writing, CMS/Shopify "recommend X", audio/video needing live APIs, "scaffold a Next.js app") were rejected wholesale.

Runtime flags below: **[node]** needs a JS runtime in the sandbox; **[db]** needs Postgres/SQLite engine for the verifier; everything else is pure-Python-verifiable.

---

## Cluster A — Spreadsheet / financial modeling (5)  *(largest current gap)*

1. **`tessl-single-anthropics_financial-services_audit-xls_0`** — formula-error auditing. XLSX has 3 injected formula bugs (broken cross-sheet ref `C5`, hardcoded literal in `D8`, sign-flip in `E11`). `result=[{cell,category}]`; verifier asserts cell-set `{C5,D8,E11}` + categories, optionally recomputes correct values. *Low effort, High confidence.* Distinct from `xlsx-live-formulas` (which produces values) — this localizes errors.

2. **`tessl-multi-anthropics-claude-agent-sdk-demos_0`** — Luminate 3-yr SaaS model → `luminate_model.xlsx`. All assumptions are fixed literals, so ARR/GP/opex/headcount-ramp/rev-per-employee are uniquely determined; verifier recomputes and matches cells within tolerance (use LibreOffice headless or recompute-by-label). *Low–Med, High.* First driver-based multi-sheet model.

3. **`tessl-multi-anthropics-financial-services_3`** — Meridian LBO model. Self-contained `deal_assumptions.txt`; verifier recomputes Sources==Uses, debt schedule (TLB amort + Second-Lien PIK), exit equity, **MOIC + IRR** within tolerance. *Med, High.* No leveraged-finance/IRR task exists.

4. **`tessl-multi-anthropics-financial-services_2`** (Deliverable 3 only) — CloudPeak comps table. Recompute EV/Revenue, EV/EBITDA, Rule-of-40 for 6 companies from staged CSVs; CPTECH EV built from price×shares−net-cash. *Low–Med, High.* Adds valuation-multiples analysis.

5. **`tessl-multi-anthropics-claude-agent-sdk-demos_2`** — Acme Q1 PDF → 4-sheet workbook. Extract figures from earnings PDF, compute YoY $/% and segment shares; verifier recomputes from the PDF ground truth, matches cells by row-label. *Med, Med–High.* Combines PDF extraction + spreadsheet compute.

---

## Cluster B — Data transform / SQL / schema (4)

6. **`tessl-single-clickhouse_agent-skills_chdb-sql_0`** — window functions. Over `daily_sales.csv`+`products.csv`: Q1 filter, cumulative revenue + 7-day rolling avg, top-3-per-category → 3 CSVs + printed total. Verifier recomputes all four with pandas. *Low, High.* Adds rolling/cumulative/partitioned-top-N (sqlite-orders is a single aggregate).

7. **`tessl-single-clickhouse_agent-skills_chdb-datastore_2`** — dedup ETL → **Parquet**. Dedup on composite key, filter, derived `net_amount`, write `clean_transactions.parquet`. Verifier reads with pyarrow, recomputes expected frame, asserts equality. *Low, High.* First Parquet artifact.

8. **`tessl-single-prisma_skills_prisma-cli_2`** **[db]** — `schema.prisma` → baseline migration SQL. Verifier applies the SQL to a fresh DB, introspects, asserts tables/columns/types/FKs match the declarative schema. *Med, Med.* Schema/DDL-generation graded by execution+introspection.

9. **`tessl-single-planetscale_database-skills_vitess_0`** — sharding VSchema. Produce `commerce_vschema.json`+`lookup_vschema.json` (4 shards, 6 tables). Verifier parses JSON, asserts each sharded table's primary vindex column matches the access-pattern-determined key, vindex types valid, sequences on auto-inc tables. *Med, Med.* Config-artifact correctness as structured JSON; no DB needed.

> Postgres-dependent alternatives if a PG engine is available to verifiers: `supabase…best-practices_1` (RLS persona matrix) and `_0` (schema fixes via catalog introspection) — both High-value, behavioral DB-authz coverage, but **[db]** Postgres-mandatory.

---

## Cluster C — Document / web extraction (3)

10. **`tessl-single-firecrawl_cli_firecrawl-parse_0`** — PDF fact extraction (surfaced in 3 lanes; consensus strongest). Extract 5 fields from `climate_risk_report.pdf` (financial exposure, target year, rice score, benefit-cost ratio, contact email). `result` = 5 fields, normalized exact-match. Ship PDF as fixture → fully deterministic, no network. *Low, High.* First PDF fact-extraction.

11. **`tessl-single-firecrawl_cli_firecrawl-interact_0`** — books.toscrape bounded extract (60 books, 3 pages) → JSON. Stage the 3 HTML pages as fixtures; verifier recomputes the 60-record set, asserts exact title/price/rating. *Low, High.* Paginated HTML→structured extraction (port as curl/parse; bench has no Firecrawl key). *(Scale-up alt: `…firecrawl-agent_0`, full 1000-book catalog.)*

12. **`tessl-single-firecrawl_firecrawl-claude-plugin_firecrawl-agent_2`** — quotes.toscrape, all 100 quotes with nested tags → JSON per schema. Verifier checks count==100, schema conformance, set-equality of (text,author), tags as per-quote set. *Low–Med, High.* Adds nested/array-field extraction.

---

## Cluster D — Runnable code / APIs / transforms (4)

13. **`tessl-single-google-labs-code_design.md_typed-service-contracts_0`** — env-var parser/validator with typed errors (PORT range, DATABASE_URL scheme, LOG_LEVEL enum, optional MAX_CONNECTIONS default 10). Drive with a battery of env dicts; assert exact parsed config + exact error code per malformed input. Reframe TS→Python. *Low–Med, High.* Input-validation/typed-error coverage.

14. **`tessl-single-google-labs-code_stitch-sdk_tdd-red-green-refactor_0`** — pure-function email parsing (`isValidEmail`/`extractUsername`/`extractDomain`). Run enumerated + adversarial cases, assert booleans/returns/raises. Reframe TS→Python. *Low, High.* Canonical pure-function-with-deterministic-I/O.

15. **`tessl-single-apollographql_skills_graphql-schema_0`** — GraphQL SDL design → `schema.graphql`. Verifier parses with Python `graphql-core` (`build_schema`), asserts validity + structural facts (enum member sets, query filter args, mutation result/error types). *Med, Med.* SDL-introspection is a reusable verifier pattern; keep checks to enumerable structure.

16. **`tessl-single-sanity-io_agent-toolkit_portable-text-conversion_0`** **[node]** — fix a buggy HTML→Portable-Text converter → `solution/output.json`. Pure JSON-structure assertions (block types, `_key`, h2 style, strong marks, image block, link markDefs, chrome strings absent). *Low–Med, High.* HTML→structured-JSON transform with negative (chrome-exclusion) checks.

---

## Cluster E — Artifact generation (1)

17. **`tessl-single-vercel-labs_json-render_react-pdf_0`** **[node]** — generate `catalog.pdf` (A4, heading, 3-col table, 5 products+prices). Verifier inspects the PDF: extract text (assert heading + 5 names/prices + 3 column headers), check A4 MediaBox geometry. *Med, High.* PDF-generation artifact inspection (distinct from GIF/PNG tasks).

---

## Cluster F — Static vulnerability detection (4)  *(rubrics already enumerate planted findings)*

18. **`tessl-single-getsentry_sentry-python_security-review_1`** (Django precision-trap variant) — plants only 2 real vulns (`raw()` SQLi, `yaml.load`) amid seeded false-positive traps (framework-mitigated patterns, test files). `result={"findings":[{type,line,function}]}`; grade recall on real vulns **+ precision** (penalize findings on trap lines). *Low, High.* Tests precision, not just recall. *(Companion recall variants `_0` Flask, `_2` Docker/Node available.)*

19. **`tessl-single-openai_skills_security-best-practices_0`** — full-stack review (Flask backend + vanilla-JS frontend); 8 planted issues incl. **frontend `innerHTML` XSS, localStorage secrets, missing headers**. Recall on `{type,file}`. *Low–Med, High.* Adds client-side security class.

20. **`tessl-single-google-gemini_gemini-cli_code-reviewer_0`** — diff-scoped review of a staged git repo; diff introduces SQLi, hardcoded key, **unauthenticated DELETE endpoint** (broken access control). `result` findings, recall on type+location. *Med, High.* Diff-scoped + access-control class. *(Effort caveat: ship the staged-git fixture.)*

21. **`tessl-single-microsoft_debugpy_jinja2_0`** — SSTI **remediation-verification**: audit + write corrected `solution/`. Verifier imports the fix, asserts signatures preserved + vuln patterns gone (AST/regex: no `Template(var)` in named functions, autoescape on). *Med, Med.* Fix-graded (not report-graded) verifier style; SSTI class.

---

## Cluster G — Code review / classification / lint (2)

22. **`tessl-single-bitwarden_ai-plugins_classifying-review-findings_0`** — classify findings in `payment_processor.py` by **severity + function name**: mixed SQLi (security) + missing-error-handling (reliability) + duplicated-validation (maintainability). `result=[{function,severity,type}]`, recall on `{function,type}` + precision check against seeded praise/style traps. *Low, High.* Function-keyed grading; mixed issue classes; anti-noise.

23. **`tessl-single-google-gemini_gemini-cli_string-reviewer_0`** — UX/i18n copy lint of `errors.ts`: 9 string-anchored defects (first-person phrasing, terminology, spelling, overlong message, etc.). `result=[{key,issue_type}]`, per-key recall. *Low, Med–High.* Distinct non-security lint/consistency class.

---

## Cluster H — Triage / routing (1)

24. **`tessl-single-microsoft_apm_apm-triage-panel_1`** — triage a GitHub issue (`issue.json`) → machine-readable summary (decision, labels, milestone, priority, next_action). Natively structured: exact-match decision/priority/milestone-nullness + set-membership labels. *Low, High.* Issue triage/labeling (distinct from ai-sre root-cause).

---

## Cluster I — Systems-language review (1)

25. **`tessl-single-cloudflare_workerd_rust-review_0`** — review a Rust CXX FFI bridge (`bridge.rs`): CXX namespace mismatch, non-trivially-copyable across bridge, unsafe-block issue, `panic!` unwinding across FFI. `result` findings, recall on type+line. Verifier only reads findings → **no Rust toolchain needed.** *Low–Med, Med–High.* Only Rust/memory-safety/FFI task; drop the soft "style" item.

---

## Notable rejections (so they aren't revisited)
- **Live-API/secret-gated:** Brave/Tavily/Apify search, ElevenLabs/Deepgram audio, Auth0/Clerk/Stripe, live Shopify/Neon/Snowflake, SEC/market-data DCF models.
- **Irreducibly subjective:** cookbook/notebook audits, docs reviews, blog/briefing writing, CMS "recommend a mechanism", competitor analysis, chart-PNG visualization.
- **No headless check:** "build a Workers REST API on D1/Durable Objects", "scaffold a Next.js app" (need full CF/Node runtime as a long-lived server).
- **Stretch (excluded):** `shopify-functions_0` (Rust discount fn) — objective only if a wasm `function-runner` can be staged; falls back to weak source-grep otherwise.

## Cross-cutting risks
- **Node tasks (#16, #17):** need a JS runtime + npm in the sandbox. Confirm before porting; the TS pure-function tasks (#13, #14) are reframable to Python to avoid this.
- **DB tasks (#8, plus Postgres alternatives):** need a DB engine available to the verifier.
- **PDF tasks (#5, #10):** need a PDF text extractor (pdftotext/pypdf) on the agent side; verifier needs none.
- **Spreadsheet formula eval (#2, #3, #4):** verifier should recompute-by-label rather than trust agent cell coordinates; for live-formula models use LibreOffice headless.
