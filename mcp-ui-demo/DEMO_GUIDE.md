# MCP UI Demo Guide for Archestra PR #2248

## Overview

This guide walks through creating a demo video that shows all 4 bounty requirements:

1. ✅ MCP UI support in Archestra Chat UI
2. ✅ Works via MCP Gateway (3rd party UI)
3. ✅ Works via LLM Gateway (same transport)
4. ✅ Test 2 MCPs with UI & add to catalog

**Target demo length:** 2-3 minutes

---

## Prerequisites

1. Run the setup script:
   ```bash
   ./setup.sh
   ```

2. Start the MCP servers:
   ```bash
   ./run-servers.sh
   # Select option 4 to run all servers
   ```

3. Have Archestra running locally or use staging environment

4. Screen recording software (OBS, Loom, QuickTime, etc.)

---

## Demo Script

### Part 1: MCP UI in Archestra Chat (30-45 seconds)

**What to show:** UIResource rendering directly in chat

**Script:**
> "First, let me show MCP UI support in Archestra's chat interface."

**Steps:**

1. Open Archestra chat
2. Connect to the MCP-UI demo server (localhost:3000)
3. In chat, trigger the `showRawHtml` tool:
   ```
   Use the showRawHtml tool to display a simple form
   ```
4. **Show:** The HTML form renders inline in the chat
5. **Interact:** Click buttons/fill form to show it's interactive

6. Trigger `showExternalUrl` tool:
   ```
   Use showExternalUrl to embed https://example.com
   ```
7. **Show:** External URL renders in sandboxed iframe

8. Trigger `showRemoteDom` tool:
   ```
   Use showRemoteDom to display an interactive component
   ```
9. **Show:** Remote DOM component with live interactivity

**Key points to highlight:**
- "Notice the UIResource renders inline in the chat"
- "The content is sandboxed for security"
- "Interactive elements work - I can click this button"

---

### Part 2: MCP Gateway Integration (30 seconds)

**What to show:** UIResource flows through MCP Gateway unchanged

**Script:**
> "Now let me show this works through Archestra's MCP Gateway."

**Steps:**

1. Go to MCP Gateway logs or settings
2. Show the MCP server is connected via gateway
3. Make another tool call that returns UIResource
4. **Show:** The UIResource flows through gateway and renders

**Key points to highlight:**
- "The MCP Gateway acts as a passthrough proxy"
- "UIResource objects flow through unchanged"
- "No special configuration needed"

---

### Part 3: LLM Gateway Integration (30 seconds)

**What to show:** Same flow works via LLM Gateway

**Script:**
> "The same integration works through the LLM Gateway."

**Steps:**

1. Show LLM Gateway configuration (if visible)
2. Make a tool call via LLM that returns UIResource
3. **Show:** UIResource renders correctly

**Key points to highlight:**
- "Same transport, same result"
- "LLM can trigger MCP tools that return UI"

---

### Part 4: Two MCP Servers with UI in Catalog (45-60 seconds)

**What to show:** Add 2 MCP servers to Archestra catalog

**Script:**
> "Finally, let me add two MCP servers with UI functionality to Archestra's catalog."

**Server 1: MCP-UI Demo Server**

1. Go to Archestra MCP Catalog
2. Click "Add Server" or "Request Installation"
3. Add the MCP-UI demo server:
   - Name: `mcp-ui-demo`
   - Description: "MCP-UI Demo Server with HTML, URL, and RemoteDOM support"
   - Transport: HTTP
   - URL: `http://localhost:3000/mcp`
4. **Show:** Server appears in catalog
5. Connect and test a tool

**Server 2: Three.js Visualization Server**

1. Add the Three.js server:
   - Name: `threejs-visualization`
   - Description: "Interactive 3D visualization using Three.js"
   - Transport: HTTP
   - URL: `http://localhost:3001/mcp`
2. **Show:** Server appears in catalog
3. Connect and trigger a 3D visualization
4. **Show:** 3D UI renders in chat

**Key points to highlight:**
- "Both servers are now in the Archestra catalog"
- "Users can discover and install them"
- "Each provides different UI functionality"

---

### Closing (15 seconds)

**Script:**
> "To summarize: We've added MCP UI support to Archestra, verified it works through both gateways, and added two MCP servers with UI functionality to the catalog. The implementation handles all three UIResource types: HTML, external URLs, and remote DOM components."

---

## Demo Checklist

Before recording, verify:

- [ ] MCP-UI demo server running on port 3000
- [ ] Three.js server running on port 3001
- [ ] Archestra is running and accessible
- [ ] Screen recording software ready
- [ ] Microphone working (if doing voiceover)

During recording, show:

- [ ] `showRawHtml` tool → HTML renders inline
- [ ] `showExternalUrl` tool → External URL in iframe
- [ ] `showRemoteDom` tool → Interactive remote component
- [ ] MCP Gateway connection working
- [ ] LLM Gateway connection working
- [ ] Add MCP-UI demo server to catalog
- [ ] Add Three.js server to catalog
- [ ] Both servers functional from catalog

---

## Troubleshooting

### Server won't start
```bash
# Check if port is in use
lsof -i:3000

# Kill process on port
kill $(lsof -ti:3000)
```

### UIResource not rendering
1. Check browser console for errors
2. Verify the tool response contains valid UIResource
3. Check that `uri` starts with `ui://`
4. Verify `mimeType` is one of:
   - `text/html`
   - `text/uri-list`
   - `application/vnd.mcp-ui.remote-dom`

### MCP Gateway issues
1. Check gateway logs for connection errors
2. Verify server URL is accessible from gateway
3. Check CORS headers if needed

---

## Sample Tool Prompts

Use these prompts in Archestra chat to trigger UI tools:

### MCP-UI Demo Server

```
Show me a raw HTML form using the showRawHtml tool
```

```
Display an external webpage using showExternalUrl with https://httpbin.org/html
```

```
Render an interactive component using showRemoteDom
```

### Three.js Server

```
Create a 3D visualization of a rotating cube
```

```
Show me an interactive 3D scene
```

---

## Uploading the Demo

After recording:

1. Upload to YouTube (unlisted), Loom, or similar
2. Add the link to PR #2248 description:

```markdown
## Demo Video

[Watch the demo](YOUR_VIDEO_LINK_HERE)

Demonstrates:
1. MCP UI support in Archestra Chat (text/html, text/uri-list, remote-dom)
2. Integration through MCP Gateway
3. Integration through LLM Gateway
4. Two MCP servers added to catalog (mcp-ui-demo, threejs-visualization)
```

3. Update the PR acceptance criteria checkbox:
```markdown
- [x] Test with MCP servers with UI functionality
```
