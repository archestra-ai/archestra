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
2. Add a manifest file in `mcp-evaluations/` in the same PR — copy an existing entry as a
   template (`linear__remote-mcp.json` for remote servers; any `{org}__{repo}.json` for
   GitHub-hosted ones). The `name` field must match the file name, which must match the
   name derived from the URL (see [Layout](#layout) above). Without a manifest the site
   lists the server as a bare unevaluated placeholder.
3. For servers meant to be installable from the Archestra platform's registry picker, set
   `archestra_config.works_in_archestra: true` and fill in `server` / `oauth_config` — the
   picker only shows entries with that flag.
4. Open a pull request. CI validates the catalog data against the website's schema.

After a change lands on `main`, `.github/workflows/trigger-website-deploy-on-catalog-changes.yml`
redeploys the website so the catalog updates on archestra.ai.

## Updating servers

Manifests are maintained by hand — PRs welcome (e.g. fixing a category, description, or a
server config that doesn't install). There is no automated evaluation/scoring pipeline;
`quality_score` values are static data carried over from the historical evaluations.
