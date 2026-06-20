---
name: archestra-dev-image-cve
description: Use when the "Docker Image Scanning" CI check (Docker Scout) blocks a PR or the merge queue — including release-please PRs — on a CRITICAL/HIGH CVE in the Platform or MCP Server Base image. Authors a new CVE override (Go module rebuilt from source, OS/base-image bump, or pnpm package), and handles the case where the fix is "too new" for the 7-day supply-chain gate. For unwinding existing matured pnpm pins, use archestra-dev-override-sweep instead.
---

# Archestra Docker Image CVE Fixes

The **Docker Image Scanning** workflow (`.github/workflows/docker-image-scanning.yml`)
runs `docker/scout-action` with `command: cves` and `only-severities: critical,high`.
It **fails the build when a CRITICAL/HIGH CVE has an available fix**, which blocks the
merge queue — so it also blocks release-please PRs (the merge-group rebuilds the image
from the branch, so a CVE on `main`'s Dockerfile fails every queued PR until fixed).

Two image targets are scanned (a matrix):

| Target          | Context                              | Dockerfile                                          |
|-----------------|--------------------------------------|-----------------------------------------------------|
| Platform        | `./platform`                         | `platform/Dockerfile`                               |
| MCP Server Base | `./platform/mcp_server_docker_image` | `platform/mcp_server_docker_image/Dockerfile`       |

(The sandbox base image, `platform/sandbox_base/Dockerfile`, has its own build workflow
and can surface the same way.)

> **Scope.** This skill *authors* fixes for freshly-flagged image CVEs. Unwinding a
> *matured* pnpm pin or removing a redundant override is the
> [[archestra-dev-override-sweep]] skill — don't do that here.

## 1. Identify the package, version, and fix

Get the run ID from the failing check, then read the scan output. The package name,
affected range, and fixed version are all in the log:

```bash
gh run view <run-id> --repo archestra-ai/archestra --log-failed 2>&1 \
  | grep -iE "✗ (HIGH|CRITICAL)|pkg:|Affected range|Fixed version|<package>" | head -40
```

You're looking for a block like:

```
0C 3H 0M 0L  github.com/containerd/containerd/v2 2.2.4
pkg:golang/github.com/containerd/containerd@2.2.4#v2
  ✗ HIGH CVE-2026-53488 ...
    Affected range : >=2.2.0  <2.2.5
    Fixed version  : 2.2.5
```

The **`pkg:` purl prefix tells you which fix path to use** (Section 2):
`pkg:golang/…` → Go module, `pkg:apk/…` / `pkg:deb/…` → OS package,
`pkg:npm/…` → pnpm package.

## 2. Choose the fix path by package type

### A. Go module rebuilt from source (most common here)

The Platform image compiles KinD, Docker CLI, Dagger, and kubectl from source in the
`go-builder` stage *specifically* so we can pull upstream CVE fixes without waiting for
distro packages. Each tool's `RUN` block is already a list of
`go get <module>@<fixed-version>` overrides, each with a `# cve-...` comment. **Fixing a
Go CVE = adding or bumping one such line in the right block.**

1. Find which binary pulls the vulnerable module. Search the Dockerfile for the module,
   or reason from the purl: containerd/moby/buildkit come in via **Dagger** (the
   `git clone … dagger …` block); grpc/otel/go-jose also appear in the **docker-cli**
   block; x/net appears in several. If unsure, add the override to the block whose tool
   the scan attributes the package to (the binary is in the image via that build).
2. **Bump an existing pin** if the module is already pinned (just change the version and
   extend the comment), or **add a new** `go get <module>@<fixed-version> && \` line with
   a `# cve-YYYY-NNNNN: <one-line reason> fixed in >= <version>` comment above it.
3. **Respect ordering.** Some blocks have ordering constraints called out in comments
   (e.g. docker-cli's `x/net` get *must be last* before `go mod vendor`; Dagger's
   `x/crypto` *after* `x/net`). Insert your line so existing "must be last/after"
   invariants still hold — generally place a new transitive-dep get with the others,
   before any trailing vendor/tidy step.
4. There is **no supply-chain wait for Go modules** — they're fetched at build time from
   the module proxy, not installed via pnpm. Pin to the exact `Fixed version` from the
   scan. (Verify the tag exists: `git ls-remote --tags https://github.com/<owner>/<repo>.git | grep <version>`.)

Example (the containerd bump this skill was written from):

```dockerfile
    # cve-2026-46680: containerd type confusion fixed in >= 2.2.4
    # cve-2026-53488/53492/53489: containerd injection/input-validation/symlink-following fixed in >= 2.2.5
    go get github.com/containerd/containerd/v2@v2.2.5 && \
```

### B. OS / base-image package (`pkg:apk/…`, `pkg:deb/…`)

The vulnerability is in the Alpine/Debian base layer.

1. First try bumping the **base image digest** — pick the newest digest of the same tag
   (`golang:1.25.x-alpine@sha256:…`, `node:24-alpine…`) that includes the fixed package.
   The `ARG …_IMAGE=` lines at the top of the Dockerfile pin these by digest.
2. If no rebuilt base is available yet, `apk add --no-cache <pkg>=<fixed-version>` (or the
   `apt-get install` equivalent) in the relevant stage to force the patched package.
3. There is **no 7-day gate** for OS packages either.

### C. npm / pnpm package (`pkg:npm/…`) — the 7-day gate applies here

npm CVEs that Dependabot can't auto-fix are pinned as `overrides` in
`platform/pnpm-workspace.yaml`. **This is the only path where "the fix is too new" can
actually block you** — `minimumReleaseAge: 10080` (7 days) makes pnpm refuse a package
published less than a week ago (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`).

1. Add an entry under `overrides:` pinning the package to the fixed version, with a
   comment naming the CVE.
2. Re-resolve: `cd platform && corepack pnpm install --lockfile-only --ignore-scripts`,
   and review the `pnpm-lock.yaml` diff.
3. **If the fix is too new** (install fails with `ERR_PNPM_NO_MATURE_MATCHING_VERSION`,
   or `npm view <pkg> time --json` shows the fixed version published < 7 days ago) — see
   Section 3.

## 3. When the fix is "too new" (npm only)

The 7-day gate exists to protect against supply-chain attacks (malicious releases are
usually caught within hours/days). **Do not lower or remove `minimumReleaseAge`.** Two
acceptable outcomes:

- **Wait it out** if the CVE isn't blocking a release and the fix matures soon. Note the
  date the version clears the window (publish date + 7 days).
- **Temporarily exclude just that package** if you must merge now (CVE is HIGH/CRITICAL
  and blocking). This is the established escape hatch — pin exact and add the package to
  `minimumReleaseAgeExclude` so pnpm installs it despite the age, marked clearly as
  temporary:

  ```yaml
  overrides:
    # TEMPORARY (cve-YYYY-NNNNN): pinned exact; fix published <date>, matures <date+7d>.
    # Remove from minimumReleaseAgeExclude and relax to a >= floor once matured
    # (see archestra-dev-override-sweep).
    "<pkg>": "1.2.3"
  minimumReleaseAgeExclude:
    - "<pkg>"
  ```

  Excluding from the age gate narrows the supply-chain protection for exactly one
  package, so keep it scoped to the vulnerable package (plus its `@scope/*` siblings if
  they version together) and **leave a `TEMPORARY:` breadcrumb** so the
  [[archestra-dev-override-sweep]] skill can unwind it later. Don't exclude broadly.

For Go modules and OS packages there is **no age gate**, so "too new" never blocks them —
pin the fix directly (Section 2 A/B). The only real constraint is that the upstream tag
exists.

## 4. Verify and ship

- **One CVE-package per change** where practical — smallest blast radius, trivially
  revertible, easy to bisect if a bump breaks the build.
- Go/OS fixes only really verify by building the image. Confirm the upstream tag exists
  before pushing; a full `docker build` of `platform/Dockerfile` is the real check (slow —
  CI's scan re-runs it anyway). For pnpm fixes, run
  `corepack pnpm install --frozen-lockfile --ignore-scripts` and review the lock diff.
- Land the fix on **`main`** (a normal PR). Release-please PRs are downstream of `main`;
  once `main`'s image is clean, the merge queue rebuild passes and the release PR
  unblocks. Don't try to commit the fix into the release-please branch directly — it gets
  regenerated.
- Mention the CVE id(s) and `Fixed version` in the PR description.
