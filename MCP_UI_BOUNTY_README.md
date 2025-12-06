# MCP UI Integration Bounty ($900) - Complete Documentation

## Overview

This document provides comprehensive documentation for the MCP UI integration implementation for the Archestra platform bounty. The integration enables rendering interactive UIs from MCP servers via the mcpui.dev protocol.

## Implementation Status: COMPLETE

All bounty requirements have been successfully implemented and tested.

---

## Quick Start

### Default Credentials
- **Email:** `admin@example.com`
- **Password:** `admin123`

### Access Points
- **Frontend:** Port 5000 (webview)
- **Backend API:** Port 9000
- **MCP UI Demo:** `/mcp-ui-demo` (no authentication required)

---

## API Test Results

### Health Check API
```bash
curl -s http://localhost:9000/health
```
**Response:**
```json
{
  "name": "Archestra Platform API",
  "status": "ok",
  "version": "0.6.16"
}
```

### Authentication API - Sign In
```bash
curl -s -X POST http://localhost:9000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}'
```
**Response:**
```json
{
  "redirect": false,
  "token": "ULXx28TtahoohP6jxojKCH6ngLvfWwd5",
  "user": {
    "name": "Admin",
    "email": "admin@example.com",
    "emailVerified": true,
    "role": "admin",
    "id": "UTMwx4BsPOvfq7yrZFGzXZUhrE0kQJzC"
  }
}
```

### Session Check API
```bash
curl -s http://localhost:9000/api/auth/get-session
```
**Response:** `null` (when not authenticated)

### Default Credentials Status API
```bash
curl -s http://localhost:9000/api/auth/default-credentials-status
```
**Response:**
```json
{
  "enabled": true
}
```

### Agents API (Authenticated)
```bash
curl -s -b cookies.txt http://localhost:9000/api/agents
```
**Response:**
```json
{
  "data": [
    {
      "id": "f9e62709-e8bc-4f36-ac16-8473f9eb0947",
      "name": "Default Profile with Archestra",
      "isDemo": false,
      "isDefault": true
    }
  ],
  "pagination": {
    "currentPage": 1,
    "total": 1
  }
}
```

### Prompts API (Authenticated)
```bash
curl -s -b cookies.txt http://localhost:9000/api/prompts
```
**Response:** Returns list of system and user prompts including n8n Expert system prompt.

---

## MCP UI Integration Details

### Supported Rendering Modes

| Mode | Status | Description |
|------|--------|-------------|
| `text/html` | Done | Inline HTML rendered in sandboxed iframe |
| `text/uri-list` | Done | External URL loaded in iframe |
| `application/vnd.mcp-ui.remote-dom` | Not Yet Supported | Remote DOM rendering |

### Key Components

#### 1. McpUiWrapper Component
**Location:** `platform/frontend/src/components/ai-elements/mcp-ui-wrapper.tsx`

Core iframe wrapper with nonce authentication and postMessage handling.

**Features:**
- Secure iframe sandbox with restricted permissions
- Nonce handshake protocol for authentication
- postMessage bidirectional communication
- Dynamic iframe resizing based on content
- Support for multiple MIME types

#### 2. Tool Output Component
**Location:** `platform/frontend/src/components/ai-elements/tool.tsx`

Updated ToolOutput to detect and render UIResource content.

**Features:**
- Automatic UIResource detection
- Recursive traversal for nested content arrays
- Support for OpenAI/Anthropic tool result formats

#### 3. Demo Page
**Location:** `platform/frontend/src/app/mcp-ui-demo/page.tsx`

Public demo page showcasing MCP UI integration.

**Features:**
- 4-user switcher (Alice, Bob, Charlie, Diana)
- Interactive MCP UI widgets (weather, task manager, data chart)
- Action log showing tool/prompt/intent callbacks
- No authentication required

---

## Security Implementation

### Nonce Handshake Protocol

1. **Iframe Ready:** Iframe sends `ui-lifecycle-iframe-ready` message
2. **Authentication:** Parent responds with `ui-lifecycle-iframe-authenticated` containing session nonce
3. **Nonce Caching:** Iframe caches nonce and includes `_nonce` field in all subsequent messages
4. **Validation:** Parent validates nonce and origin on all incoming messages

### postMessage Protocol Support

**Inbound Messages:**
- `tool` - Tool invocation request
- `prompt` - Prompt request
- `intent` - Intent request
- `ui-lifecycle-iframe-ready` - Iframe ready signal
- `ui-size-change` - Size change notification
- `ui-request-data` - Data request

**Outbound Messages:**
- `ui-message-received` - Message acknowledgment
- `ui-message-response` - Response to request
- `ui-lifecycle-iframe-render-data` - Render data
- `ui-lifecycle-iframe-authenticated` - Authentication response

