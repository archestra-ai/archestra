---
name: archestra-qa-sweep
description: Use when asked to QA, bug-bash, exploratory-test, or sweep a running Archestra instance with many agents, verify the findings, and produce a triage report. Covers target setup, the deterministic crawl, explorer and verifier subagents, the repro gate, reports, and the cross-run baseline.
---

# Archestra QA sweep

Exploratory agents look for defects; nothing is scripted per route.

Every finding must ship an executable repro. A deterministic gate runs each repro twice before an independent verifier judges it. Only verified findings reach the report, and triaged repros become regression checks for later runs.

Scripts live in `scripts/` (Node ESM; Playwright resolved from `platform/e2e-tests`). Run them from anywhere with `node <skill>/scripts/<name>.mjs`. Formats and rubrics are in `references/rubric.md`.

## 0. Target and budget (ask the user)

Ask before starting, as plain text:
1. **Target:** an already running stack (ask for the frontend and backend URLs), or a fresh Tilt stack (`tilt up` from `platform/` in a dedicated worktree; wait for `http://localhost:3000` and `:9000/health`). A fresh stack is cleaner; an existing one keeps its data, so its counts are noisy.
2. **Budget:** number of explorer lanes (default 6) and how long to run. Ask whether real LLM spend through configured providers is acceptable.
3. **Admin credentials,** if the stack is not a local default-dev one. Pass the password via `ARCHESTRA_QA_PASSWORD`; never store it in the run.

If `@playwright/test` cannot be resolved (for example in a worktree without `node_modules`), set `ARCHESTRA_QA_PLATFORM` to a `platform/` checkout that has it.

## 1. Init, warm-up, crawl

```bash
node scripts/init.mjs --base <frontend> --api <backend>     # prints runDir; logs admin in
node scripts/crawl.mjs --run <runDir>                       # discovers routes via links; signals only
```

`crawl/admin/summary.md` lists anomalous page variants (console errors, failed requests, overflow, near-empty pages) and every page title. These are **leads**, not findings.

## 2. Fixtures and roles (setup subagent)

Spawn one setup agent with a short brief:
- Create a low-privilege identity per built-in non-admin role, plus one narrow custom role. Use the app's own invitation flow and `@example.invalid` emails.
- Log each one in with `node scripts/login.mjs --run <runDir> --role <role> --email <email>` (password via `ARCHESTRA_QA_PASSWORD`).
- Seed one representative entity per main area, owned by the admin.
- Append every fixture id with its owner to `manifest.fixtures`. All names start with `manifest.prefix`.
- Then run `crawl.mjs --role member` (or the narrowest role) for a permission-view crawl.

## 3. Regression replay

`node scripts/known.mjs replay --run <runDir>` reruns repros from previous triage (`fix` and `later` decisions). The results go into the report: `still-present`, `looks-fixed` or `repro-broken`.

## 4. Explorers (parallel subagents)

Compose one charter per lane: **area or flow × role × 2–3 angles** from different groups in `references/angles.md`.
- Draw at random, and steer toward cold spots: last run's `coverage/*.json` `notCovered` entries, crawl anomalies, and areas changed in recent git history (`git log --since=... -- platform/frontend/src/app/<area>`).
- Record each charter in `manifest.lanes`.
- Fill `references/explorer.md` for each lane and spawn the lanes in parallel. Explorer work is tool-heavy, so a mid-tier model is enough.
- Every explorer has its own browser contexts, so there is no shared-browser contention. Do not use a shared desktop browser extension for lanes.

## 5. Gate

```bash
node scripts/repro.mjs --run <runDir>          # every finding without gate.json, 2 fresh-context runs each
```

How each gate result is handled:
- `no-repro` and `error`: go back to the explorer once, then drop.
- `flaky`: allowed through, but the verifier must explain the flakiness.

## 6. Verifiers (parallel subagents)

Group the gated findings into clusters of 5–15, by area or suspected root cause, and fill `references/verifier.md` for each cluster.
- Send findings with `category: security` (or any auth, permission or fetch flavour) to a separate verifier on the strongest available model.
- Use a fresh agent per cluster. Never let an explorer verify its own lane.

When verifiers disagree, or a verdict lacks its required citation, send that finding to one more verifier. Record the disagreement in `evidence` if it persists.

## 7. Report, teardown, triage

```bash
node scripts/report.mjs --run <runDir>        # LEDGER.md + triage.html in the run dir
```

- **Teardown:** have a cleanup agent delete everything carrying `manifest.prefix`, and list leftovers it could not delete (soft-deleted rows, orphans) at the end of `LEDGER.md`.
- **Hand-off:** give the user `triage.html` (open it locally; it contains security details, so do not publish it) and a short summary covering:
  - regression replay results
  - security findings, by title only
  - shared root causes
  - top issues by severity
  - what was not covered
- **After triage:** the user exports `triage-decisions.json` from the page, then run `node scripts/known.mjs import --run <runDir> --decisions <file>`. `fix`/`later` entries become regression repros. `wont`/`nab` entries are suppressed by fingerprint in future reports.

## Improving the harness

After each run, update `references/angles.md` (add angles that found real bugs, drop ones that didn't) and the false-positive traps in `references/rubric.md` with anything verifiers ruled out more than once. Keep the scripts generic: no route lists, no app-specific selectors.
