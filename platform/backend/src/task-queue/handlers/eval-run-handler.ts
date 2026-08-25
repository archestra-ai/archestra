import { executeA2AMessage } from "@/agents/a2a-executor";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import config from "@/config";
import { evaluateAssertions } from "@/evals/assertions";
import { runLlmJudge } from "@/evals/judge";
import { extractTopLevelToolNames } from "@/evals/trajectory";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  EvalRunModel,
  EvalRunResultModel,
  MemberModel,
  UserModel,
} from "@/models";
import { metrics, tracing } from "@/observability";
import type { EvalRun, EvalRunResult } from "@/types/eval";

/** How often the in-flight case checks whether the run was canceled. */
const CANCEL_POLL_INTERVAL_MS = 5_000;

/**
 * Extra slack on top of the case timeout before a `running` row found during
 * resume is declared a crash artifact. A fresher row may belong to a live
 * overlapping attempt (deploy drain-timeout requeues the task while the old
 * worker keeps executing until force-exit) whose terminal write must win.
 */
const INTERRUPTED_SLACK_MS = 60_000;

/**
 * Execute one eval run: iterate its snapshotted case results in position
 * order, run each case against the agent headlessly, grade it, and finalize
 * the run. One task = one whole run.
 *
 * Concurrency-safe by construction: every case is claimed atomically
 * (`pending` → `running`), so a shutdown-timeout requeue that briefly leaves
 * two workers on the task cannot double-execute a case, and a crashed
 * attempt's `running` rows are closed out as `interrupted` errors rather than
 * replayed (agent MCP side effects must not happen twice).
 */
