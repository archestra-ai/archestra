import { vi } from "vitest";
import { afterEach, describe, expect, test } from "@/test";

vi.mock("fastify-metrics", () => ({
  default: async function mockMetricsPlugin(
    fastify: {
      get: (url: string, handler: () => string) => void | Promise<void>;
    },
    options: { endpoint?: string | null },
  ) {
    if (options.endpoint) {
      fastify.get(
        options.endpoint,
        () => "# HELP mock_metric\nmock_metric 1\n",
      );
    }
  },
}));

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    ...actual,
    default: {
      ...actual.default,
      observability: {
        ...actual.default.observability,
        metrics: {
          ...actual.default.observability.metrics,
          secret: "foo-bar",
        },
      },
    },
  };
});

import {
  createFastifyInstance,
  registerMetricsPlugin,
  registerStandaloneMetricsEndpoint,
} from "@/server";
import { HEALTH_PATH, METRICS_PATH } from "./route-paths";

describe("metrics routes", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test("standalone metrics endpoint exposes health and requires bearer auth", async () => {
    const metricsApp = createFastifyInstance();
    metricsApp.get(HEALTH_PATH, () => ({ status: "ok" }));
    await registerStandaloneMetricsEndpoint({
      fastify: metricsApp,
      enableDefaultMetrics: false,
    });

    const healthResponse = await metricsApp.inject({
      method: "GET",
      url: HEALTH_PATH,
    });
    expect(healthResponse.statusCode).toBe(200);
    expect(healthResponse.json()).toEqual({ status: "ok" });

    const missingAuthResponse = await metricsApp.inject({
      method: "GET",
      url: METRICS_PATH,
    });
    expect(missingAuthResponse.statusCode).toBe(401);
    expect(missingAuthResponse.json()).toEqual({
      error: "Unauthorized: Bearer token required",
    });

    const invalidAuthResponse = await metricsApp.inject({
      method: "GET",
      url: METRICS_PATH,
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(invalidAuthResponse.statusCode).toBe(401);
    expect(invalidAuthResponse.json()).toEqual({
      error: "Unauthorized: Invalid token",
    });

    const validAuthResponse = await metricsApp.inject({
      method: "GET",
      url: METRICS_PATH,
      headers: { authorization: "Bearer foo-bar" },
    });
    expect(validAuthResponse.statusCode).toBe(200);
    expect(validAuthResponse.body).toContain("# HELP mock_metric");

    await metricsApp.close();
  });

  test("metrics auth does not block non-metrics endpoints", async () => {
    const metricsApp = createFastifyInstance();
    metricsApp.get(HEALTH_PATH, () => ({ status: "ok" }));
    metricsApp.get("/api/test", () => ({ data: "hello" }));
    await registerStandaloneMetricsEndpoint({
      fastify: metricsApp,
      enableDefaultMetrics: false,
    });

    // Non-metrics endpoint should pass through without auth
    const apiResponse = await metricsApp.inject({
      method: "GET",
      url: "/api/test",
    });
    expect(apiResponse.statusCode).toBe(200);
    expect(apiResponse.json()).toEqual({ data: "hello" });

    // /metrics with query params should still require auth
    const metricsWithQueryResponse = await metricsApp.inject({
      method: "GET",
      url: `${METRICS_PATH}?format=json`,
    });
    expect(metricsWithQueryResponse.statusCode).toBe(401);

    await metricsApp.close();
  });

  test("main app metrics plugin does not expose /metrics on the main port", async () => {
    const app = createFastifyInstance();
    app.get("/openapi.json", () => ({ ok: true }));
    await registerMetricsPlugin(app, false);

    await app.inject({
      method: "GET",
      url: "/openapi.json",
    });

    const response = await app.inject({
      method: "GET",
      url: METRICS_PATH,
      headers: { authorization: "Bearer foo-bar" },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
