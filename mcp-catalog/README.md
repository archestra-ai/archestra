# MCP Catalog

The data behind the [Archestra MCP Catalog](https://www.archestra.ai/mcp-catalog) — quality evaluations for open-source MCP servers — plus the open-source script that scores them.

This directory is public so the community can contribute catalog entries. The Archestra website builds the catalog page from these files.

## Contribute a server

1. Add or edit a JSON file under `data/mcp-evaluations/<owner>__<repo>.json`.
2. Open a pull request against this repository.

A merged pull request shows up on the catalog page after the next website build.

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
