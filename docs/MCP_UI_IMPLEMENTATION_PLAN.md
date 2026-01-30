# MCP UI Support Implementation Plan for Archestra

## Overview

This document outlines the implementation strategy for integrating MCP UI support into Archestra Chat UI, MCP Gateway, and LLM Gateway. The goal is to enable interactive UI components from MCP servers to be rendered directly in the chat interface.

## Architecture

### 1. Frontend MCP UI Rendering

**Location**: `/platform/frontend/src/components/chat/mcp-ui-renderer.tsx`

The frontend will render MCP UI resources in iframes with full postMessage support. Key responsibilities:

- **Detect MCP UI Resources**: Identify tool results containing `_meta.ui.resourceUri` metadata
- **Create Iframe**: Spawn a sandboxed iframe with the UI resource URL
- **Implement postMessage Contract**: Handle all MCP UI message types:
  - `intent` - User interactions that should trigger tool calls
  - `notify` - Notifications from the UI
  - `prompt` - Requests to run prompts
  - `tool` - Requests to execute tools
  - `link` - Navigation requests
  - `ui-size-change` - Iframe resize notifications
  - `ui-request-data` - Data requests from iframe
  - `ui-request-render-data` - Render data requests

**Implementation Details**:

```typescript
// MCP UI Renderer Component
interface MCPUIRendererProps {
  resourceUri: string;
  toolName: string;
  onToolCall: (toolName: string, params: Record<string, unknown>) => Promise<unknown>;
  onPrompt: (prompt: string) => Promise<unknown>;
  onNavigate: (url: string) => void;
}

// Handle postMessage from iframe
window.addEventListener('message', (event) => {
  if (event.origin !== trustedOrigin) return;
  
  switch (event.data.type) {
    case 'intent':
      // Handle user intent (e.g., create-task)
      break;
    case 'tool':
      // Execute tool call
      onToolCall(event.data.payload.toolName, event.data.payload.params);
      break;
    case 'prompt':
      // Run prompt through chat
      onPrompt(event.data.payload.prompt);
      break;
    case 'ui-size-change':
      // Resize iframe
      iframeElement.style.height = event.data.payload.height + 'px';
      break;
  }
});
```

### 2. Tool Output Rendering Enhancement

**Location**: `/platform/frontend/src/components/ai-elements/tool.tsx`

Modify `ToolOutput` component to detect and render MCP UI resources:

```typescript
export const ToolOutput = ({
  output,
  ...props
}: ToolOutputProps) => {
  // Check if output contains MCP UI resource
  const mcpUIResource = detectMCPUIResource(output);
  
  if (mcpUIResource) {
    return (
      <MCPUIRenderer
        resourceUri={mcpUIResource.resourceUri}
        toolName={props.toolName}
        onToolCall={handleToolCall}
        onPrompt={handlePrompt}
        onNavigate={handleNavigate}
      />
    );
  }
  
  // Existing rendering logic for non-UI outputs
  return <div>{/* existing code */}</div>;
};
```

### 3. MCP Gateway Enhancement

**Location**: `/platform/backend/src/routes/mcp-gateway.ts`

The MCP Gateway needs to:

1. **Preserve UIResource Metadata**: Ensure `_meta.ui.resourceUri` passes through unchanged
2. **Add UI Action Routing**: Handle tool calls triggered from UI iframes
3. **Add UI Capability Discovery**: Expose UI capabilities in server discovery

**Key Changes**:

```typescript
// In createAgentServer
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const mcpTools = await ToolModel.getMcpToolsByAgent(agentId);
  
  return {
    tools: mcpTools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
      // Preserve UI metadata if present
      _meta: tool._meta || {},
    }))
  };
});

// Tool result handling - preserve UI resources
const result = await mcpClient.executeToolCall(toolCall, agentId, tokenAuth);

// Ensure result.content preserves UIResource structure
return {
  content: Array.isArray(result.content)
    ? result.content.map(item => ({
        ...item,
        // Preserve _meta for UI resources
        _meta: item._meta || {}
      }))
    : [{ type: "text", text: JSON.stringify(result.content), _meta: {} }],
  isError: result.isError,
};
```

