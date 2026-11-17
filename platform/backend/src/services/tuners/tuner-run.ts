import config from "@/config";
import { ScheduleTriggerModel, ScheduleTriggerRunModel } from "@/models";
import type { ScheduleTriggerRunStatus } from "@/types/schedule-trigger";
import type { TunerKind, TunerRunRecord } from "@/types/tuner";

/** A schedule run whose trigger runs a tuner, read fresh from the database. */
export interface TunerRunScope {
  runId: string;
  organizationId: string;
  tunerKind: TunerKind;
  agentId: string;
  status: ScheduleTriggerRunStatus;
  record: TunerRunRecord | null;
}

/**
 * The tuner run a tool call belongs to, or null for every other call. Keyed on
 * the schedule run id the executor threads into tool contexts; a delegated
 * child inherits that id, so callers that act for the tuner also compare the
 * agent.
 */
export async function findTunerRun(
  scheduleTriggerRunId: string | undefined,
): Promise<TunerRunScope | null> {
  if (!config.tuners.enabled || !scheduleTriggerRunId) return null;
  const run = await ScheduleTriggerRunModel.findById(scheduleTriggerRunId);
  if (!run) return null;
  const trigger = await ScheduleTriggerModel.findById(run.triggerId);
  if (!trigger?.tunerKind || trigger.organizationId !== run.organizationId) {
    return null;
  }
  return {
    runId: run.id,
    organizationId: run.organizationId,
    tunerKind: trigger.tunerKind,
    agentId: trigger.agentId,
    status: run.status,
    record: run.tuner,
  };
}
