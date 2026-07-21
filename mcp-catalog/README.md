# Archestra MCP Catalog data

This directory is the source of truth for the [Archestra MCP Catalog](https://archestra.ai/mcp-catalog)
shown on archestra.ai. The website ([archestra-ai/website](https://github.com/archestra-ai/website))
does **not** store this data — it pulls this directory at build time (see `app/scripts/pull-catalog.js`
in the website repo) and serves it via the catalog pages and the
[catalog API](https://archestra.ai/mcp-catalog/api-docs).

## Layout

- `mcp-servers.json` — the list of catalog entries, one URL per server:
  - GitHub (or GitLab) repository URLs for locally-run MCP servers, e.g.
    `https://github.com/owner/repo` or `https://github.com/owner/repo/tree/main/subdir`
  - Remote MCP endpoint URLs for hosted servers, e.g. `https://mcp.linear.app/mcp`
- `mcp-evaluations/*.json` — one evaluation/manifest file per server
  (`ArchestraMcpServerManifest` documents; the schema lives in the website repo under
  `app/app/mcp-catalog/`). File names are derived from the URL:
  - GitHub: `{org}__{repo}.json` (plus `__{path segments}` for monorepo subdirectories)
  - Remote: `{domain}__remote-mcp.json` — the domain is the hostname with a leading
    `www.`/`mcp.`/`api.` prefix stripped and everything after the first `.` dropped
    (so `https://mcp.linear.app/mcp` → `linear__remote-mcp.json`)

## Adding a server

1. Add its URL to `mcp-servers.json` (keep the JSON valid — trailing commas break the build).
2. Open a pull request. CI validates the catalog data against the website's schema.
3. For GitHub-hosted servers, that's it: after the PR merges, the evaluation pipeline
   (`.github/workflows/evaluate-mcp-catalog.yml`) scores the new server with an LLM and
   opens a follow-up PR adding its `mcp-evaluations/*.json` file. Until that merges, the
   site shows the server as "being evaluated".
4. For **remote** MCP servers the pipeline cannot introspect the endpoint, so also add a
   manifest at `mcp-evaluations/{domain}__remote-mcp.json` in the same PR — copy an existing
   remote entry (e.g. `linear__remote-mcp.json`) as a template. The `name` field must match
   the file name.

After a change lands on `main`, `.github/workflows/trigger-website-deploy-on-catalog-changes.yml`
redeploys the website so the catalog updates on archestra.ai.

## Updating or re-scoring servers

Evaluations can be edited by hand (PRs welcome — e.g. fixing a category or description), or
re-generated in bulk by running the `Evaluate MCP Catalog Servers` workflow manually with
`force: true`.
