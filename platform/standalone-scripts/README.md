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

Fails when user- or LLM-facing copy hardcodes the `Archestra` brand instead of
resolving the deployment's configured app name. Deployments can rebrand via
`organization.appName`; anything typed as a literal leaks the vendor's name to
their users.

```bash
pnpm check:white-label
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

Some strings genuinely name the vendor rather than the deployment. Annotate the
line, or the comment block above it, with a reason:

```ts
// white-label-ok: names the upstream provider, not this deployment
```

A reason is required — a bare marker does not suppress. The categories that
legitimately need one:

| Category | Example |
| --- | --- |
| The `archestra` upstream LLM provider | chaining to another instance |
| Wire identifiers | OpenAPI schema ids, MCP client `User-Agent` |
| Text branded downstream | seeded prompts, tool descriptions, OpenAPI prose |
| Internal error sentinels | matched by a handler that emits branded copy |
| The vendor's own services | the hosted skills marketplace |
| Default brand marks | shown only when no white-label logo is set |

For files that are entirely about the default brand, add them to
`ALLOWLISTED_FILES` / `ALLOWLISTED_DIRS` in the script instead.

## Where branding happens downstream

Not every literal can resolve the app name where it is written — some run before
an organization has been loaded. Three seams handle those:

- `archestraMcpBranding.brandBuiltInText()` — shipped platform text (built-in
  skills, seeded prompts and demo apps, chat error defaults).
- `getArchestraMcpTools()` — built-in MCP tool descriptions, at reconcile time.
- `enrichOpenApiWithRbac()` — OpenAPI `description`/`summary`, per request,
  because route schemas register before the branding singleton syncs.