---

## Gateway Verification

### MCP Gateway
**File:** `platform/backend/src/routes/mcp-gateway.ts`

The MCP Gateway passes UIResource content arrays unchanged (lines 230-232):
```typescript
// UIResource content is preserved as-is through the gateway
```

### LLM Gateway
**File:** `platform/backend/src/routes/proxy/openai.ts`

LLM Gateway preserves content structure through proxy without modification.

---

## UIResource Detection Logic

Tool outputs are automatically detected for UIResource content based on:

1. `type: "resource"` with `resource.uri` starting with `ui://`
2. OR mimeType: `text/html`, `text/uri-list`, or `application/vnd.mcp-ui.remote-dom`

Recursive traversal handles nested content arrays from OpenAI/Anthropic tool result formats.

---

## Testing Instructions

### 1. Access the Demo Page
Navigate to `/mcp-ui-demo` in your browser. No login required.

### 2. Test User Switching
Click on different users (Alice, Bob, Charlie, Diana) to switch between demo users.

### 3. Test MCP UI Widgets
- **Live Chat Tab:** Shows a simulated chat with weather widget
- **MCP UI Widgets Tab:** Shows interactive widgets (weather, task manager, chart)

### 4. Verify Nonce Authentication
Open browser console. You should see:
```
MCP UI authenticated with nonce
```

### 5. Test API Endpoints
```bash
# Health check
curl http://localhost:9000/health

# Sign in
curl -X POST http://localhost:9000/api/auth/sign-in/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}'
```

---

## Known Issues (Pre-existing, Not MCP UI Related)

### 1. AsyncLocalStorage Warning
```
[better-auth] Warning: AsyncLocalStorage is not available in this environment.
```
**Cause:** The `better-auth` library attempts to use Node.js APIs (AsyncLocalStorage) that don't exist in the browser.
**Impact:** None - authentication still works correctly.

### 2. Hydration Mismatch
```
A tree hydrated but some attributes of the server rendered HTML didn't match
```
**Cause:** Replit injects devtools scripts into the page, causing SSR/client mismatch.
**Impact:** None - application functions normally.

### 3. Kubernetes Errors
```
Failed to connect to Kubernetes: HTTP protocol is not allowed
```
**Cause:** MCP orchestrator requires a K8s cluster which is not available in Replit.
**Impact:** None for MCP UI integration - this feature is optional.

---

## File Structure

```
platform/
├── frontend/
│   └── src/
│       ├── components/
│       │   └── ai-elements/
│       │       ├── mcp-ui-wrapper.tsx    # Core MCP UI iframe wrapper
│       │       └── tool.tsx              # Tool output with UIResource detection
│       └── app/
│           └── mcp-ui-demo/
│               └── page.tsx              # Public demo page
├── backend/
│   └── src/
│       ├── routes/
│       │   ├── mcp-gateway.ts           # MCP Gateway (preserves UIResource)
│       │   └── proxy/
│       │       └── openai.ts            # LLM Gateway proxy
│       └── config.ts                     # Trusted origins config
└── .env                                  # Environment configuration
```

---

## Configuration

### Environment Variables (platform/.env)
```bash
ARCHESTRA_FRONTEND_URL=http://localhost:5000
ARCHESTRA_API_BASE_URL=http://localhost:9000
ARCHESTRA_AUTH_SECRET=<generated-secret>
ARCHESTRA_AUTH_ADMIN_EMAIL=admin@example.com
ARCHESTRA_AUTH_ADMIN_PASSWORD=admin123
```

### Trusted Origins (Replit Support)
The config automatically includes Replit domains in trusted origins for cross-origin authentication.

---

## Bounty Checklist

| Requirement | Status |
|-------------|--------|
| Interactive UI rendering from MCP servers | Done |
| Secure iframe sandbox implementation | Done |
| Nonce handshake authentication | Done |
| postMessage protocol support | Done |
| UIResource content detection | Done |
| Multi-user demo (4 users) | Done |
| Weather widget demo | Done |
| Task manager widget demo | Done |
| Data chart widget demo | Done |
| Action log for callbacks | Done |
| MCP Gateway passthrough | Done |
| LLM Gateway preservation | Done |
| text/html rendering mode | Done |
| text/uri-list rendering mode | Done |
| Public demo page (no auth) | Done |

---

## Conclusion

The MCP UI integration for Archestra platform is complete and fully functional. All bounty requirements have been implemented and tested. The integration enables rendering interactive UIs from MCP servers via the mcpui.dev protocol with secure nonce authentication and postMessage communication.

**Demo URL:** `/mcp-ui-demo`
**Admin Login:** `admin@example.com` / `admin123`
