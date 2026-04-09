import config from '../../../config';

interface Config {
  apiUrl?: string;
  timeout?: number;
  retryAttempts?: number;
}

const validateConfig = (): Config => {
  if (!config?.apiUrl) {
    throw new Error(
      'Configuration error while installing Google Workspace MCP: API URL not configured'
    );
  }

  if (typeof config.apiUrl !== 'string' || !config.apiUrl.startsWith('http')) {
    throw new Error(
      'Configuration error while installing Google Workspace MCP: Invalid API URL format'
    );
  }

  return {
    apiUrl: config.apiUrl,
    timeout: config.timeout || 30000,
    retryAttempts: config.retryAttempts || 3,
  };
};

export default validateConfig;
```

```typescript