# MCP Servers Catalog

This document describes the MCP (Model Context Protocol) servers available in the Archestra catalog.

## Overview

Archestra provides a curated catalog of MCP servers that can be installed and used by AI agents. These servers provide various capabilities from file operations to persistent memory.

## Available MCP Servers

### Filesystem MCP Server

**Catalog ID:** `filesystem-mcp-server`

**Description:** Secure file system operations for AI agents.

**Tools Provided:**
- `read_file` - Read file contents
- `write_file` - Write content to files
- `list_directory` - List directory contents
- `search_files` - Search for files by pattern
- `get_file_info` - Get file metadata
- `create_directory` - Create new directories
- `move_file` - Move/rename files
- `delete_file` - Delete files

**Configuration:**
- **Workspace Path:** Directory where the AI agent can operate (required, prompted on installation)
- **Transport:** stdio

**Installation:**
1. Go to MCP Registry at `/mcp/registry`
2. Find "filesystem-mcp" in the catalog
3. Click Install
4. Enter the workspace directory path
5. Assign to agents or profiles

**Security Notes:**
- The AI agent will have full read/write access to the configured workspace directory
- Choose a dedicated directory for AI operations
- Avoid granting access to system directories

---

### Memory MCP Server

**Catalog ID:** `memory-mcp-server`

**Description:** Knowledge graph-based persistent memory for AI agents.

**Tools Provided:**
- `create_entity` - Create a new memory entity
- `create_relation` - Create relations between entities
- `add_observation` - Add observations to entities
- `search_memories` - Search stored memories
- `read_graph` - Read the entire knowledge graph
- `delete_entity` - Delete an entity
- `delete_relation` - Delete a relation

**Configuration:**
- **Memory File Path:** Where to store persistent memory (default: `~/.mcp-memory.json`)
- **Transport:** stdio

**Installation:**
1. Go to MCP Registry at `/mcp/registry`
2. Find "memory-mcp" in the catalog
3. Click Install
4. Optionally configure custom storage path
5. Assign to agents or profiles

**Use Cases:**
- Maintaining context across conversations
- Storing user preferences
- Building knowledge bases
- Tracking long-term tasks

---

## Using MCP Servers in Chat

Once installed and assigned to a profile, MCP servers are automatically available in Chat:

1. Create or select a profile with the MCP server assigned
2. Start a new conversation with that profile
3. The AI will automatically use MCP tools when needed

## Testing MCP Servers

### Manual Testing

1. Install the MCP server from the registry
2. Check server status in the MCP Server list
3. View logs using the Logs button
4. Test tools via the Chat interface

### Automated Testing

The MCP catalog entries include automated tests in `backend/src/database/seed-mcp-catalog.test.ts`.

## Adding New MCP Servers

To add a new MCP server to the catalog:

1. Create a seed function in `backend/src/database/seed.ts`
2. Define the catalog entry with `localConfig` or `remoteConfig`
3. Add the function call to `seedRequiredStartingData()`
4. Create tests in `seed-mcp-catalog.test.ts`
5. Update this documentation

## Technical Details

### Transport Types

- **stdio:** Standard input/output communication (serial, one request at a time)
- **streamable-http:** HTTP/SSE transport (concurrent requests, better performance)

### Environment Variables

MCP servers can be configured with environment variables:
- `plain_text`: Visible configuration values
- `secret`: Hidden values stored in the secrets manager
- `directory`: File system paths (validated)
- `file`: File paths (validated)
- `boolean`: True/false values
- `number`: Numeric values

## Troubleshooting

### Server Not Starting

1. Check logs in MCP Server details
2. Verify environment configuration
3. Ensure the npx package is available

### Tools Not Available

1. Verify the server is assigned to your profile
2. Check if the server is running
3. Refresh the chat session

### Memory Not Persisting

1. Check if the memory file path is writable
2. Verify the server has disk access
3. Check server logs for errors
