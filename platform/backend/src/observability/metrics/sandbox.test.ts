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
});
