# Built-in browser MCP image

This release-versioned image retains Microsoft's Playwright MCP/Chromium files
and replaces `/usr/local/bin/node` with the official patched Node binary for the
same CPU architecture. It runs as the inherited `node` user from `/app`; the
platform supplies an absolute `/app/cli.js` command and explicit HTTP/isolated
browser flags. Existing sandbox behavior is preserved.

`versions.json` records both immutable multi-architecture image inputs and the
expected final package/runtime versions. Upstream's own Node version is recorded
separately: upgrading MCP alone does not guarantee a patched Node runtime.
The Dockerfile and metadata must move together.

From `platform/`:

```sh
pnpm --dir backend update:playwright-mcp
pnpm --dir backend update:playwright-mcp --check
pnpm --dir backend test:playwright-mcp-updater
docker build -t playwright-mcp:local docker_images/playwright_mcp
node docker_images/playwright_mcp/smoke-test.mjs playwright-mcp:local
```

The daily client-version workflow proposes a separate reviewed PR. MCP releases
must be stable, non-downgrading and at least seven days old. Node rebuilds track
the existing major and must meet the CVE-2026-111497 fixed-version floor on both
amd64 and arm64; they cannot downgrade. A Node security patch can be adopted
without waiting for another MCP release. HTTP failures, mismatched manifests or
architectures, and vulnerable replacements leave the input files unchanged.
The updater never installs packages or publishes images.

PR validation builds and exercises MCP/Chromium on both architectures. Trusted
PRs also use the existing Docker Scout policy; fork PRs lack its credentials.
Release/dev workflows publish through the existing registry identity, and release
publication waits for this image. A deployment must have its matching
`playwright-mcp:<platform-version>` image available before upgrading.
