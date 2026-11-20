import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
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

  test("answers 503 until the quickstart cluster's kubeconfig is written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kubeconfig-"));
    const kubernetes = config.orchestrator.kubernetes;
    const previous = kubernetes.kubeconfig;
    kubernetes.kubeconfig = join(dir, "kubeconfig");
    const app = createFastifyInstance();
    await app.register(healthRoutes);
    try {
      const starting = await app.inject({ method: "GET", url: "/ready" });
      expect(starting.statusCode).toBe(503);
      expect(starting.json()).toMatchObject({ kubernetes: "starting" });

      // Once it exists, readiness moves on to the database and the rest.
      writeFileSync(kubernetes.kubeconfig, "");
      const next = await app.inject({ method: "GET", url: "/ready" });
      expect(next.json().kubernetes).toBeUndefined();
    } finally {
      kubernetes.kubeconfig = previous;
      rmSync(dir, { recursive: true, force: true });
      await app.close();
    }
  });
});
