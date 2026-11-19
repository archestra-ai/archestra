# Platform Scripts

Run these commands from `platform/`. Development and worktree helpers live here
alongside maintenance and code-generation scripts. Package-based tooling lives
under `tools/`.

# License Compliance

Scans dependencies for GPL/AGPL licenses incompatible with proprietary software.

## Usage

```bash
pnpm exec tsx scripts/license-check.ts           # Full report
pnpm exec tsx scripts/license-check.ts --ci      # CI mode (fails on GPL/AGPL)
pnpm exec tsx scripts/license-check.ts lookup react  # Check specific package
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

# Terraform Provider Updates

An agent keeps `archestra-ai/terraform-provider-archestra` in step with the
platform API. Pull requests here are not checked against the provider. API
changes reach the provider through the agent's pull request for the next
release, and provider CI tests them there against that release.

When Release Finalize publishes a release from `main`, it dispatches
`.github/workflows/sync-terraform-provider.yml` with the release tag. That
workflow starts a run of the **Terraform Provider Sync** agent on staging. The
agent compares the release with the one in the provider's
`platform-version.txt`, regenerates the client, changes the resources the API
changes touch in the Terraform provider and in the Crossplane provider, and
opens or updates one pull request on the provider branch
`automation/platform-sync`. It never merges. The agent, its instructions and
its identities are defined in `archestra/automation` of archestra-ai/infra.

- The workflow starts the run and ends. The job summary links to the run; the
  result is the pull request.
- To repeat a release or catch up on one, run **Sync Terraform Provider** on
  `main` with the release tag. The agent stops when the provider is already at
  that release.
- The workflow holds no Archestra API key and no credential for the provider
  repository. It exchanges the job's GitHub OIDC token for a one-hour token of
  a service account that can only run that agent
  ([workload identity federation](../../docs/pages/admin/identity/workload-identity.md)).
  Only this workflow file on `main` is trusted.
- The staging API is private. The job reaches it through an IAP tunnel
  (`.github/scripts/staging-api-tunnel.sh`), as a Google service account that
  can do nothing else.
- A failed start fails the workflow run with the reason. A refused sign-in is
  explained in the **Audit** tab of staging's logs, in the **Service account
  token exchanged** event.

`.github/scripts/test_terraform_provider_sync.py` runs the start script
against a local server standing in for GitHub and Archestra.
