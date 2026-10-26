import type { UsageViewProps } from "./usage-data";

const fixture: UsageViewProps = {
  timeframe: "7d",
  statistics: {
    requests: 3,
    inputTokens: 80,
    outputTokens: 20,
    cacheReadTokens: 1000,
    cacheWriteTokens: 10,
    totalTokens: 110,
    billedCost: 2,
    subscriptionCost: 8,
    activeDays: 1,
    lastActiveAt: null,
    models: [
      {
        model: "example-model",
        requests: 3,
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 1000,
        cacheWriteTokens: 10,
        totalTokens: 110,
        percentage: 100,
        billedCost: 2,
        subscriptionCost: 8,
      },
    ],
    timeSeries: [
      {
        timestamp: "2026-01-01T00:00:00Z",
        value: 2,
        billedCost: 2,
        subscriptionCost: 8,
        requests: 3,
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 1000,
        cacheWriteTokens: 10,
        totalTokens: 110,
      },
    ],
  },
  breakdown: {
    tokenMix: {
      freshInputTokens: 80,
      cacheWriteTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 1000,
      cacheCost: 1,
      cacheSavings: 9,
    },
    clients: [
      {
        client: null,
        requests: 3,
        inputTokens: 80,
        outputTokens: 20,
        cacheReadTokens: 1000,
        cacheWriteTokens: 10,
        totalTokens: 110,
        percentage: 100,
        billedCost: 2,
        subscriptionCost: 8,
      },
    ],
    contextBuckets: [
      { bucket: "under32k", requests: 3, tokens: 100, cost: 10 },
    ],
    topSessions: [
      {
        sessionId: "example-session",
        requests: 2,
        tokens: 50,
        cost: 5,
        billedCost: 1,
        startedAt: "2026-01-01T00:00:00Z",
        lastActiveAt: "2026-01-01T00:10:00Z",
        durationMinutes: 10,
        model: "example-model",
        client: null,
      },
    ],
    totalCost: 10,
    unsessionedRequests: 1,
  },
};
export function makeUsageData(): UsageViewProps {
  return structuredClone(fixture);
}
