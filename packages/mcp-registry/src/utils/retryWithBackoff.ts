interface RetryConfig {
  maxAttempts: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
};

export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  config: Partial<RetryConfig> = {}
): Promise<T> => {
  const finalConfig = { ...DEFAULT_RETRY_CONFIG, ...config };
  let lastError: Error | null = null;
  let delay = finalConfig.initialDelay;

  for (let attempt = 1; attempt <= finalConfig.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt === finalConfig.maxAttempts) {
        break;
      }

      // Exponential backoff with jitter
      const jitter = Math.random() * 0.1 * delay;
      const waitTime = Math.min(delay + jitter, finalConfig.maxDelay);
      
      await new Promise((resolve) => setTimeout(resolve, waitTime));
      delay *= finalConfig.backoffMultiplier;
    }
  }

  throw lastError;
};
```

```typescript