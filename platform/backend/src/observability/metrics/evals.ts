/**
 * Prometheus metrics for eval runs.
 *
 * Pass rate over time:
 * sum(rate(eval_case_results_total{outcome="passed"}[1h]))
 *   / sum(rate(eval_case_results_total[1h]))
 *
 * Runs by terminal status:
 * sum by (status) (rate(eval_runs_total[1h]))
 */

import client from "prom-client";
import logger from "@/logging";
import type { EvalRunResultStatus, EvalRunStatus } from "@/types/eval";

let evalRunsTotal: client.Counter<string>;
let evalCaseResultsTotal: client.Counter<string>;
let evalCaseDurationSeconds: client.Histogram<string>;
let evalJudgeCallsTotal: client.Counter<string>;

let initialized = false;

export function initializeEvalMetrics(): void {
  if (initialized) return;
  initialized = true;

  evalRunsTotal = new client.Counter({
    name: "eval_runs_total",
    help: "Eval runs reaching a terminal status",
    labelNames: ["status"],
  });

  evalCaseResultsTotal = new client.Counter({
    name: "eval_case_results_total",
    help: "Eval case results by outcome",
    labelNames: ["outcome"],
  });

  evalCaseDurationSeconds = new client.Histogram({
    name: "eval_case_duration_seconds",
    help: "Wall-clock duration of one eval case (agent execution + grading)",
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
  });

  evalJudgeCallsTotal = new client.Counter({
    name: "eval_judge_calls_total",
    help: "LLM judge invocations by outcome",
    labelNames: ["outcome"],
  });

  logger.info("Eval metrics initialized");
}

export function reportEvalRunFinished(
  status: Extract<EvalRunStatus, "completed" | "failed" | "canceled">,
): void {
  if (!evalRunsTotal) return;
  evalRunsTotal.inc({ status });
}

export function reportEvalCaseResult(params: {
  outcome: Extract<
    EvalRunResultStatus,
    "passed" | "failed" | "error" | "canceled"
  >;
  durationMs?: number;
}): void {
  if (!evalCaseResultsTotal) return;
  evalCaseResultsTotal.inc({ outcome: params.outcome });
  if (params.durationMs !== undefined && evalCaseDurationSeconds) {
    evalCaseDurationSeconds.observe(params.durationMs / 1000);
  }
}

export function reportEvalJudgeCall(
  outcome: "passed" | "failed" | "error",
): void {
  if (!evalJudgeCallsTotal) return;
  evalJudgeCallsTotal.inc({ outcome });
}
