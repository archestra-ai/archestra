export interface MCPData {
  id: string;
  name: string;
  version: string;
  config?: Record<string, unknown>;
}

export interface MCPStatus {
  podFound: boolean;
  status: 'running' | 'pending' | 'failed';
  message?: string;
}

export interface MCPError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface MCPRegistryState {
  mcpRegistry: MCPData[];
  installedMCPs: MCPData[];
  error: MCPError | null;
  loading: boolean;
}
```

```typescript