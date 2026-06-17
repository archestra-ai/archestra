---
name: archestra-dev-deps
description: Use when asked to sweep, clean up, or revisit pnpm overrides and minimumReleaseAge exclusions in platform/pnpm-workspace.yaml — (a) removes quarantine exclusions / relaxes exact CVE pins once the fixed version has cleared the 7-day window, and (b) finds and removes overrides the dependency graph has made redundant. This skill only sweeps existing pins; it does not author new CVE fixes.
---

# Archestra Dependency Override Sweep

The merge-queue **Docker Image Scanning (Platform)** gate fails on any fixable
CRITICAL/HIGH CVE in the built image. Dependabot can't auto-fix transitive/pinned deps
here, so fixes live as `overrides` in `platform/pnpm-workspace.yaml`.

When a fix is newer than the repo's 7-day `minimumReleaseAge` (`10080` minutes), it's
pinned **exact** and the package is added to `minimumReleaseAgeExclude` so pnpm will
install it anyway. Those are **temporary** and should be unwound once the fix matures.
Other overrides quietly go stale as the dependency graph catches up. Keeping that
override list lean is this skill's job — it has two sweep modes below.

**Out of scope:** authoring new CVE fixes (adding overrides for freshly-flagged
advisories) — that's the CVE-fix workflow / `i-fix-cve`. This skill only cleans up
overrides that already exist.

Run all commands from `platform/`. Helper scripts referenced below live in this skill's
`scripts/` directory; `<skill-dir>` is the base directory printed when the skill loads.

**Before any edit (both modes), snapshot the CVE baseline** so you can prove the sweep
introduced none — `pnpm audit` flags the same npm-package advisories the merge-queue Docker
scan does:

```bash
bash <skill-dir>/scripts/audit-guard.sh baseline /tmp/cve-before.txt
```

