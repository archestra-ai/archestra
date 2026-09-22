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

Open an [Add an MCP server](https://github.com/archestra-ai/archestra/issues/new?template=add-mcp-server.yml)
issue with the server URL, description, and category. Maintainers add the entry.
To change an existing entry, open a plain issue that names the entry.

The entry format is described in the
[catalog entry skill](../.agents/skills/archestra-mcp-catalog-entry/SKILL.md).

A merged change shows up on the catalog page automatically — a workflow triggers a
website deploy whenever catalog data lands on `main`.
