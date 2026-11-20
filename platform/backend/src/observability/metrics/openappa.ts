// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import client from "prom-client";
import type { OpenAppaYellKind } from "@/types/openappa-yell";

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
  "defer_return",
  "context",
  "refuse",
  "mcp_result",
]);
const yellKinds = new Set<string>([
  "agent",
  "approval_waived",
  "block_waived",
] satisfies OpenAppaYellKind[]);

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
  new client.Counter({
    name: "openappa_yells_total",
    help: "Committed OpenAPPA yells, as Guardrails -> Yells lists them: one per agent or client-failure report, one per call a Break the glass waiver let through",
    labelNames: ["kind", "superyell"],
  });
}

/**
 * Counts a committed yell. Call it only after the row's transaction commits,
 * so a rolled-back waiver is never counted.
 */
export function observeOpenappaYell(params: {
  kind: OpenAppaYellKind;
  superyell: boolean;
  /** Calls a waiver stands for; an agent report counts once. */
  calls?: number;
}): void {
  try {
    (
      client.register.getSingleMetric("openappa_yells_total") as
        | client.Counter
        | undefined
    )?.inc(
      {
        kind: yellKinds.has(params.kind) ? params.kind : "other",
        superyell: String(params.superyell),
      },
      params.calls ?? 1,
    );
  } catch {
    // Instrumentation never changes how a yell is recorded.
  }
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

let engineCollector: (() => string) | undefined;

/** Attach only after the native runtime initializes; scraping never starts it. */
export function setOpenappaEngineMetricsCollector(
  collector: (() => string) | undefined,
): void {
  engineCollector = collector;
}

export function collectOpenappaEngineMetrics(): string {
  try {
    return engineCollector?.() ?? "";
  } catch {
    // A failed native collection must not hide the rest of the process metrics.
    return "";
  }
}
