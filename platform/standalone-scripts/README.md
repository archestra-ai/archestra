# License Compliance

Scans dependencies for GPL/AGPL licenses incompatible with proprietary software.

## Usage

```bash
tsx license-check.ts           # Full report
tsx license-check.ts --ci      # CI mode (fails on GPL/AGPL)
tsx license-check.ts lookup react  # Check specific package
```

## Adding Verified Licenses

Edit `license-resolution.json` for packages with missing metadata:

```json
"package-name": {
  "license": "Apache-2.0",
  "source": "https://github.com/org/repo/blob/main/LICENSE",
  "verifiedBy": "manual inspection",
  "verifiedDate": "2025-12-18"
}
```

## CI

Runs automatically on PRs. **Blocks:** GPL, AGPL, Unknown. **Allows:** MIT, Apache, BSD, ISC, LGPL, MPL.

# White-Label Copy Check

Fails when new user- or LLM-facing copy hardcodes the `Archestra` brand instead
of resolving the deployment's configured app name. Deployments can rebrand via
`organization.appName`; anything typed as a literal leaks the vendor's name to
their users.

```bash
pnpm check:white-label                    # CI mode (fails on new occurrences)
pnpm check:white-label --update-baseline  # re-record known occurrences
```

Resolve the name at runtime instead:

- frontend — `useAppName()` from `@/lib/hooks/use-app-name`
- backend — `archestraMcpBranding.appName`

## What it looks at

String literals, template literals, and JSX text. Comments, identifiers
(`ArchestraContext`), lowercase occurrences (`archestra__`, `@archestra/shared`,
`archestra.ai`), `SCREAMING_CASE` env vars, hyphen-joined wire names
(`X-Archestra-User-Id`), and `logger`/`console` arguments are all left alone —
they are contracts or diagnostics, not copy.

## Waiving an occurrence

When a string genuinely names the vendor rather than the deployment — the
`archestra` LLM provider names the upstream product you connect to, not this
install — annotate the line:

```ts
// white-label-ok: names the upstream provider, not this deployment
```

A reason is required. For files that are entirely about the default brand, add
them to `ALLOWLISTED_FILES` / `ALLOWLISTED_DIRS` in the script instead.

## Baseline

`white-label-baseline.json` records occurrences that predate the check, keyed by
file plus the exact trimmed source line — so moving code does not churn it, but
editing a flagged line re-raises it. The baseline is meant to shrink; when it
does, the check says so and `--update-baseline` locks the win in.
