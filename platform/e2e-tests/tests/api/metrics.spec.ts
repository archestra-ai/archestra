import {
  API_BASE_URL,
  METRICS_BASE_URL,
  METRICS_BEARER_TOKEN,
  METRICS_ENDPOINT,
} from "../../consts";
import { type APIRequestContext, expect, test } from "./fixtures";

const fetchMetrics = async (
  request: APIRequestContext,
  baseUrl: string,
  bearerToken: string,
) =>
  request.get(`${baseUrl}${METRICS_ENDPOINT}`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

test.describe("Metrics API", () => {
  test("should return health check from metrics server", async ({
    request,
  }) => {
    const response = await request.get(`${METRICS_BASE_URL}/health`);

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
  });

  test("returns metrics when authentication is provided", async ({
    request,
  }) => {
    // Make multiple API calls to ensure metrics are generated on all pods
    // (CI runs with 5 replicas, each with its own metrics registry)
    const apiCalls = Array.from({ length: 10 }, () =>
      request.get(`${API_BASE_URL}/openapi.json`),
    );
    await Promise.all(apiCalls);

    // Poll metrics until the route appears (handles race condition where metrics might not be immediately available)
    let metricsText = "";
    await expect
      .poll(
        async () => {
          const response = await fetchMetrics(
            request,
            METRICS_BASE_URL,
            METRICS_BEARER_TOKEN,
          );
          expect(response.ok()).toBeTruthy();
          metricsText = await response.text();
          return metricsText;
        },
        { timeout: 10000, intervals: [500, 1000, 2000] },
      )
      .toContain('route="/openapi.json"');

    // Verify standard metrics format
    expect(metricsText).toContain("# HELP");
    expect(metricsText).toContain("http_request_duration_seconds");

    /**
     * Ensure /metrics route is NOT present (since it's not exposed on main port)
     * Also, ensure that the /health route is NOT present (we're filtering this out explicitly in the metrics plugin)
     */
    expect(metricsText).not.toContain('route="/health"');
    expect(metricsText).not.toContain(`route="${METRICS_ENDPOINT}"`);
  });

  test("rejects access with invalid bearer token", async ({ request }) => {
    const response = await fetchMetrics(
      request,
      METRICS_BASE_URL,
      "invalid-token",
    );

    expect(response.status()).toBe(401);

    const errorData = await response.json();
    expect(errorData).toHaveProperty("error");
    expect(errorData.error).toContain("Invalid token");
  });

  test("should not expose /metrics endpoint on main API port", async ({
    request,
  }) => {
    const response = await fetchMetrics(
      request,
      API_BASE_URL,
      METRICS_BEARER_TOKEN,
    );
    expect(response.ok()).toBeFalsy();
  });
});
