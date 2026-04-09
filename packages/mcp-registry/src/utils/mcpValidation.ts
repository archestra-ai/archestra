const VALID_MCP_ID_PATTERN = /^[a-z0-9-]+$/;
const MAX_MCP_ID_LENGTH = 128;

export const validateMCPId = (mcpId: string): string => {
  if (!mcpId) {
    throw new Error('MCP ID is required');
  }

  if (typeof mcpId !== 'string') {
    throw new Error('MCP ID must be a string');
  }

  if (mcpId.length > MAX_MCP_ID_LENGTH) {
    throw new Error(
      `MCP ID exceeds maximum length of ${MAX_MCP_ID_LENGTH} characters`
    );
  }

  if (!VALID_MCP_ID_PATTERN.test(mcpId)) {
    throw new Error('MCP ID contains invalid characters');
  }

  return mcpId.trim();
};

export const validateMCPData = (data: unknown): Record<string, unknown> => {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid MCP data format');
  }

  const mcpData = data as Record<string, unknown>;

  if (!mcpData.id || typeof mcpData.id !== 'string') {
    throw new Error('MCP data must include a valid id field');
  }

  return mcpData;
};
```

```typescript