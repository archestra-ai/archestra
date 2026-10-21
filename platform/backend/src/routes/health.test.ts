import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { openappaReadiness } from "@/openappa/service";
import healthRoutes, { mapSandboxStatus } from "./health";

describe("mapSandboxStatus", () => {
  test("ready and initializing carry no reason", () => {
    expect(mapSandboxStatus("ready")).toEqual({ sandbox: "ready" });
    expect(mapSandboxStatus("initializing")).toEqual({
      sandbox: "initializing",
    });
  });

  test("disabled reports itself as the reason", () => {
    expect(mapSandboxStatus("disabled")).toEqual({
      sandbox: "disabled",
      sandboxReason: "disabled",
    });
  });

  test("error and stopped both collapse to unreachable with the original state", () => {
    expect(mapSandboxStatus("error")).toEqual({
      sandbox: "unreachable",
      sandboxReason: "error",
    });
    expect(mapSandboxStatus("stopped")).toEqual({
      sandbox: "unreachable",
      sandboxReason: "stopped",
    });
  });
});

describe("GET /ready", () => {
  const originalMaintenanceMode = config.maintenanceMode;
  afterEach(() => {
    config.maintenanceMode = originalMaintenanceMode;
  });

  // Drive the DB-free maintenance 200 branch so the assertion exercises the real
  // route's Zod serialization (the field would be silently stripped if it were
  // missing from the response schema) without needing a live raw pg pool.
  test("the 200 body carries the sandbox field (disabled when the runtime is off)", async () => {
    config.maintenanceMode = "scheduled maintenance";
    const app = createFastifyInstance();
    await app.register(healthRoutes);

    const response = await app.inject({ method: "GET", url: "/ready" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("maintenance");
    // The code runtime is not enabled in the test environment, so its boot
    // status stays "disabled" and surfaces as a terminal-fail-fast signal.
    expect(body.sandbox).toBe("disabled");
    expect(body.sandboxReason).toBe("disabled");
    expect(body.openappa).toBe("not_checked");

    await app.close();
  });
});

describe("openappaReadiness", () => {
  const original = {
    openappa: config.openappa.enabled,
    core: config.enterpriseFeatures.core,
  };
  afterEach(() => {
    config.openappa.enabled = original.openappa;
    config.enterpriseFeatures.core = original.core;
  });

  test("a deployment without Guardrails is not held back by it", async () => {
    config.openappa.enabled = false;
    expect(await openappaReadiness()).toEqual({ state: "disabled" });
  });

  test("a runtime that cannot open reports unavailable with its code", async () => {
    // The test process never resolves a database URL for the native runtime,
    // so opening it fails the way a refused URL does in a deployment.
    config.openappa.enabled = true;
    config.enterpriseFeatures.core = true;
    expect(await openappaReadiness()).toEqual({
      state: "unavailable",
      code: "unknown",
    });
  });
});
