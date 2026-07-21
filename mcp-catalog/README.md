# MCP Catalog

The data behind the [Archestra MCP Catalog](https://www.archestra.ai/mcp-catalog) — quality evaluations for open-source MCP servers — plus the open-source script that scores them.

This directory is public so the community can contribute catalog entries. The Archestra website builds the catalog page from these files.

## Contribute a server

1. Add the server's URL to `data/mcp-servers.json` — a GitHub repository URL, or the
   endpoint URL for a remote MCP server. An entry only appears in the catalog if its URL
   is listed here.
2. Add or edit its JSON file under `data/mcp-evaluations/`. The file name (and its `name`
   field) must match the name the catalog derives from the URL:
   - GitHub: `<owner>__<repo>.json` (plus `__<path segments>` for monorepo subdirectories)
   - Remote: `<domain>__remote-mcp.json`, where the domain is the hostname minus any
     leading `www.`/`mcp.`/`api.` and everything after the first dot
     (`https://mcp.linear.app/mcp` → `linear__remote-mcp.json`)

   Copy an existing entry as a template. Set `archestra_config.works_in_archestra: true`
   (with a filled-in `server`/`oauth_config`) for servers the Archestra platform's
   registry picker should offer.

3. Open a pull request against this repository.

A merged pull request shows up on the catalog page automatically — a workflow triggers a
website deploy whenever catalog data lands on `main`.

## Data

- `data/mcp-evaluations/*.json` — one evaluation per server.
- `data/mcp-servers.json` — the master list of catalog servers.

## Scoring script

`scripts/evaluate-catalog.ts` generates and scores evaluations. It is the same script used to build the catalog, published here for transparency. Maintainers run it with:

```bash
pnpm install
pnpm evaluate
```

It reads and writes the files under `data/`. This directory is standalone — it is not part of the `platform/` pnpm workspace.
