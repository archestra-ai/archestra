---
name: archestra-dev-override-sweep
description: Use when asked to sweep, clean up, or revisit pnpm overrides and minimumReleaseAge exclusions in platform/pnpm-workspace.yaml — unwinding a matured temporary CVE pin once its fix has cleared the 7-day window, or removing an override the dependency graph has made redundant. This skill only sweeps existing pins; it does not author new CVE fixes.
---

# Archestra Dependency Override Sweep

The merge-queue **Docker Image Scanning (Platform)** gate fails on any fixable
CRITICAL/HIGH CVE in the built image. Dependabot can't auto-fix transitive or pinned
deps, so those fixes live as `overrides` in `platform/pnpm-workspace.yaml`. Two kinds of
cruft collect there, and this skill removes them:

- **Matured temporary pins.** When a fix is newer than the repo's 7-day
  `minimumReleaseAge` (`10080` minutes) it's pinned *exact* and the package is added to
  `minimumReleaseAgeExclude` so pnpm installs it anyway. Those are temporary — unwind
  them once the fix has cleared the window.
- **Redundant overrides.** As the dependency graph catches up, an override stops doing
  anything: the package already resolves to a compliant version without it.

**Out of scope:** authoring *new* CVE fixes (adding overrides for freshly-flagged
advisories). This skill only sweeps overrides that already exist.

Work from `platform/`. **One override change per PR** — one matured pin unwound (Mode A)
*or* one redundant override removed (Mode B), never several and never one of each.
Smallest blast radius, trivially revertible, easy to bisect.

## Mode A — unwind one matured temporary pin

1. Find the temporary entries: the `TEMPORARY:` comment blocks and the
   `minimumReleaseAgeExclude` list (ignore non-CVE excludes like `next` / `@next/*` —
   they're kept for other reasons).
2. Pick one whose pinned fix version has now been published ≥7 days ago — check
   `npm view <pkg> time --json` rather than trusting the comment's date. If unsure,
   proceed anyway: pnpm is the backstop — re-resolving rejects a still-immature version
   with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`, which simply means leave it quarantined.
3. For that one package: drop it (and any `@scope/*` siblings) from
   `minimumReleaseAgeExclude` along with its `TEMPORARY:` comment, and relax its exact
   override pin to a `>=` floor at the fix version — or drop the override entirely if the
   graph resolves to a non-vulnerable version without it. Leave pins held for a non-CVE
   reason alone.
4. Verify (below).

## Mode B — drop one redundant override

1. Pick one override to test. Remove its line from `overrides:` (and any comment that
   documents only that line).
2. Re-resolve: `corepack pnpm install --lockfile-only --ignore-scripts`.
3. Judge from `git diff platform/pnpm-lock.yaml`. A *redundant* override's removal changes
   **only** the `overrides:` metadata block and `specifier:` reflection lines — **never a
   `version:`**. If no resolved version moved, it was redundant: keep the removal. If any
   `version:` changed, the override is load-bearing: revert it.
4. Verify (below).

Watch for false positives: a nested override (e.g. `mammoth>@xmldom/xmldom`) can look
redundant only because a sibling top-level floor (`@xmldom/xmldom`) is what actually holds
it — the `version:` change on removal exposes that. Treat exact pins that hold a version
*down* conservatively; they may be pinning out a regression.

## Verify (both modes)

- **No new CVE.** Before editing, note the high/critical advisory set from
  `corepack pnpm audit --json` (the entries with `severity` `high`/`critical`); after
  re-resolving, take it again and confirm nothing new appeared. A new advisory → revert.
- **The gates CI runs:**
  ```bash
  corepack pnpm install --frozen-lockfile --prefer-offline --ignore-scripts   # must say "up to date"
  corepack pnpm install --fix-lockfile --lockfile-only --ignore-scripts        # immature-deps gate, must not error
  corepack pnpm --filter @backend --filter @frontend type-check
  ```
- The PR's **Docker Image Scanning (Platform)** gate is authoritative — it also catches
  base-image OS-package CVEs that `pnpm audit` can't see. Don't merge until it's green.

Commit `deps: unwind matured CVE pin (<pkg>)` (Mode A) or
`deps: drop redundant pnpm override (<pkg>)` (Mode B), and open the PR.

## Notes

- After a sweep the lockfile stays at the resolved version regardless of removing the
  exclusion; the exclusion only governs *install-time* maturity enforcement.
- Overrides come in several shapes — plain (`lodash: '>=4.18.0'`), exact pins
  (`vite: 7.3.5`), major-scoped selectors (`ws@>=8`, `picomatch@<4`), and nested
  (`mammoth>@xmldom/xmldom`). The lockfile-diff check in Mode B is what actually proves a
  removal is safe, whatever the shape.
- `minimumReleaseAge` (7 days) is a supply-chain defense; only bypass it via the exclude
  list for a known security fix, and undo it promptly — that's Mode A.