export async function handleEvalRunExecution(
  payload: Record<string, unknown>,
): Promise<void> {
  const runId = typeof payload.runId === "string" ? payload.runId : null;
  if (!runId) {
    throw new Error("Missing runId in eval run execution payload");
  }

  const run = await EvalRunModel.findByIdUnscoped(runId);
  if (!run) {
    logger.warn({ runId }, "[Evals] Run no longer exists, skipping");
    return;
  }
  if (run.status !== "pending" && run.status !== "running") {
    if (run.status === "canceled") {
      // A run canceled before pickup still owns pending result rows; close
      // them out so the results table matches the terminal run.
      await EvalRunResultModel.cancelPendingByRun(run.id);
      await syncCounts(run.id);
    }
    logger.info(
      { runId, status: run.status },
      "[Evals] Run already terminal, skipping",
    );
    return;
  }

  const prepared = await prepareRun(run);
  if (typeof prepared === "string") {
    await failRun(run.id, prepared);
    return;
  }

  const running = await EvalRunModel.markRunning(run.id);
  if (!running) {
    // Canceled between enqueue and pickup.
    await EvalRunResultModel.cancelPendingByRun(run.id);
    await syncCounts(run.id);
    return;
  }

  logger.info(
    { runId: run.id, suiteId: run.suiteId, agentId: run.agentId },
    "[Evals] Run started",
  );

  // Cancellation watchdog: a cancel flips the run row's status; this poll
  // aborts the in-flight case so cancel takes effect mid-case instead of
  // waiting out the case timeout.
  let canceled = false;
  let activeAbort: AbortController | null = null;
  const watchdog = setInterval(() => {
    EvalRunModel.getStatus(run.id)
      .then((status) => {
        if (status === "canceled") {
          canceled = true;
          activeAbort?.abort();
        }
      })
      .catch((error) => {
        logger.warn(
          {
            runId: run.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[Evals] Cancellation watchdog poll failed",
        );
      });
  }, CANCEL_POLL_INTERVAL_MS);

  let sawFreshRunningRow = false;
  try {
    const results = await EvalRunResultModel.listAllByRun(run.id);
    for (const result of results) {
      if (canceled) break;

      if (result.status === "running") {
        // A stale row is a crash artifact from a previous attempt: never
        // re-execute (the agent may have performed side effects) — close it.
        // A fresh one may still be executing on an overlapping live attempt;
        // leave it alone and defer finalization (see below).
        if (result.startedAt) {
          const ageMs = Date.now() - result.startedAt.getTime();
          const staleAfterMs =
            config.evals.caseTimeoutSeconds * 1000 + INTERRUPTED_SLACK_MS;
          if (ageMs > staleAfterMs) {
            await EvalRunResultModel.markInterrupted({
              id: result.id,
              observedStartedAt: result.startedAt,
            });
          } else {
            sawFreshRunningRow = true;
          }
        }
        continue;
      }
      if (result.status !== "pending") continue; // resume-safe

      const claimed = await EvalRunResultModel.claimPending(result.id);
      if (!claimed) continue; // another overlapping worker won the claim

      activeAbort = new AbortController();
      await executeCase({
        run,
        result: claimed,
        actorId: prepared.actorId,
        abortController: activeAbort,
        wasCanceled: () => canceled,
      });
      activeAbort = null;
    }
  } finally {
    clearInterval(watchdog);
  }

  const statusNow = await EvalRunModel.getStatus(run.id);
  if (statusNow === "canceled") {
    await EvalRunResultModel.cancelPendingByRun(run.id);
    await syncCounts(run.id);
    metrics.evals.reportEvalRunFinished("canceled");
    logger.info({ runId: run.id }, "[Evals] Run canceled");
    return;
  }

  if (sawFreshRunningRow) {
    // Another attempt may still be executing a case; its terminal write must
    // not be clobbered and the run's tallies aren't final. Fail this task
    // attempt so the queue retries finalization after a delay, by which time
    // the row is terminal or stale.
    throw new Error(
      "A case is still executing on an overlapping attempt; deferring run finalization",
    );
  }

  const counts = await EvalRunResultModel.countByStatus(run.id);
  const finalized = await EvalRunModel.finalize({
    id: run.id,
    status: "completed",
    counts: {
      passedCases: counts.passed,
      failedCases: counts.failed,
      erroredCases: counts.error,
      canceledCases: counts.canceled,
    },
  });
  if (finalized) {
    metrics.evals.reportEvalRunFinished("completed");
    logger.info({ runId: run.id, ...counts }, "[Evals] Run completed");
  } else {
    // A cancel raced in after the loop's status check.
    await EvalRunResultModel.cancelPendingByRun(run.id);
    await syncCounts(run.id);
    metrics.evals.reportEvalRunFinished("canceled");
    logger.info({ runId: run.id }, "[Evals] Run canceled during finalization");
  }
}

// === internal ===

/**
 * Re-validate the actor and agent at worker start. Enqueue-time checks can go
 * stale (user removed, agent deleted, access revoked); executing an agent
 * under a revoked identity is the thing this guards against. Mirrors the
 * schedule-trigger handler, plus an org-membership check because the run may
 * sit queued across a membership removal.
 */
async function prepareRun(run: EvalRun): Promise<{ actorId: string } | string> {
  if (!run.createdBy) {
    return "Run creator no longer exists";
  }
  const actor = await UserModel.getById(run.createdBy);
  if (!actor) {
    return "Run creator no longer exists";
  }
  const memberOrgIds = await MemberModel.findOrganizationIdsByUserId(actor.id);
  if (!memberOrgIds.includes(run.organizationId)) {
    return "Run creator is no longer a member of the organization";
  }
  const agent = await AgentModel.findById(run.agentId);
  if (!agent || agent.organizationId !== run.organizationId) {
    return "Target agent no longer exists";
  }
  if (agent.agentType !== "agent") {
    return "Eval target must be an internal agent";
  }
  const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId: actor.id,
    organizationId: run.organizationId,
  });
  const hasAccess = await AgentTeamModel.userHasAgentAccess(
    actor.id,
    run.agentId,
    isAgentAdmin,
  );
  if (!hasAccess) {
    return "Run creator no longer has access to the target agent";
  }
  return { actorId: actor.id };
}

