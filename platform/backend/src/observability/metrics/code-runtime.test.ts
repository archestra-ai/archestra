import client from "prom-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";

describe("code runtime metrics", () => {
  beforeEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  afterEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  test("does not report runs before metrics are initialized", async () => {
    const { reportRun } = await import("./code-runtime");

    expect(() => reportRun("ok", 1)).not.toThrow();
    expect(await client.register.metrics()).not.toContain(
      "code_runtime_runs_total",
    );
  });

  test("records run metrics after initialization", async () => {
    const { initializeCodeRuntimeMetrics, reportRun } = await import(
      "./code-runtime"
    );

    initializeCodeRuntimeMetrics();
    reportRun("ok", 1.5);

    const metrics = await client.register.metrics();
    expect(metrics).toContain('code_runtime_runs_total{status="ok"} 1');
    expect(metrics).toContain(
      'code_runtime_run_duration_seconds_count{status="ok"} 1',
    );
  });
});
