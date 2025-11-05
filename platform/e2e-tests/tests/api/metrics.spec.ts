import { expect, test } from "@playwright/test";

const METRICS_BASE_URL = "http://localhost:9050";

test.describe("Metrics API", () => {
  test("should return health check from metrics server", async ({ request }) => {
    const response = await request.get(`${METRICS_BASE_URL}/health`);

    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data).toHaveProperty("status", "ok");
  });

  test("returns metrics when authentication is provided", async ({ request }) => {
    const response = await request.get(`${METRICS_BASE_URL}/metrics`, {
      headers: {
        Authorization: `Bearer foo-bar`,
      },
    });

    expect(response.ok()).toBeTruthy();

    const metricsText = await response.text();
    expect(metricsText).toContain("# HELP");
    expect(metricsText).toContain("http_request_duration_seconds");
  });

  test("rejects access with invalid bearer token", async ({ request }) => {
    const response = await request.get(`${METRICS_BASE_URL}/metrics`, {
      headers: {
        Authorization: "Bearer invalid-token",
      },
    });

    expect(response.status()).toBe(401);

    const errorData = await response.json();
    expect(errorData).toHaveProperty("error");
    expect(errorData.error).toContain("Invalid token");
  });
});
