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

# Terraform Provider Compatibility and Updates

Two workflows keep `archestra-ai/terraform-provider-archestra` in step with the
platform API in `docs/openapi.json`.

## Compatibility check

`.github/workflows/terraform-provider-compatibility.yml` checks provider `main`
against the spec of a pull request. It runs when a pull request changes one of:

- `docs/openapi.json`
- `platform/scripts/check-terraform-provider.py` or `platform/scripts/terraform-provider/`
- the compatibility, updater or `on-pull-requests.yml` workflow

It does not run in the merge queue. It is not a required check: a failure shows
red on the pull request but does not block the merge. For now, do not add it to
the branch protection required checks.

To run it by hand, open **Actions → Terraform Provider Compatibility → Run
workflow**. The button appears only after the workflow is on the default
branch. Both inputs are prefilled with `main` and accept a branch, tag or
commit SHA:

- `platform_ref`: the platform revision whose `docs/openapi.json` is checked.
  The run reads only that file from it, so it can be older than the checker:
  the scripts come from the workflow branch.
- `provider_ref`: the provider revision to check. It must be a branch or tag of
  the provider repository, or a commit on one of them. A commit that exists only
  in a fork's pull request is refused, because the check runs provider code and
  a run from `main` shares the default branch's cache.

The run summary shows the commits that were checked. Manual runs do not cancel
each other; a new push to a pull request cancels its older run.

The checker:

1. Copies the provider and runs its own `make codegen-api-client` (and
   `codegen-credential-client` if the Makefile has it) with `OPENAPI_SPEC` and
   `ARCHESTRA_OPENAPI_SPEC` set to the selected spec.
2. Confirms that generation read that spec: the SHA-256 of
   `.codegen/openapi.raw.json` (and `.codegen/credentials-source.json` for the
   two-client layout) must match it.
3. Builds the provider's real agent, gateway and catalog create and update
   request bodies in an untouched copy and validates them against the request
   schemas, including the first update after an import. Nothing is sent to a
   server. A retired field such as `teams` fails.
4. Runs the provider unit tests against the regenerated client.

Exit codes:

| Exit | Meaning |
| ---- | ------- |
| 0 | Requests match the spec, and the provider builds and passes its unit tests with the regenerated client. |
| 1 | The provider is not compatible: a request does not match, generation fails on the spec, or the build or unit tests fail. |
| 2 | The check could not run. Most often the provider revision does not read `OPENAPI_SPEC`; offline generation starts with provider v3. |

The check uses provider `main`, so a red run can come from drift that is
already on provider `main`, not from the pull request. Fix request mismatches
on provider `main`. Fix build or unit-test failures with the regenerated client
in the provider update pull request (see below).

The check needs no credentials, platform server or Terraform apply. It does not
cover nested payloads or full resource lifecycles; the provider acceptance tests
do.

Run it locally from `platform/`:

```bash
python3 scripts/check-terraform-provider.py --provider /path/to/terraform-provider-archestra
python3 scripts/check-terraform-provider.py --provider /path/to/terraform-provider-archestra --spec /path/to/openapi.json
python3 -m unittest discover -s scripts/terraform-provider -p 'test_*.py'
```

## Provider update pull requests

`.github/workflows/update-terraform-provider.yml` regenerates the provider client
for the latest platform release, sets `platform-version.txt` to that release
and opens or updates a pull request on the provider branch
`automation/platform-api`. It runs daily at 06:37 UTC, on pushes to `main` that
change the spec, this workflow or the scripts above, and by hand on `main`.

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
run ends with a warning that says so, and nothing is published. The
compatibility check does not need the file.

The tests in `platform/scripts/terraform-provider/` use bare Git repositories and
a stub `gh`. They cover pull request creation after a failed build, unchanged
output, reruns, kept commits, conflicts and recovery, without writing to GitHub.
