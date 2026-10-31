// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import client from "prom-client";
import { afterEach, expect, test, vi } from "vitest";
import { initializeOpenappaMetrics, observeOpenappaDispatch } from "./openappa";

afterEach(() => {
  client.register.clear();
  vi.restoreAllMocks();
});

test("counts one logical dispatch after retries settle, with bounded labels and full duration", async () => {
  initializeOpenappaMetrics();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const result = { decision: "deny_call", feedback: "private tool arguments" };
  const value = await observeOpenappaDispatch("tool_call", async () => {
    now += 25;
    await Promise.resolve();
    now += 75;
    return result;
  });
  expect(value).toBe(result);
  const count = await client.register
    .getSingleMetric("openappa_hook_dispatches_total")
    ?.get();
  expect(count?.values).toEqual([
    { value: 1, labels: { hook: "tool_call", decision: "deny_call" } },
  ]);
  expect(await client.register.metrics()).toContain(
    'openappa_hook_dispatch_duration_seconds_sum{hook="tool_call",decision="deny_call"} 0.1',
  );
  expect(await client.register.metrics()).not.toContain(
    "private tool arguments",
  );
});

test("preserves rejection and records error separately from policy denials", async () => {
  initializeOpenappaMetrics();
  const error = new Error("private backend address");
  await expect(
    observeOpenappaDispatch("tool_call", async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  const count = await client.register
    .getSingleMetric("openappa_hook_dispatches_total")
    ?.get();
  expect(count?.values).toEqual([
    { value: 1, labels: { hook: "tool_call", decision: "error" } },
  ]);
  expect(await client.register.metrics()).not.toContain(
    "private backend address",
  );
});

test("unknown hook and decision values cannot create unbounded metric dimensions", async () => {
  initializeOpenappaMetrics();
  for (let i = 0; i < 20; i++)
    await observeOpenappaDispatch(`private-${i}`, async () => ({
      decision: `private-${i}`,
    }));
  const count = await client.register
    .getSingleMetric("openappa_hook_dispatches_total")
    ?.get();
  expect(count?.values).toEqual([
    { value: 20, labels: { hook: "other", decision: "other" } },
  ]);
});

test("disabled or failing telemetry cannot alter enforcement", async () => {
  const result = { decision: "allow_call" };
  expect(await observeOpenappaDispatch("tool_call", async () => result)).toBe(
    result,
  );
  initializeOpenappaMetrics();
  const metric = client.register.getSingleMetric(
    "openappa_hook_dispatches_total",
  ) as client.Counter;
  vi.spyOn(metric, "inc").mockImplementation(() => {
    throw new Error("collection unavailable");
  });
  expect(await observeOpenappaDispatch("tool_call", async () => result)).toBe(
    result,
  );
});
