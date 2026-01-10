# Archestra Platform Smoke Test Runbook

This runbook is designed for Claude Code to execute as an interactive smoke test of the Archestra platform. Each test verifies core platform functionality using browser automation via Playwright MCP tools.

## Prerequisites

Before starting, verify the development environment is running:

1. Run `tilt get uiresources` to verify Tilt is running
2. Navigate to `http://localhost:3000` to verify frontend is accessible
3. Navigate to `http://localhost:9000/health` to verify backend is accessible

---

## Test 1: Basic Chat with Empty Profile

**Objective**: Verify the chat feature works with a fresh profile that has no MCP tools assigned.

### Steps

1. Navigate to `http://localhost:3000/profiles`
2. Create a new profile named "Smoke Test Profile - Empty"
3. Navigate to Chat (`http://localhost:3000/chat`)
4. Select the newly created profile from the profile dropdown
5. Start a new conversation
6. Send message: "Hello, please introduce yourself briefly."

### Expected Result

- Chat responds with a coherent greeting/introduction
- No errors in the console
- Conversation appears in the sidebar

### Cleanup

- Note the profile ID for later deletion

---

## Test 2: GitHub MCP Server Installation and Tool Assignment

**Objective**: Verify MCP server installation from catalog and tool assignment to a profile.

### Steps

1. Navigate to MCP Catalog (`http://localhost:3000/mcp-catalog`)
2. Search for "github" in the catalog
3. Install the GitHub MCP server (if not already installed)
4. Wait for installation to complete
5. Navigate to the profile created in Test 1
6. Go to the Tools tab
7. Assign GitHub tools to the profile (at minimum: `list_issues`, `search_issues`, `whoami`)

### Expected Result

- GitHub MCP server appears in installed servers list
- Tools are successfully assigned to the profile
- Profile shows the assigned tools count

---

## Test 3: Disable Optimization Rules (Clean Baseline)

**Objective**: Ensure no cost optimization rules or tool result compression interfere with testing.

### Steps

1. Navigate to Cost Settings → Optimization Rules (`http://localhost:3000/cost/optimization-rules`)
2. Disable or delete any existing optimization rules
3. Navigate to Organization Settings
4. Ensure "Tool Result Compression (TOON)" is DISABLED at the organization level
5. If there are no existing optimization rules - try to refresh the page completely. Try this at most once.

### Expected Result

- TOON compression shows as "Disabled" in the UI
- No active optimization rules (or all are disabled)

---

## Test 4: GitHub Issues Overview (Initial Request)

**Objective**: Verify MCP tools execute correctly and return meaningful data.

### Steps

1. Navigate to Chat (`http://localhost:3000/chat`)
2. Select the profile with GitHub tools assigned
3. Start a new conversation
4. Send message: "Give a short overview of the open issues in https://github.com/archestra-ai/website"

### Expected Result

- Chat invokes `list_issues` or `search_issues` tool
- Returns a meaningful summary of issues (titles, counts, categories)
- Tool calls visible in LLM Proxy Logs (`http://localhost:3000/logs/llm-proxy`)

### Verification

1. Check LLM Proxy Logs for the request
2. Verify tool calls are recorded in MCP Gateway Logs (`http://localhost:3000/logs/mcp-gateway`)
3. Confirm response contains actual issue data

---

## Test 5: Tool Invocation Policy (Untrusted Data Blocking)

**Objective**: Verify that tool invocation is blocked when context contains untrusted data.

### Precondition

The previous conversation from Test 4 contains tool results (untrusted data by default).

### Steps

1. **In the same conversation from Test 4**, send another message:
   "github whoami"

This prompt forces a tool invocation (`get_me`) rather than allowing the LLM to answer from context.

### Expected Result

- Tool invocation is BLOCKED
- Response indicates tools cannot be invoked due to tool invocation policy
- Error message mentions "untrusted data" or "tool invocation policy"

### Verification

1. Check LLM Proxy Logs - should show blocked tool invocation
2. Interaction should be recorded with policy violation

### Alternative Test (if untrusted data policy doesn't exist)

Create a tool invocation policy:
1. Navigate to the profile's Policies tab
2. Create a Trusted Data Policy that marks `list_issues` results as untrusted
3. Retry the conversation

