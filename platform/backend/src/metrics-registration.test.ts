// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import Fastify from "fastify";
import client from "prom-client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/config")>();
  return {
    default: {
      ...actual.default,
      observability: {
        ...actual.default.observability,
        metrics: {
          ...actual.default.observability.metrics,
          endpoint: "/metrics",
          secret: "test-secret",
        },
      },
    },
  };
});

import { registerStandaloneMetricsEndpoint } from "@/metrics-registration";
import { setOpenappaEngineMetricsCollector } from "@/observability/metrics/openappa";

beforeEach(() => client.register.clear());
afterEach(() => {
  client.register.clear();
  setOpenappaEngineMetricsCollector(undefined);
  client.register.setContentType(client.Registry.PROMETHEUS_CONTENT_TYPE);
});

for (const format of [
  client.Registry.PROMETHEUS_CONTENT_TYPE,
  client.Registry.OPENMETRICS_CONTENT_TYPE,
]) {
  test(`native counters share the real metrics endpoint in ${format}`, async () => {
    (client.register.setContentType as (type: string) => void)(format);
    new client.Counter({
      name: "ordinary_total",
      help: "Ordinary process counter",
    }).inc(2);
    setOpenappaEngineMetricsCollector(
      () =>
        '# HELP appa_policy_decisions_total Embedded policy decisions\n# TYPE appa_policy_decisions_total counter\nappa_policy_decisions_total{outcome="allowed"} 3\n',
    );
    const app = Fastify() as FastifyInstanceWithZod;
    try {
      await registerStandaloneMetricsEndpoint({
        fastify: app,
        enableDefaultMetrics: false,
      });
      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer test-secret" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(format);
      expect(response.body).toContain("ordinary_total 2\n");
      expect(response.body).toContain(
        'appa_policy_decisions_total{outcome="allowed"} 3\n',
      );
      if (format === client.Registry.OPENMETRICS_CONTENT_TYPE) {
        expect(response.body).toContain(
          "# TYPE appa_policy_decisions counter\n",
        );
        expect(response.body).toContain(
          "# HELP appa_policy_decisions Embedded policy decisions\n",
        );
        expect(response.body).not.toContain(
          "# TYPE appa_policy_decisions_total",
        );
        expect(response.body.match(/^# EOF$/gm)).toHaveLength(1);
        expect(response.body.trimEnd()).toMatch(/# EOF$/);
      } else {
        expect(response.body).toContain(
          "# TYPE appa_policy_decisions_total counter\n",
        );
        expect(response.body).not.toContain("# EOF");
      }
    } finally {
      await app.close();
    }
  });
}
