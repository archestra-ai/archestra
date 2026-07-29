---
name: archestra-mcp-catalog-entry
description: Use when adding a new MCP server to the public MCP catalog (mcp-catalog/data) or preparing/reviewing a catalog-entry PR. Derives the entry name from the server URL, live-probes remote servers to fill in tools/transport/auth, fetches and encodes the icon, and validates the manifest against the catalog schema before opening the PR.
---

# Add an MCP server to the Archestra MCP Catalog

The catalog is two files under `mcp-catalog/data/` (see `mcp-catalog/README.md`):

- `mcp-servers.json` — the master URL list. An entry only appears in the catalog if its URL is here.
- `mcp-evaluations/<name>.json` — one manifest per server.

Entries are maintained by hand — there is no scraping/evaluation pipeline. Your job is to
machine-fill everything that CAN be derived (name, tools, transport, icon, defaults) so the
human only supplies judgment calls (description quality, category, keywords).

## 1. Derive the entry name from the URL (do not guess)

The website derives the name from the URL; the filename and the manifest's `name` field must
match it exactly:

- **GitHub** `https://github.com/<owner>/<repo>` → `<owner>__<repo>` (lowercased).
  Monorepo path `…/tree/<branch>/<p1>/<p2>` → `<owner>__<repo>__<p1>__<p2>`.
- **Remote** endpoint → take the hostname, strip a leading `www.`/`mcp.`/`api.` (only those
  three), take everything before the first remaining dot, append `__remote-mcp`.
  - `https://mcp.linear.app/mcp` → `linear__remote-mcp`
  - `https://agenttools.wolfram.com/mcp` → `agenttools__remote-mcp` (NOT `wolfram__remote-mcp` — only `www./mcp./api.` are stripped)

## 2. Live-probe remote servers (machine-fill, don't transcribe docs)

For `server.type: "remote"`, verify the endpoint and extract facts directly:

```bash
# initialize — confirms the endpoint is live, speaks streamable HTTP, and whether auth is required
curl -sS -m 20 -X POST <url> -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"archestra-catalog","version":"1.0"}}}' -D -
```

- HTTP 200 with a `result` → no auth required (`archestra_config.oauth.required: false`, no `oauth_config`).
- HTTP 401/403 (often with `WWW-Authenticate` / resource metadata) → OAuth required; copy the
  `oauth_config` shape from an existing OAuth entry (e.g. `jam__remote-mcp.json`).
- Then call `tools/list` (reuse the `Mcp-Session-Id` response header if one was returned) and
  fill the manifest's `tools` array with the REAL tool names + descriptions, not the vendor docs.

## 3. Write the manifest

Copy a fresh entry as the template — `mcp-catalog/data/mcp-evaluations/excalidraw__remote-mcp.json`
(remote, no auth) or `jam__remote-mcp.json` (remote, OAuth). Current field set:

```jsonc
{
  "name": "<derived name>",              // must equal the filename
  "display_name": "<Human Name>",
  "description": "<1-3 factual sentences — trim vendor marketing speak>",
  "long_description": "<optional>",
  "author": { "name": "<Vendor>", "url": "<https://vendor.com/>" },
  "homepage": "<optional>",
  "documentation": "<optional>",
  "support": "<optional>",
  "icon": "data:image/svg+xml;base64,...", // see below
  "tools": [{ "name": "...", "description": "..." }],  // from the live tools/list
  "prompts": [],
  "keywords": ["..."],
  "user_config": {},
  "readme": null,
  "category": "<must exist in the website's McpServerCategorySchema>",
  "archestra_config": {
    "client_config_permutations": null,   // or real client config for local servers
    "oauth": { "provider": null, "required": false },
    "works_in_archestra": true            // only if you actually verified it connects
  },
  "server": { "type": "remote", "url": "<endpoint>", "docs_url": "<docs or null>" },
  "github_info": null,                    // remote servers; GitHub entries get repo info
  "programming_language": null            // null for remote servers
}
```

Do NOT add evaluation-era fields (`quality_score`, `last_scraped_at`, `evaluation_model`,
`framework`, `dependencies`, `raw_dependencies`, `protocol_features`, `score_breakdown`) —
the pipeline that filled them is gone and the schema no longer has them.

**Icon**: prefer the vendor's official SVG, inlined as a base64 data URI. Iconify shortcut:
`curl -s https://api.iconify.design/logos/<slug>.svg | base64`. Decode and eyeball it: static
SVG only — no `<script>`, no external refs, no event handlers.

**Category**: the allowed values live in the website repo,
`app/app/mcp-catalog/schemas.ts` → `McpServerCategorySchema`
(https://github.com/archestra-ai/website/blob/main/app/app/mcp-catalog/schemas.ts). When in
doubt grep existing entries: `grep -h '"category"' mcp-catalog/data/mcp-evaluations/*.json | sort | uniq -c`.

## 4. Validate before the PR

```bash
# JSON parses, name matches filename, URL present exactly once
python3 - << 'EOF'
import json
name = "<derived name>"
m = json.load(open(f"mcp-catalog/data/mcp-evaluations/{name}.json"))
assert m["name"] == name, "name != filename"
servers = json.load(open("mcp-catalog/data/mcp-servers.json"))
assert servers.count("<url>") == 1, "URL missing or duplicated in mcp-servers.json"
print("ok")
EOF
```

Format with prettier at print width 120 (the website's setting):
`npx prettier --write --print-width 120 mcp-catalog/data/mcp-evaluations/<name>.json mcp-catalog/data/mcp-servers.json`

If an `archestra-ai/website` checkout sits next to this repo, run the full schema validation
from `website/app`: `pnpm catalog:validate` (it reads the adjacent checkout).

## 5. Open the PR

One PR against this repo, both files, title `feat(mcp-catalog): add <display_name> MCP server`.
In the body: what the server is, transport/auth (as verified by the live probe, not the docs),
and the derived-name rule applied. A merged PR triggers a website deploy automatically —
no other repo needs changes unless you added a new category (that enum lives in the website repo).