---

## Test 6: Tool Result Compression (TOON Format)

**Objective**: Verify TOON compression is applied to tool results when enabled.

### Steps

1. Navigate to Organization Settings
2. Enable "Tool Result Compression (TOON)" at organization level
3. Navigate to Chat and start a NEW conversation
4. Select the profile with GitHub tools
5. Send message: "Give a short overview of the open issues in https://github.com/archestra-ai/website"

### Expected Result

- Tool executes successfully
- In LLM Proxy Logs, the **processed request** shows tool results in TOON format

### TOON Format Verification

Look for compressed format in logs:
```
issues[N]{title,number,state,...}  // TOON format
```

Instead of standard JSON:
```json
[{"title": "...", "number": 1, "state": "open", ...}]
```

### Additional Step (if needed)

If `list_issues` is blocked in untrusted context due to Test 5:
1. Navigate to profile Policies
2. Add a Trusted Data Policy that allows `list_issues` execution in untrusted context
3. Retry the test

### Cleanup

- Keep TOON enabled for next test, or note to disable after testing

---

## Test 7: Model Optimization Rules

**Objective**: Verify cost optimization rules correctly swap models and display savings.

### Steps

1. Navigate to Cost Settings → Optimization Rules (`http://localhost:3000/cost/optimization-rules`)
2. Create a new optimization rule:
   - Provider: Based on the user prompt. 
   - Condition: `maxLength < 10000` 
   - Enabled: true
3. Navigate to Chat and start a NEW conversation
4. Send a short message that matches the rule condition:
   "Give a short overview of the open issues in https://github.com/archestra-ai/website"

### Expected Result

- Response includes cost optimization percentage indicator
- In LLM Proxy Logs, the interaction shows "optimized model" was used
- Cost savings are displayed in the UI or logs

### Verification

1. Check LLM Proxy Logs for the request
2. Look for `optimizedModel` field in the interaction data
3. Verify the model in the request differs from the original model specified

---

## Test 8: LLM Proxy Tool Discovery (External MCP Server)

**Objective**: Verify tools can be discovered via LLM Proxy when MCP server runs externally (not in Archestra's K8s).

### Precondition

This test requires an MCP server configured with "LLM Proxy" origin (tools fetched at request time rather than from K8s pods).

### Steps

1. Navigate to MCP Servers (`http://localhost:3000/mcp-servers`)
2. Create or verify an MCP server with:
   - Remote URL configuration (not local K8s)
   - Or use a catalog server that doesn't require K8s orchestration
3. Assign tools from this server to a test profile
4. In Chat, with that profile selected, send a message that would trigger tool discovery

### Expected Result

- Tools are discovered and available despite not running in Archestra's K8s
- Tool origin shows "LLMProxy" in the tools list
- Tools can be invoked successfully

### Verification

1. Check the Tools page for the profile
2. Look for "LLMProxy" origin indicator on tools
3. Verify tool invocation works in chat

---

## Cleanup Checklist

After completing all tests, clean up test data via the UI:

1. [ ] Delete "Smoke Test Profile - Empty" from Profiles page
2. [ ] Delete any other test profiles created

---

## Claude Code Execution Notes

When executing this runbook with Claude Code:

### Browser Automation

Use Playwright MCP tools:
- `mcp__playwright__browser_navigate` - Navigate to URLs
- `mcp__playwright__browser_snapshot` - Get page accessibility tree
- `mcp__playwright__browser_click` - Click elements
- `mcp__playwright__browser_type` - Type into inputs
- `mcp__playwright__browser_fill_form` - Fill form fields

### Test Isolation

- Start each major test in a NEW chat conversation
- Create fresh profiles rather than reusing
- Document all created resources for cleanup

### Failure Handling

If a test fails:
1. Capture a screenshot: `mcp__playwright__browser_take_screenshot`
2. Check console messages: `mcp__playwright__browser_console_messages`
3. Check network requests: `mcp__playwright__browser_network_requests`
4. Document the failure condition before proceeding

### Reporting

After each test, report:
- Test name and objective
- Steps executed
- Actual result vs expected result
- PASS/FAIL status
- Any relevant log entries or screenshots
