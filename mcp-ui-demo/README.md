# MCP UI Demo for Archestra PR #2248

This directory contains scripts and guides for demonstrating MCP UI support in Archestra.

## Quick Start

```bash
# 1. Setup - clone repos and install dependencies
./setup.sh

# 2. Run servers
./run-servers.sh
# Select option 4 to run all servers

# 3. Follow the demo guide
# Open DEMO_GUIDE.md for step-by-step instructions
```

## Files

| File | Description |
|------|-------------|
| `setup.sh` | Clones MCP-UI and ext-apps repos, installs dependencies |
| `run-servers.sh` | Interactive menu to start/stop MCP servers |
| `test-ui-resource.sh` | Validates UIResource structure and runs tests |
| `DEMO_GUIDE.md` | Step-by-step demo recording guide |
| `mcp-servers-config.json` | MCP server configuration for Archestra |

## MCP Servers Included

### 1. MCP-UI TypeScript Demo
- **Port:** 3000
- **Tools:** `showExternalUrl`, `showRawHtml`, `showRemoteDom`
- **Best for:** Testing all 3 UIResource types

### 2. Three.js Visualization
- **Port:** 3001
- **UI Type:** Interactive 3D graphics
- **Best for:** Visual demo impact

### 3. Map Server
- **Port:** 3002
- **UI Type:** Geographic visualization
- **Best for:** Real-world use case

## Bounty Requirements Checklist

- [ ] MCP UI support in Archestra Chat UI
- [ ] Works via MCP Gateway
- [ ] Works via LLM Gateway
- [ ] Test 2 MCPs with UI & add to catalog
- [ ] Demo video showing all 4 steps

## UIResource Types Supported

| MIME Type | Description | Example |
|-----------|-------------|---------|
| `text/html` | Inline HTML content | Forms, cards, tables |
| `text/uri-list` | External URL (iframe) | Embedded websites |
| `application/vnd.mcp-ui.remote-dom` | Interactive JS components | React/Vue components |

## Troubleshooting

### Port already in use
```bash
# Find process using port
lsof -i:3000

# Kill it
kill $(lsof -ti:3000)
```

### Server won't start
```bash
# Re-run setup
./setup.sh

# Check node version (need 18+)
node --version
```

### Tests failing
```bash
# Run validation tests
./test-ui-resource.sh
```
