import config from "@/config";
import { createFastifyInstance } from "@/server";
import { afterEach, describe, expect, test } from "@/test";
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

    await app.close();
  });
});
