# Test MCPs for MCP UI Support

This document outlines the strategy for testing MCP UI support in Archestra with real MCP servers.

## MCP UI Test Strategy

### MCP A: Simple HTML UI (External URL)
**Purpose**: Test basic iframe rendering with external URLs

**Implementation**:
- Tool: `showExternalUrl` - Renders an iframe pointing to an external URL
- Resource: HTML page with simple content
- Test Flow:
  1. Call tool with URL parameter
  2. Tool returns resource with `_meta.ui.resourceUri`
  3. Frontend detects and renders in iframe
  4. Verify iframe loads and displays content

**Example Response**:
```json
{
  "type": "resource",
  "resource": {
    "uri": "https://example.com/demo.html",
    "mimeType": "text/html",
    "_meta": {
      "ui": {
        "resourceUri": "https://example.com/demo.html",
        "resourceType": "html"
      }
    }
  }
}
```

### MCP B: Interactive Remote DOM UI
**Purpose**: Test interactive UI with postMessage communication

**Implementation**:
- Tool: `showRemoteDom` - Renders interactive UI with custom components
- Resource: HTML with JavaScript that uses postMessage
- Test Flow:
  1. Call tool with parameters
  2. Tool returns resource with interactive UI
  3. User interacts with UI (button click, form submission)
  4. UI sends postMessage with intent/tool action
  5. Frontend executes tool call
  6. Result flows back to UI via postMessage
  7. UI updates dynamically

**Example Response**:
```json
{
  "type": "resource",
  "resource": {
    "uri": "data:text/html,<html>...</html>",
    "mimeType": "text/html",
    "_meta": {
      "ui": {
        "resourceUri": "data:text/html,<html>...</html>",
        "resourceType": "remote-dom"
      }
    }
  }
}
```

## Implementation Steps

### Step 1: Create Test MCP Servers

#### Option A: Use Existing MCP-UI Examples
Reference the official MCP-UI TypeScript server demo:
- Location: `https://github.com/MCP-UI-Org/mcp-ui/tree/main/examples/typescript-server-demo`
- Tools: `showExternalUrl`, `showRawHtml`, `showRemoteDom`
- Setup: Clone and run locally

#### Option B: Create Custom Test Servers
Create minimal MCP servers for testing:

**Simple HTML Server** (`test-mcp-simple-ui.ts`):
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({
  name: "test-simple-ui",
  version: "1.0.0",
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "show_html",
      description: "Display a simple HTML UI",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "UI title" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === "show_html") {
    const title = (params.arguments as any).title || "Test UI";
    const html = `
      <html>
        <body style="font-family: sans-serif; padding: 20px;">
          <h1>${title}</h1>
          <p>This is a test UI resource</p>
          <button onclick="alert('Button clicked!')">Click Me</button>
        </body>
      </html>
    `;
    
    return {
      content: [
        {
          type: "resource",
          resource: {
            uri: `data:text/html,${encodeURIComponent(html)}`,
            mimeType: "text/html",
            _meta: {
              ui: {
                resourceUri: `data:text/html,${encodeURIComponent(html)}`,
                resourceType: "html",
              },
            },
          },
        },
      ],
    };
  }
  
  throw new Error(`Unknown tool: ${params.name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Interactive UI Server** (`test-mcp-interactive-ui.ts`):
```typescript
// Similar structure but with postMessage handler
// Tool returns HTML with JavaScript that communicates via postMessage
```

### Step 2: Register MCPs in Archestra

1. Add MCPs to Archestra catalog:
   - Name: "Test Simple UI"
   - URL: `http://localhost:3001` (for simple server)
   - Type: `stdio` or `http`

2. Add MCPs to Archestra catalog:
   - Name: "Test Interactive UI"
   - URL: `http://localhost:3002` (for interactive server)
   - Type: `stdio` or `http`

### Step 3: Test in Archestra Chat

1. **Test Simple HTML UI**:
   - Open chat
   - Call tool: `test_simple_ui.show_html` with title parameter
   - Verify: UI renders in iframe
   - Verify: HTML content displays correctly

2. **Test Interactive UI**:
   - Open chat
   - Call tool: `test_interactive_ui.show_interactive` with parameters
   - User interaction: Click button in UI
   - Verify: postMessage sent to parent
   - Verify: Tool call executed
   - Verify: Result returned to iframe
   - Verify: UI updates dynamically

### Step 4: Verify All 4 Steps

✅ **Step 1**: MCP UI support in Archestra Chat UI
- Frontend detects `_meta.ui.resourceUri`
- Creates iframe with resource
- Implements postMessage protocol

✅ **Step 2**: MCP Gateway passes UI resources
- Tool results preserve `_meta.ui` metadata
- Gateway doesn't mutate UI resource structure
- UI metadata survives RPC boundary

✅ **Step 3**: LLM Gateway handles UI resources
- LLM-generated UIResources normalized
- Consistent with MCP Gateway format
- Tool calls from UI routed correctly

✅ **Step 4**: Real MCPs tested
- 2 MCPs with different UI types
- Full flow tested end-to-end
- Added to catalog with documentation

## Expected Outcomes

### Frontend Rendering
- ✅ Iframe loads and displays UI
- ✅ postMessage communication works
- ✅ Tool calls execute successfully
- ✅ Results flow back to UI

### Gateway Support
- ✅ UI metadata preserved through gateway
- ✅ Tool calls from UI routed correctly
- ✅ No data loss or mutation
- ✅ Logging shows UI resource handling

### Catalog Integration
- ✅ MCPs registered with UI capabilities
- ✅ Documentation shows UI support
- ✅ Demo shows all 4 steps working
- ✅ Users can easily enable UI MCPs

## Demo Scenario

**Chat Session**:
```
User: "Show me a demo UI"
