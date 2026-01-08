# Archestra Coding Agent

A custom MCP server that combines [Serena's](https://github.com/oraios/serena) semantic code editing capabilities with Git/GitHub operations, packaged as a Docker image for Archestra's K8s-based MCP server runtime.

## Features

### From Serena (Semantic Code Operations)
- **Symbol-level code retrieval**: `find_symbol`, `find_referencing_symbols`
- **Symbol-level editing**: `replace_symbol_body`, `insert_after_symbol`, `insert_before_symbol`
- **File operations**: `create_text_file`, `read_file`
- **Shell execution**: `execute_shell_command`
- **Language server support**: 30+ languages via LSP

### Custom Git Tools
- `git_clone` - Clone a repository to the workspace
- `git_status` - Get current git status
- `git_diff` - Show uncommitted changes
- `git_commit` - Stage and commit changes
- `git_push` - Push commits to remote
- `git_checkout_branch` - Create or switch branches

### Custom GitHub Tools
- `github_create_pr` - Create a pull request
- `github_list_prs` - List open pull requests
- `github_get_issue` - Get issue details

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token for API operations |
| `WORKSPACE_DIR` | No | Directory for cloned repos (default: `/workspace`) |

## Building

```bash
# Build the Docker image
make build

# Build and push to GCP Artifact Registry
make push
```

## Usage in Archestra

1. Add this MCP server to the internal catalog
2. Create a profile with this server assigned
3. Configure `GITHUB_TOKEN` in the server's environment variables
4. Start coding!

## Local Testing

### Build and Run Locally

```bash
# Build the Docker image
make build

# Run with a GitHub token
export GITHUB_TOKEN=your-token-here
make run

# Or run an interactive shell for debugging
make shell
```

### Test the MCP Server

1. Build the image: `make build`
2. Start the container:
   ```bash
   docker run -it --rm \
     -e GITHUB_TOKEN=$GITHUB_TOKEN \
     -v $(pwd)/workspace:/workspace \
     -p 9121:9121 \
     europe-west1-docker.pkg.dev/friendly-path-465518-r6/archestra-public/archestra-coding-agent:0.0.1
   ```
3. Connect an MCP client to the server on port 9121

### Run Unit Tests

```bash
# Install test dependencies
pip install -r requirements.txt pytest

# Run tests
make test
```

## Adding to Archestra Internal Catalog

Use the `catalog-entry.json` file to add this MCP server to the internal catalog:

1. Go to the MCP Catalog page in Archestra
2. Click "Add Internal Server"
3. Import the configuration from `catalog-entry.json`
4. Or use the API:
   ```bash
   curl -X POST http://localhost:9000/api/internal-mcp-catalog \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_API_KEY" \
     -d @catalog-entry.json
   ```

## Development

```bash
# Install dependencies
pip install -r requirements.txt

# Run tests
pytest tests/ -v
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    K8s Pod                              │
│  ┌─────────────────────────────────────────────────┐   │
│  │           archestra-coding-agent                 │   │
│  │  ┌─────────────┐  ┌─────────────────────────┐   │   │
│  │  │   Serena    │  │   Custom Git/GitHub     │   │   │
│  │  │  MCP Server │  │        Tools            │   │   │
│  │  └──────┬──────┘  └───────────┬─────────────┘   │   │
│  │         │                     │                  │   │
│  │         └─────────┬───────────┘                  │   │
│  │                   ▼                              │   │
│  │         ┌─────────────────┐                      │   │
│  │         │  /workspace     │                      │   │
│  │         │  (cloned repo)  │                      │   │
│  │         └─────────────────┘                      │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