Re-check it after re-resolving (each mode's verify step). The PR's **Docker Image Scanning
(Platform)** gate stays authoritative — it also covers base-image OS-package CVEs that
`pnpm audit` can't see — so don't merge until it's green regardless of this local check.

## Mode A — sweep matured temporary pins/exclusions

1. List the temporary entries and their clearance dates:
   ```bash
   grep -nE "TEMPORARY|minimumReleaseAgeExclude:|^  - " platform/pnpm-workspace.yaml
   ```
   Each CVE-temp block names a package, its pinned fix version, and a "clears <date>" note.
   Ignore non-CVE excludes like `next` / `@next/*` (kept for a different reason — leave them).

2. For each temp-excluded/pinned package, **recompute** maturity against npm (don't trust the
   comment date) using the helper — pass each `pkg@pinnedVersion` found in step 1:
   ```bash
   python3 <skill-dir>/scripts/maturity.py <pkg>@<pinnedVersion> [<pkg>@<pinnedVersion> ...]
   ```
   Only sweep entries reported `MATURE`. Leave `QUARANTINED` ones (note when they clear).

3. For each MATURE package, edit `platform/pnpm-workspace.yaml`:
   - Remove it (and its scoped `@x/*` siblings, e.g. `@esbuild/*`) from `minimumReleaseAgeExclude`, plus the `TEMPORARY:` comment block.
   - In `overrides`, relax the exact pin to a `>=` floor at the fixed version (e.g. `esbuild: 0.28.1` → `esbuild: '>=0.28.1'`) so future patch releases flow in normally — *unless* a comment says it's pinned for a non-CVE reason. If the dependency graph now resolves to a non-vulnerable version without the override at all, you may drop the override entirely (verify in step 5).

4. Re-resolve the lockfile:
   ```bash
   corepack pnpm install --lockfile-only --ignore-scripts
   ```
   If this fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, the version isn't actually past
   the window — revert that entry and keep it quarantined.

5. Verify the fix held (no vulnerable version came back):
   ```bash
   grep -oE "<pkg>@[0-9]+\.[0-9]+\.[0-9]+" platform/pnpm-lock.yaml | sort -u
   ```
   Confirm every resolved version is ≥ the fixed version. Cross-check the advisory is no
   longer open:
   ```bash
   gh api repos/archestra-ai/archestra/dependabot/alerts --jq '.[] | select(.dependency.package.name=="<pkg>" and .state=="open") | .security_advisory.ghsa_id'
   ```
   Then confirm the sweep introduced no new high/critical advisory:
   ```bash
   bash <skill-dir>/scripts/audit-guard.sh check /tmp/cve-before.txt   # must print OK; a new one → revert
   ```

6. Run the gates that CI runs:
   ```bash
   corepack pnpm install --frozen-lockfile --prefer-offline --ignore-scripts   # "Lockfile is up to date"
   corepack pnpm install --fix-lockfile --lockfile-only --ignore-scripts        # immature-deps gate, must not error
   corepack pnpm --filter @backend --filter @frontend type-check                 # affected workspaces
   ```

7. Commit `deps: sweep matured CVE pins (<packages>)` and open a PR.

## Mode B — find & remove redundant overrides

Over time the dependency graph catches up and many `overrides` become no-ops: the
package already resolves to a compliant version without them. Removing one is safe
**only** when it leaves the resolved tree byte-identical.

Sweep **incrementally and net-positive**: one removal per PR. The sweeper defaults to
`--limit 1` — it removes a single provably-redundant override, you ship that PR, and the
next run removes the next one. There is no need (or value) in clearing the whole list at
once; each removal is its own small, trivially-revertible change.

1. Run the sweeper. It removes redundant overrides **one at a time**: for each candidate
   it deletes the entry, re-resolves, and keeps the removal only if the resolved tree is
   unchanged (fingerprint match) **and** `audit-guard` finds no new CVE — otherwise it
   reverts that one and moves on. It stops after `--limit` successful removals (default
   1); `--skip` leaves chosen keys alone (e.g. recently-added CVE floors you want to
   retain as regression guards):
   ```bash
   bash <skill-dir>/scripts/sweep-redundant-overrides.sh --dry-run            # preview the next removal
   bash <skill-dir>/scripts/sweep-redundant-overrides.sh --skip vite,ws@>=8   # apply it, keeping listed floors
   ```
   On a real run the tree is left with the verified removal applied; on error/interrupt
   it restores everything. (To inspect all classifications without changing anything, the
   read-only `find-redundant-overrides.sh` analyzer is still available.)

2. Tidy any `minimumReleaseAgeExclude` entry/comment orphaned by a removal (the sweeper
   drops a comment block directly above a removed entry, but not shared ones).

3. Confirm the gates from Mode A steps 6 (frozen-lockfile, fix-lockfile, type-check) and
   that `git diff platform/pnpm-lock.yaml` shows **no `version:` change** — only the
   `overrides:` metadata block and `specifier:` reflections. Any resolved-version change
   means a removal slipped through — restore it.

4. Commit `deps: drop redundant pnpm override (<package>)` and open a PR (one override).

Per-package isolation is the whole point: bulk-removing N and diffing once is all-or-
nothing — a single load-bearing override taints the batch. It also auto-handles nested
false-positives (a nested override that only looks redundant once a sibling floor is
stripped reverts itself). Treat exact pins that hold a version *down* conservatively.

## Notes

- Overrides come in several shapes: plain (`lodash: '>=4.18.0'`), exact pins (`vite: 7.3.5`),
  major-scoped selectors (`ws@>=8`, `picomatch@<4`), and nested (`mammoth>@xmldom/xmldom`). The
  read-only analyzer evaluates each in isolation and can mis-call a nested override redundant
  when a sibling floor (e.g. top-level `@xmldom/xmldom`) is what actually constrains it; the
  Mode B sweeper's per-package re-resolve catches that and reverts it.
- After sweeping, the lockfile stays pinned at the resolved version regardless of removing the
  exclusion; the exclusion only governs *install-time* maturity enforcement.
- `minimumReleaseAge` (7 days) is a supply-chain defense; only bypass it via the exclude list
  for a known security fix, and undo it promptly — which is the point of Mode A.
