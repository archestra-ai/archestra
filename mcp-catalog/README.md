# MCP Catalog

The data behind the [Archestra MCP Catalog](https://www.archestra.ai/mcp-catalog).

This directory is public so the community can contribute catalog entries. The Archestra
website pulls it at build time and serves the catalog pages and API from it. Entries are
maintained by hand — there is no evaluation or scoring pipeline.

## Data

- `data/mcp-servers.json` — the master list: one URL per server (a GitHub repository URL,
  or the endpoint URL of a remote MCP server). An entry only appears in the catalog if its
  URL is listed here.
- `data/mcp-evaluations/*.json` — one manifest per server.

## Add a server

1. Add the server's URL to `data/mcp-servers.json`.
2. Add or edit its manifest under `data/mcp-evaluations/` — copy an existing entry as a
   template. The file name (and its `name` field) must match the name the catalog derives
   from the URL:
   - GitHub: `<owner>__<repo>.json` (plus `__<path segments>` for monorepo subdirectories)
   - Remote: `<domain>__remote-mcp.json`, where the domain is the hostname minus any
     leading `www.`/`mcp.`/`api.` and everything after the first dot
     (`https://mcp.linear.app/mcp` → `linear__remote-mcp.json`)

   Set `archestra_config.works_in_archestra: true` (with a filled-in
   `server`/`oauth_config`) for servers the Archestra platform's registry picker should
   offer.

3. Open a pull request against this repository.

A merged pull request shows up on the catalog page automatically — a workflow triggers a
website deploy whenever catalog data lands on `main`.
