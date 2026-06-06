# Windmill MCP Server

An MCP server that connects AI agents in Archestra to [Windmill](https://windmill.dev) — the open-source workflow automation platform.

Agents can list, trigger, and inspect Windmill flows. When a flow is opened, Archestra renders the **Windmill visual flow editor** as an interactive MCP App, giving users a live node-graph view of their automation pipelines.

## Features

- **`windmill_list_flows`** — browse all flows in your workspace with editor URLs
- **`windmill_get_flow`** — fetch flow definition + open the visual editor as an MCP App
- **`windmill_run_flow`** — trigger a flow with custom inputs, returns job ID
- **`windmill_run_flow_and_wait`** — trigger and block for result (≤60 s flows)
- **`windmill_get_job`** — poll job status and retrieve results
- **`windmill_list_jobs`** — list recent job runs
- **`windmill_list_scripts`** — browse available scripts

## Example: Confluence → Email flow

```
1. windmill_list_flows
   → finds "f/team/confluence_to_email" in the list

2. windmill_run_flow_and_wait
   path = "f/team/confluence_to_email"
   args = {"space": "DOCS", "recipient": "alice@example.com"}
   → flow runs, email sent, result returned
```

## Configuration

| Variable | Required | Description |
|---|---|---|
| `WINDMILL_BASE_URL` | ✅ | Base URL of your Windmill instance (e.g. `https://app.windmill.dev`) |
| `WINDMILL_TOKEN` | ✅ | API token — generate at **Windmill → Account → Tokens** |
| `WINDMILL_WORKSPACE` | ✅ | Workspace slug (e.g. `my-org`) |

## Adding to Archestra

1. Go to **MCP Catalog → Add Internal Server**
2. Import `catalog-entry.json`
3. Enter your Windmill credentials when prompted

Or via the API:

```bash
curl -X POST http://localhost:9000/api/internal-mcp-catalog \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -d @catalog-entry.json
```

## Local development

```bash
# Install dependencies
pip install -r requirements.txt

# Run tests
pytest tests/ -v

# Run the server manually (requires env vars)
export WINDMILL_BASE_URL=https://app.windmill.dev
export WINDMILL_TOKEN=<your-token>
export WINDMILL_WORKSPACE=<your-workspace>
python -m windmill_mcp.server
```

## Docker

```bash
docker build -t windmill-mcp .

docker run --rm \
  -e WINDMILL_BASE_URL=https://app.windmill.dev \
  -e WINDMILL_TOKEN=<your-token> \
  -e WINDMILL_WORKSPACE=<your-workspace> \
  windmill-mcp
```

## Architecture

```
Archestra Agent
      │
      │  MCP (stdio)
      ▼
┌─────────────────────┐
│   windmill-mcp      │
│  ┌───────────────┐  │
│  │ WindmillClient│  │  HTTP/REST
│  │  (httpx)      │──┼──────────► Windmill API
│  └───────────────┘  │
│                     │
│  Returns editor URL │
│  as MCP App resource│──────────► Archestra iframe
└─────────────────────┘             (visual node editor)
```