### 4. LLM Gateway Enhancement

**Location**: `/platform/backend/src/routes/llm-gateway.ts` (if exists)

The LLM Gateway needs to:

1. **Normalize UIResources**: Ensure LLM-generated UIResources have consistent structure
2. **Route UI Actions**: Handle tool calls from UI interactions
3. **Maintain Consistency**: Present same interface as MCP Gateway

### 5. Tool Result Content Structure

Tool results from MCP servers should preserve this structure:

```typescript
interface ToolResult {
  type: "text" | "image" | "resource";
  text?: string;
  url?: string;
  mimeType?: string;
  _meta?: {
    ui?: {
      resourceUri?: string;  // URL to MCP UI resource
      resourceType?: string; // e.g., "html", "remote-dom"
    }
  }
}
```

## Implementation Steps

### Phase 1: Frontend MCP UI Rendering
1. Create `MCPUIRenderer` component with iframe management
2. Implement postMessage handler for all MCP UI message types
3. Add iframe lifecycle management (ready, resize, cleanup)
4. Integrate into `ToolOutput` component
5. Add security checks (origin validation, sandbox attributes)

### Phase 2: MCP Gateway Enhancement
1. Ensure tool results preserve `_meta.ui` metadata
2. Add UI capability discovery endpoint
3. Test with real MCP servers that return UI resources
4. Add logging for UI resource handling

### Phase 3: LLM Gateway Enhancement
1. Implement UIResource normalization for LLM responses
2. Ensure routing consistency with MCP Gateway
3. Add UI action handling

### Phase 4: Testing & Catalog Integration
1. Test with 2 real MCPs that support UI:
   - MCP A: Simple HTML UI
   - MCP B: Interactive remote-dom UI
2. Add MCPs to catalog with UI documentation
3. Create demo showing all 4 steps working

## Message Flow Diagram

```
User Interaction in Chat
    ↓
Chat UI renders tool result
    ↓
Detects _meta.ui.resourceUri
    ↓
Creates iframe with resource URL
    ↓
Iframe loads and renders UI
    ↓
User interacts with UI
    ↓
Iframe sends postMessage (intent/tool/prompt)
    ↓
Chat UI receives message
    ↓
Executes tool call or prompt
    ↓
Result flows back through MCP Gateway
    ↓
UI updates or new message appears
```

## Security Considerations

1. **Origin Validation**: Only accept postMessages from trusted origins
2. **Sandbox Attributes**: Use `sandbox="allow-scripts allow-same-origin"` for iframe
3. **Message Validation**: Validate message structure before processing
4. **Tool Call Validation**: Ensure tool calls are authorized for the current agent
5. **Content Security Policy**: Restrict iframe capabilities appropriately

## Testing Strategy

### Unit Tests
- Message parsing and routing
- Origin validation
- Tool call authorization

### Integration Tests
- Full message flow from iframe to tool execution
- Resize handling
- Error handling

### End-to-End Tests
- Demo with real MCPs
- Multiple concurrent UIs
- Navigation and data requests

## Success Criteria

1. ✅ MCP UI resources render in iframes
2. ✅ postMessage contract fully implemented
3. ✅ Tool calls from UI execute successfully
4. ✅ MCP Gateway preserves UI metadata
5. ✅ LLM Gateway handles UI resources
6. ✅ 2 real MCPs tested and documented
7. ✅ Demo showing all 4 steps working

## References

- [MCP UI Embeddable UI Guide](https://mcpui.dev/guide/embeddable-ui)
- [MCP Apps Standard](https://mcpui.dev/guide/mcp-apps)
- [MCP-UI GitHub Repository](https://github.com/MCP-UI-Org/mcp-ui)
