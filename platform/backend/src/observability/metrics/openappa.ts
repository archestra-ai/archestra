// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import client from "prom-client";

const hooks = new Set([
  "session_start",
  "prompt",
  "tool_call",
  "tool_result",
  "turn_end",
  "cancel_call",
  "child_address",
  "child_end",
  "child_return",
  "yell",
]);
const decisions = new Set([
  "ack",
  "allow_call",
  "pass_control",
  "deny_call",
  "block",
  "replace_output",
  "deliver_value",
  "child_return",
  "context",
  "refuse",
  "mcp_result",
]);

export function initializeOpenappaMetrics(): void {
  if (client.register.getSingleMetric("openappa_hook_dispatches_total")) return;
  new client.Counter({
    name: "openappa_hook_dispatches_total",
    help: "Completed embedded OpenAPPA hook dispatches, including failures; one observation after policy-move retries",
    labelNames: ["hook", "decision"],
  });
  new client.Histogram({
    name: "openappa_hook_dispatch_duration_seconds",
    help: "Embedded OpenAPPA hook dispatch wall time, including policy resolution inside dispatch, storage, consults and retries",
    labelNames: ["hook", "decision"],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300],
  });
}

/** The host's logical hook boundary, not the engine's tool-proposal decision counter. */
export async function observeOpenappaDispatch<T extends { decision: string }>(
  hook: unknown,
  dispatch: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let decision = "error";
  try {
    const result = await dispatch();
    decision = decisions.has(result.decision) ? result.decision : "other";
    return result;
  } finally {
    // Metric collection must preserve the original result or error, even if disabled.
    try {
      const labels = {
        hook: typeof hook === "string" && hooks.has(hook) ? hook : "other",
        decision,
      };
      (
        client.register.getSingleMetric("openappa_hook_dispatches_total") as
          | client.Counter
          | undefined
      )?.inc(labels);
      (
        client.register.getSingleMetric(
          "openappa_hook_dispatch_duration_seconds",
        ) as client.Histogram | undefined
      )?.observe(labels, (performance.now() - started) / 1000);
    } catch {
      // Instrumentation never changes policy enforcement.
    }
  }
}
