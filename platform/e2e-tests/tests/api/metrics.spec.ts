import { APIRequestContext, expect, test } from "@playwright/test";
import { API_BASE_URL, METRICS_BASE_URL, METRICS_BEARER_TOKEN } from "../../consts";


const fetchMetrics = async (request: APIRequestContext, baseUrl: string, bearerToken: string) =>
  request.get(`${baseUrl}/metrics`, {
    headers: {
      Authorization: `Bearer ${bearerToken}`,
    },
  });

test.describe("Metrics API", () => {
  test("should return health check from metrics server", async ({ request }) => {
    const response = await request.get(`${METRICS_BASE_URL}/health`);

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
  });

  test("returns metrics when authentication is provided", async ({ request }) => {
    // First, make an API call to generate metrics data
    await request.get(`${API_BASE_URL}/openapi.json`);

    const response = await fetchMetrics(request, METRICS_BASE_URL, METRICS_BEARER_TOKEN);

    expect(response.ok()).toBeTruthy();

    const metricsText = await response.text();
    expect(metricsText).toContain("# HELP");
    expect(metricsText).toContain("http_request_duration_seconds");

    // Check that we have route labels from our API call above
    expect(metricsText).toContain('route="/openapi.json"');

    /**
     * Ensure /metrics route is NOT present (since it's not exposed on main port)
     * Also, ensure that the /health route is NOT present (we're filtering this out explicitly in the metrics plugin)
     */
    expect(metricsText).not.toContain('route="/health"');
    expect(metricsText).not.toContain('route="/metrics"');
  });

  test("rejects access with invalid bearer token", async ({ request }) => {
    const response = await fetchMetrics(request, METRICS_BASE_URL, "invalid-token");

    expect(response.status()).toBe(401);

    const errorData = await response.json();
    expect(errorData).toHaveProperty("error");
    expect(errorData.error).toContain("Invalid token");
  });

  test("should not expose /metrics endpoint on main API port", async ({ request }) => {
    const response = await fetchMetrics(request, API_BASE_URL, METRICS_BEARER_TOKEN);
    expect(response.ok()).toBeFalsy();
  });
});
