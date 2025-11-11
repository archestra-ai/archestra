# AI Provider Error Handling Improvements

## Overview
This PR implements Vercel AI SDK best practices for handling errors from AI providers (Anthropic, OpenAI) including rate limits, billing issues, and 500 errors from the Fastify server.

## Changes Made

### 1. Created Structured Error Handling Utility
**File**: `platform/backend/src/routes/proxy/utils/error-handling.ts`

- Comprehensive error parser for Anthropic and OpenAI SDK errors
- Maps provider error types to proper HTTP status codes:
  - `400` - Invalid request errors
  - `401` - Authentication errors
  - `402` - Billing/quota errors (following Vercel AI best practices)
  - `403` - Permission denied
  - `404` - Not found
  - `429` - Rate limit errors (with `Retry-After` header support)
  - `500` - Internal server errors
  - `503` - Service unavailable/overloaded
  - `504` - Timeout errors
- Extracts and forwards rate limit headers from providers to clients
- Handles both streaming (SSE) and non-streaming error responses
- Type-safe error parsing with proper type guards

### 2. Updated Anthropic Provider (`platform/backend/src/routes/proxy/anthropic.ts`)

**Fixed Issues**:
- ❌ Removed hardcoded fake rate limit headers (lines 226-239)
- ✅ Added timeout configuration (60s) to prevent hanging requests
- ✅ Added retry configuration (2 retries) for transient failures
- ✅ Replaced generic error handling with structured error parser
- ✅ Real rate limit headers now forwarded from Anthropic API

**Before**:
```typescript
reply.header("anthropic-ratelimit-requests-remaining", "999"); // Fake!
```

**After**:
```typescript
const anthropicClient = new AnthropicProvider({
  apiKey: anthropicApiKey,
  baseURL: config.llm.anthropic.baseUrl,
  fetch: getObservableFetch("anthropic", resolvedAgent),
  maxRetries: 2,
  timeout: 60000,
});
```

**Error Handling Before**:
```typescript
return reply.status(500).send({
  error: {
    message: error.message,
    type: "api_error", // Always generic!
  },
});
```

**Error Handling After**:
```typescript
return utils.errorHandling.sendErrorResponse(
  reply,
  error,
  "anthropic",
  fastify.log,
);
// Returns proper status codes: 429 for rate limits, 402 for billing, etc.
```

### 3. Updated OpenAI Provider (`platform/backend/src/routes/proxy/openai.ts`)

**Improvements**:
- ✅ Added timeout configuration (60s)
- ✅ Added retry configuration (2 retries)
- ✅ Replaced generic error handling with structured error parser
- ✅ Forwards OpenAI rate limit headers (`x-ratelimit-*`)
- ✅ Proper status codes for different error types

### 4. Enhanced Vercel AI SDK Error Handling (`platform/backend/src/routes/chat.ts`)

**Before**:
```typescript
onError: (error) => {
  return JSON.stringify(error); // Just stringifies!
}
```

**After**:
```typescript
onError: (error) => {
  fastify.log.error({ error, conversationId }, "Chat stream error");

  // Extract structured error information
  if (errorObj.status === 429) {
    return JSON.stringify({
      error: {
        message: errorObj.message,
        type: "rate_limit_error",
        status: 429,
      },
    });
  }
  // ... handles 402, 401, and other status codes
}
```

## Benefits

### For Users
- **Clear error messages**: Users now see specific error types (rate limits, billing, auth) instead of generic "api_error"
- **Retry guidance**: Rate limit errors include `Retry-After` headers
- **Better visibility**: Rate limit headers show actual quota remaining (not fake "999")

### For Developers
- **Proper HTTP semantics**: Status codes match error types (429 for rate limits, not 500)
- **Debugging**: Structured errors with type, code, and param fields
- **Monitoring**: Easier to track specific error types in logs/metrics

## Error Response Examples

### Rate Limit Error (429)
```json
{
  "error": {
    "message": "Rate limit exceeded. Please try again in 60 seconds.",
    "type": "rate_limit_error",
    "code": "rate_limit_exceeded"
  }
}
```
Headers: `Retry-After: 60`, `anthropic-ratelimit-requests-remaining: 0`

### Billing Error (402)
```json
{
  "error": {
    "message": "Insufficient quota. Please add credits to your account.",
    "type": "insufficient_quota"
  }
}
```

### Authentication Error (401)
```json
{
  "error": {
    "message": "Invalid API key provided",
    "type": "authentication_error"
  }
}
```

### Timeout Error (504)
```json
{
  "error": {
    "message": "Request to Anthropic timed out",
    "type": "timeout_error"
  }
}
```

## Testing Recommendations

### Rate Limit Testing
```bash
# Make many rapid requests to trigger rate limits
for i in {1..100}; do
  curl -X POST http://localhost:9000/v1/anthropic/messages \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"claude-3-5-sonnet-20241022","messages":[...],"max_tokens":100}'
done

# Should return 429 with Retry-After header
```

### Billing Error Testing
```bash
# Use an API key with no credits
curl -X POST http://localhost:9000/v1/anthropic/messages \
  -H "x-api-key: expired_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-3-5-sonnet-20241022","messages":[...],"max_tokens":100}'

# Should return 402 with insufficient_quota error
```

### Timeout Testing
```bash
# The 60s timeout will catch hanging requests
# Monitor logs for timeout_error messages
```

## References

- [Vercel AI SDK Error Handling](https://sdk.vercel.ai/docs/ai-sdk-core/error-handling)
- [Anthropic API Error Codes](https://docs.anthropic.com/en/api/errors)
- [OpenAI API Error Codes](https://platform.openai.com/docs/guides/error-codes)
- [HTTP Status Code Best Practices](https://www.rfc-editor.org/rfc/rfc9110.html#name-status-codes)

## Migration Notes

### For Frontend Clients
Clients should now check for specific error types and handle them appropriately:

```typescript
try {
  const response = await fetch('/api/chat', { method: 'POST', ... });
  const data = await response.json();
} catch (error) {
  if (error.error?.type === 'rate_limit_error') {
    // Show "Too many requests" message with retry time
  } else if (error.error?.type === 'insufficient_quota') {
    // Show "Add credits" message
  } else if (error.error?.type === 'authentication_error') {
    // Show "Invalid API key" message
  }
}
```

### Breaking Changes
None - this is backward compatible. Errors still have the same JSON structure, just with more accurate `type` and `status` fields.