async function executeCase(params: {
  run: EvalRun;
  result: EvalRunResult;
  actorId: string;
  abortController: AbortController;
  wasCanceled: () => boolean;
}): Promise<void> {
  const { run, result, actorId, abortController, wasCanceled } = params;
  const timeoutMs = config.evals.caseTimeoutSeconds * 1000;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const startedAtMs = Date.now();
  const sessionId = `eval-${result.id}`;
  const hasJudge = result.assertions.some((a) => a.type === "llm_judge");
  const judgeSessionId = hasJudge ? `eval-judge-${result.id}` : null;

  try {
    // Headless, conversation-less execution under the run creator's identity.
    // Approval-gated tools fail fast (blockOnApprovalRequired defaults true):
    // there is nobody to approve in an eval.
    const execution = await tracing.startActiveEvalCaseSpan({
      runId: run.id,
      suiteId: run.suiteId,
      caseName: result.caseName,
      agentId: run.agentId,
      agentName: run.agentNameSnapshot,
      sessionId,
      callback: () =>
        executeA2AMessage({
          agentId: run.agentId,
          message: result.input,
          organizationId: run.organizationId,
          userId: actorId,
          sessionId,
          source: "eval:run",
          abortSignal: abortController.signal,
        }),
    });

    const toolCalls = extractTopLevelToolNames(execution.responseUiMessage);
    const evaluation = await evaluateAssertions({
      assertions: result.assertions,
      outputText: execution.text,
      toolCalls,
      judge: async (assertion) => {
        try {
          const verdict = await runLlmJudge({
            criteria: assertion.criteria,
            expected: assertion.expected,
            input: result.input,
            outputText: execution.text,
            organizationId: run.organizationId,
            userId: actorId,
            agentId: run.agentId,
            sessionId: judgeSessionId ?? `eval-judge-${result.id}`,
            abortSignal: abortController.signal,
          });
          metrics.evals.reportEvalJudgeCall(
            verdict.passed ? "passed" : "failed",
          );
          return verdict;
        } catch (error) {
          metrics.evals.reportEvalJudgeCall("error");
          throw error;
        }
      },
    });

    metrics.evals.reportEvalCaseResult({
      outcome: evaluation.passed ? "passed" : "failed",
      durationMs: Date.now() - startedAtMs,
    });
    await EvalRunResultModel.complete({
      id: result.id,
      status: evaluation.passed ? "passed" : "failed",
      outputText: execution.text,
      finishReason: execution.finishReason,
      toolCalls,
      assertionResults: evaluation.results,
      sessionId,
      judgeSessionId,
      inputTokens: execution.usage?.promptTokens ?? null,
      outputTokens: execution.usage?.completionTokens ?? null,
      totalTokens: execution.usage?.totalTokens ?? null,
      durationMs: Date.now() - startedAtMs,
    });
  } catch (error) {
    const canceledMidCase = wasCanceled();
    const timedOut = abortController.signal.aborted && !canceledMidCase;
    const message = timedOut
      ? `Case timed out after ${config.evals.caseTimeoutSeconds}s`
      : error instanceof Error
        ? error.message
        : String(error);
    logger.warn(
      { runId: run.id, resultId: result.id, error: message, canceledMidCase },
      "[Evals] Case did not complete",
    );
    metrics.evals.reportEvalCaseResult({
      outcome: canceledMidCase ? "canceled" : "error",
      durationMs: Date.now() - startedAtMs,
    });
    await EvalRunResultModel.complete({
      id: result.id,
      status: canceledMidCase ? "canceled" : "error",
      error: canceledMidCase ? "Canceled while executing" : message,
      sessionId,
      // Judge calls may have run before the failure; keep their session so
      // cost aggregation and the drill-down link still cover them.
      judgeSessionId,
      durationMs: Date.now() - startedAtMs,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function failRun(runId: string, error: string): Promise<void> {
  logger.warn({ runId, error }, "[Evals] Run failed validation");
  metrics.evals.reportEvalRunFinished("failed");
  await EvalRunModel.markFailed(runId, error);
  await EvalRunResultModel.cancelPendingByRun(runId);
  await syncCounts(runId);
}

/** Copy the results table's tallies onto the (already terminal) run row. */
async function syncCounts(runId: string): Promise<void> {
  const counts = await EvalRunResultModel.countByStatus(runId);
  await EvalRunModel.updateCounts(runId, {
    passedCases: counts.passed,
    failedCases: counts.failed,
    erroredCases: counts.error,
    canceledCases: counts.canceled,
  });
}
