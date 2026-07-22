import client from "prom-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";

describe("sandbox metrics", () => {
  beforeEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  afterEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  test("does not report commands before metrics are initialized", async () => {
    const { reportCommand } = await import("./sandbox");

    expect(() =>
      reportCommand({ status: "ok", durationSeconds: 1 }),
    ).not.toThrow();
    expect(await client.register.metrics()).not.toContain(
      "sandbox_commands_total",
    );
  });

  test("classifyCommandStatus maps execution outcomes", async () => {
    const { classifyCommandStatus } = await import("./sandbox");

    expect(classifyCommandStatus({ timedOut: false, exitCode: 0 })).toBe("ok");
    expect(classifyCommandStatus({ timedOut: false, exitCode: 1 })).toBe(
      "script_error",
    );
    expect(classifyCommandStatus({ timedOut: true, exitCode: 0 })).toBe(
      "timeout",
    );
    // timeout takes precedence over a non-zero exit code
    expect(classifyCommandStatus({ timedOut: true, exitCode: 137 })).toBe(
      "timeout",
    );
  });

  test("records command metrics after initialization", async () => {
    const { initializeSandboxMetrics, reportCommand } = await import(
      "./sandbox"
    );

    initializeSandboxMetrics();
    reportCommand({ status: "timeout", durationSeconds: 1.5 });

    const metrics = await client.register.metrics();
    expect(metrics).toContain('sandbox_commands_total{status="timeout"} 1');
    expect(metrics).toContain(
      'sandbox_command_duration_seconds_count{status="timeout"} 1',
    );
  });

  test("init registers the runtime error and status series", async () => {
    const { initializeSandboxMetrics } = await import("./sandbox");

    initializeSandboxMetrics();

    const registered = (await client.register.getMetricsAsJSON()).map(
      (m) => m.name,
    );
    expect(registered).toContain("sandbox_runtime_errors_total");
    expect(registered).toContain("sandbox_runtime_status");
  });

  test("does not report runtime error/status before initialization", async () => {
    const { reportRuntimeError, reportRuntimeStatus } = await import(
      "./sandbox"
    );

    expect(() =>
      reportRuntimeError({ code: "engine_unreachable" }),
    ).not.toThrow();
    expect(() => reportRuntimeStatus({ status: "error" })).not.toThrow();
    const metrics = await client.register.metrics();
    expect(metrics).not.toContain("sandbox_runtime_errors_total");
    expect(metrics).not.toContain("sandbox_runtime_status");
  });

  test("reportRuntimeError increments the labeled counter", async () => {
    const { initializeSandboxMetrics, reportRuntimeError } = await import(
      "./sandbox"
    );

    initializeSandboxMetrics();
    reportRuntimeError({ code: "engine_unreachable" });
    reportRuntimeError({ code: "engine_unreachable" });
    reportRuntimeError({ code: "internal" });

    const metrics = await client.register.metrics();
    expect(metrics).toContain(
      'sandbox_runtime_errors_total{code="engine_unreachable"} 2',
    );
    expect(metrics).toContain(
      'sandbox_runtime_errors_total{code="internal"} 1',
    );
  });

  test("reportRuntimeStatus sets current status to 1 and others to 0", async () => {
    const { initializeSandboxMetrics, reportRuntimeStatus } = await import(
      "./sandbox"
    );

    initializeSandboxMetrics();
    reportRuntimeStatus({ status: "error" });

    const metrics = await client.register.metrics();
    expect(metrics).toContain('sandbox_runtime_status{status="error"} 1');
    expect(metrics).toContain('sandbox_runtime_status{status="ready"} 0');
    expect(metrics).toContain('sandbox_runtime_status{status="disabled"} 0');
    expect(metrics).toContain(
      'sandbox_runtime_status{status="initializing"} 0',
    );
    expect(metrics).toContain('sandbox_runtime_status{status="stopped"} 0');
  });
});
