# Task: Fix Tool Execution Error Details Being Lost in Chat Error Response

## Problem Summary

When MCP tool execution fails in the chat feature, the actual error details are lost and users receive a generic "An unexpected error occurred. Please try again." message with an empty `raw: {}` object.

## Current Behavior

Error response returned to frontend:
```json
{
  "code": "unknown",
  "message": "An unexpected error occurred. Please try again.",
  "isRetryable": false,
  "originalError": {
    "provider": "gemini",
    "message": "Tool execution failed",
    "type": "Error",
    "raw": {}
  }
}
```

The actual error details from the MCP tool call are completely lost.

## Root Cause Analysis

### Error Flow

1. **Origin** - `backend/src/clients/chat-mcp-client.ts:621-626`
   ```typescript
   if (result.isError) {
     logger.error(
       { agentId, userId, toolName: mcpTool.name, result },
       "MCP tool execution failed",
     );
     throw new Error(result.error || "Tool execution failed");
   }
   ```
   - The actual error details are in `result.error`
   - They get wrapped in a generic `Error` object, losing structured information

2. **Caught at** - `backend/src/routes/chat/routes.ts:258-268`
   ```typescript
   onError: (error) => {
     const mappedError: ChatErrorResponse = mapProviderError(error, provider);
     return JSON.stringify(mappedError);
   }
   ```

3. **Mapped by** - `backend/src/routes/chat/errors.ts:818` (`mapProviderError`)
   - Function expects `APICallError` from Vercel AI SDK with `statusCode` and `responseBody`
   - Plain `Error` objects don't have these properties
   - Falls back to `ChatErrorCode.Unknown` with generic message

4. **Result** - Original error message is lost, `raw` object is empty

## Expected Behavior

The error response should preserve the actual error details:
```json
{
  "code": "unknown",
  "message": "An unexpected error occurred. Please try again.",
  "isRetryable": false,
  "originalError": {
    "provider": "gemini",
    "message": "GitHub API rate limit exceeded", // Actual error from MCP tool
    "type": "ToolExecutionError",
    "raw": {
      "toolName": "githubcopilot__remote-mcp__issue_write",
      "errorDetails": "..." // Original error details
    }
  }
}
```

## Files to Modify

### 1. `backend/src/clients/chat-mcp-client.ts`

Create a custom error class that preserves tool execution details:

```typescript
// Add new error class
export class ToolExecutionError extends Error {
  readonly toolName: string;
  readonly toolError: string;
  readonly rawResult: unknown;

  constructor(toolName: string, error: string, rawResult?: unknown) {
    super(error || "Tool execution failed");
    this.name = "ToolExecutionError";
    this.toolName = toolName;
    this.toolError = error;
    this.rawResult = rawResult;
  }
}
```

Update the error throwing (~line 626):
```typescript
if (result.isError) {
  logger.error(
    { agentId, userId, toolName: mcpTool.name, result },
    "MCP tool execution failed",
  );
  throw new ToolExecutionError(mcpTool.name, result.error, result);
}
```

### 2. `backend/src/routes/chat/errors.ts`

Update `mapProviderError` to handle `ToolExecutionError`:

```typescript
import { ToolExecutionError } from "@/clients/chat-mcp-client";

export function mapProviderError(
  error: unknown,
  provider: SupportedProvider,
): ChatErrorResponse {
  // Handle ToolExecutionError specifically
  if (error instanceof ToolExecutionError) {
    return createErrorResponse(
      ChatErrorCode.Unknown, // Or create a new ChatErrorCode.ToolExecutionFailed
      provider,
      undefined, // no HTTP status
      error.toolError || error.message,
      "ToolExecutionError",
      {
        toolName: error.toolName,
        errorMessage: error.toolError,
        rawResult: error.rawResult,
      },
    );
  }

  // ... rest of existing logic
}
```

## Testing

1. Trigger an MCP tool execution failure (e.g., invalid API key, rate limit, network error)
2. Verify the error response contains:
   - The actual error message from the tool
   - The tool name that failed
   - Any additional error details in `raw`

## Acceptance Criteria

- [ ] Tool execution errors preserve the original error message
- [ ] `originalError.message` contains the actual error, not generic "Tool execution failed"
- [ ] `originalError.raw` contains useful debugging information (tool name, error details)
- [ ] Existing provider error handling (OpenAI, Anthropic, Gemini API errors) still works correctly
- [ ] Add unit tests for `ToolExecutionError` handling in `errors.test.ts`

## Related Files

- `backend/src/clients/chat-mcp-client.ts` - Where tool execution happens
- `backend/src/routes/chat/errors.ts` - Error mapping logic
- `backend/src/routes/chat/routes.ts` - Chat route with `onError` handler
- `shared/chat-error.ts` - `ChatErrorCode` and `ChatErrorMessages` definitions
