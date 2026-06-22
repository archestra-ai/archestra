---
name: archestra-dev-override-sweep
description: Use when asked to sweep, clean up, or revisit pnpm overrides and minimumReleaseAge exclusions in platform/pnpm-workspace.yaml — unwinding a matured temporary CVE pin once its fix has cleared the 7-day window, or removing an override the dependency graph has made redundant. This skill only sweeps existing pins; it does not author new CVE fixes.
---

# Archestra Dependency Override Sweep

CVE fixes for transitive or pinned deps — the ones Dependabot can't auto-fix — live as
`overrides` in `platform/pnpm-workspace.yaml`. Two kinds of cruft collect there, and this
skill removes them:

- **Matured temporary pins.** When a fix is newer than the repo's 7-day
  `minimumReleaseAge` (`10080` minutes) it's pinned *exact* and the package is added to
  `minimumReleaseAgeExclude` so pnpm installs it anyway. Those are temporary — unwind
  them once the fix has cleared the window.
- **Redundant overrides.** As the dependency graph catches up, an override stops doing
  anything: the package already resolves to a compliant version without it.

**Out of scope:** authoring *new* CVE fixes (adding overrides for freshly-flagged
advisories). This skill only sweeps overrides that already exist.

Work from `platform/`. **Make one override change at a time** — one matured pin unwound
(Mode A) *or* one redundant override removed (Mode B), never several and never one of each.
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
3. Judge from `git diff platform/pnpm-lock.yaml`. **Redundant ⇒ the diff is empty, or at
   most drops the override's own line from the top `overrides:` block / flips a `specifier:`
   reflection.** What proves the override was load-bearing is any edit under the resolution
   sections — `importers` (dependency refs), `packages` (a `name@version:` key, e.g.
   `+ picomatch@2.3.2:`), or `snapshots` (dependency edges); revert if any of those moved.
   Read the whole diff — don't grep for `version:` alone, since a shift usually shows up as a
   new/removed package key, not a `version:` line.

   pnpm (v11) often leaves the now-orphaned override line in the lockfile's `overrides:`
   block, so an empty lockfile diff is the *normal* redundant result, not a sign nothing ran.
   That stale line is inert metadata — not a re-applied override — and the `--frozen-lockfile`
   check below confirms it. Don't force a full reinstall or `pnpm dedupe` to purge it; that
   adds unrelated graph churn for no resolution benefit.
4. Verify (below).

Watch for false positives: a nested override (e.g. `mammoth>@xmldom/xmldom`) can look
redundant only because a sibling top-level floor (`@xmldom/xmldom`) is what actually holds
it — removing it adds a package key / shifts a version, which the diff exposes. Treat exact
pins that hold a version *down* conservatively; they may be pinning out a regression.

## Verify (both modes)

- **No new CVE.** Before editing, note the high/critical advisory set from
  `corepack pnpm audit --json` (the entries with `severity` `high`/`critical`); after
  re-resolving, take it again and confirm nothing new appeared. A new advisory → revert.
- **Lockfile + types stay sound:**
  ```bash
  corepack pnpm install --frozen-lockfile --prefer-offline --ignore-scripts   # must say "up to date"
  corepack pnpm install --fix-lockfile --lockfile-only --ignore-scripts        # immature-deps check, must not error
  corepack pnpm --filter @backend --filter @frontend type-check
  ```
- `pnpm audit` only sees npm-package advisories, not base-image OS packages — treat it as a
  local proxy, not the last word on the image's CVEs.

## Notes

- After a sweep the lockfile stays at the resolved version regardless of removing the
  exclusion; the exclusion only governs *install-time* maturity enforcement.
- Overrides come in several shapes — plain (`lodash: '>=4.18.0'`), exact pins
  (`vite: 7.3.5`), major-scoped selectors (`ws@>=8`, `picomatch@<4`), and nested
  (`mammoth>@xmldom/xmldom`). The lockfile-diff check in Mode B is what actually proves a
  removal is safe, whatever the shape.
- `minimumReleaseAge` (7 days) is a supply-chain defense; only bypass it via the exclude
  list for a known security fix, and undo it promptly — that's Mode A.
