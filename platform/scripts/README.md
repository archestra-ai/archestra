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

One workflow keeps `archestra-ai/terraform-provider-archestra` in step with the
platform API in `docs/openapi.json`. Pull requests here are not checked against
the provider. API changes reach the provider through the update pull request
for the next release, and provider CI tests them there against that release.

## Provider update pull requests

`.github/workflows/update-terraform-provider.yml` regenerates the provider client
for the latest platform release, sets `platform-version.txt` to that release
and opens or updates a pull request on the provider branch
`automation/platform-api`. It runs daily at 06:37 UTC, on pushes to `main` that
change the spec, this workflow or `platform/scripts/terraform-provider/`, and by
hand on `main`.

The release is the version in `docs/openapi.json` on `main`. The spec comes from
that release's `platform-v<version>` tag, not from `main`: provider CI
regenerates the client from the release in `platform-version.txt` and fails on
any difference. The updater uses a release only after Release Please has
published it on GitHub, which happens after the images are pushed. Before that,
a run skips with a notice and the next run proposes the release.

- The pull request is opened even when the regenerated client does not build or
  its tests fail. The failure is in the pull request body and in the
  `terraform-provider-update` artifact, and the workflow fails after the pull
  request exists. A maintainer then pushes the code changes to the same branch.
- If code generation itself fails on the spec, there is no client to propose:
  no pull request is opened, the run fails and the artifact gives the reason.
  Fix the code generation on provider `main`.
- If a maintainer closes the pull request without merging it, the updater does
  not open it again until the generated output changes.
- A preparation job without credentials runs code generation with the tools
  from provider `main`. A separate publish job applies only
  `internal/client/archestra_client.go`, the credential bridge client when
  provider `main` has the credential target, `platform-version.txt` and
  `platform-api.json`. It never runs provider code.
- Only `main` of this repository can publish. Pull requests, forks, the merge
  queue and the update branch never get the publish credentials: the existing
  releaser GitHub App, limited to the provider repository with contents and
  pull-request write access.
- Reruns reuse the branch and pull request, keep commits from people, push
  without force and create nothing when the output is unchanged.
  `platform-api.json` records the spec hash, the release commit and the provider
  `main` commit whose tools generated the client. A new spec or new tools
  regenerate the client. While the update branch exists, changes from people to
  generated files are kept only while both stay the same. If they conflict, the
  run fails without changing the branch; fix the conflict on the branch, update
  `platform-api.json` and run it again. After the pull request merges, provider
  `main` is the new starting point.

The updater needs `platform-version.txt` on provider `main`. Without it, each
run ends with a warning that says so, and nothing is published. It also needs
provider `main` to read `OPENAPI_SPEC` in `make codegen-api-client`, which
starts with provider v3.

The tests in `platform/scripts/terraform-provider/` use bare Git repositories and
a stub `gh`. They cover pull request creation after a failed build, unchanged
output, reruns, kept commits, conflicts and recovery, without writing to GitHub.
Run them from `platform/`:

```bash
python3 -m unittest discover -s scripts/terraform-provider -p 'test_*.py'
```
