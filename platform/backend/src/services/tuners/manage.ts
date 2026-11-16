import { ScheduleTriggerModel, ScheduleTriggerRunModel } from "@/models";
import { startManualScheduleTriggerRun } from "@/services/schedule-trigger-access";
import { ApiError } from "@/types";
import {
  type ScheduleTrigger,
  ScheduleTriggerConfigurationSchema,
  type ScheduleTriggerRun,
} from "@/types/schedule-trigger";
import { type TunerKind, TunerKindSchema } from "@/types/tuner";
import type {
  ConfigureTunerRequest,
  TunerSummary,
} from "@/types/tuner-suggestion";
import { TUNERS } from "./registry";

const DEFAULT_SCHEDULE = { cronExpression: "0 6 * * *", timezone: "UTC" };

/** The run's opening instructions; candidates are appended per run. */
const TUNER_INSTRUCTIONS =
  "Review the candidates below. For each one an admin should act on, investigate with your tools and file one suggestion with propose_tuner_suggestion. Skip candidates that need nothing, and do not re-file what the history shows an admin already decided unless something changed.";

export async function listTuners(
  organizationId: string,
): Promise<TunerSummary[]> {
  const triggers = await ScheduleTriggerModel.findTunerTriggers(organizationId);
  const latestRuns = await ScheduleTriggerRunModel.findLatestByTriggerIds(
    triggers.map((t) => t.id),
  );
  return Promise.all(
    TunerKindSchema.options.map(async (kind) => {
      const trigger = triggers.find((t) => t.tunerKind === kind) ?? null;
      const run = trigger
        ? (latestRuns.find((r) => r.triggerId === trigger.id) ?? null)
        : null;
      return {
        kind,
        available: (await TUNERS[kind].findAgent(organizationId)) !== null,
        trigger: trigger && {
          id: trigger.id,
          enabled: trigger.enabled,
          cronExpression: trigger.cronExpression,
          timezone: trigger.timezone,
          actor: trigger.actor ?? null,
          lastExecutedAt: trigger.lastExecutedAt,
        },
        lastRun: run && summarizeRun(run),
      };
    }),
  );
}

/**
 * Enables, disables or reschedules a tuner. Whoever enables it becomes the
 * actor it runs as; each run rechecks that actor's permissions.
 */
export async function configureTuner(params: {
  organizationId: string;
  userId: string;
  kind: TunerKind;
  request: ConfigureTunerRequest;
}): Promise<ScheduleTrigger> {
  const { organizationId, userId, kind, request } = params;
  const existing = await findTunerTrigger(organizationId, kind);
  const schedule = ScheduleTriggerConfigurationSchema.safeParse({
    cronExpression:
      request.cronExpression ??
      existing?.cronExpression ??
      DEFAULT_SCHEDULE.cronExpression,
    timezone:
      request.timezone ?? existing?.timezone ?? DEFAULT_SCHEDULE.timezone,
    messageTemplate: TUNER_INSTRUCTIONS,
  });
  if (!schedule.success) {
    throw new ApiError(
      400,
      schedule.error.issues[0]?.message ?? "Invalid schedule",
    );
  }
  const agent = await TUNERS[kind].findAgent(organizationId);
  if (!agent && request.enabled) {
    throw new ApiError(409, "This tuner is not available in this deployment");
  }

  if (!existing) {
    if (!agent) throw new ApiError(404, "Tuner not configured");
    return ScheduleTriggerModel.create({
      organizationId,
      name: `Tuner: ${kind}`,
      agentId: agent.id,
      tunerKind: kind,
      actorUserId: userId,
      enabled: request.enabled,
      ...schedule.data,
    });
  }
  const updated = await ScheduleTriggerModel.update(existing.id, {
    ...schedule.data,
    enabled: request.enabled,
    ...(agent && { agentId: agent.id }),
    ...(request.enabled && { actorUserId: userId }),
  });
  if (!updated) throw new ApiError(404, "Tuner not configured");
  return updated;
}

export async function runTunerNow(params: {
  organizationId: string;
  userId: string;
  kind: TunerKind;
}): Promise<ScheduleTriggerRun> {
  const trigger = await findTunerTrigger(params.organizationId, params.kind);
  if (!trigger) throw new ApiError(404, "Tuner not configured");
  if (!(await TUNERS[params.kind].findAgent(params.organizationId))) {
    throw new ApiError(409, "This tuner is not available in this deployment");
  }
  return startManualScheduleTriggerRun({
    trigger,
    initiatedByUserId: params.userId,
  });
}

/** Audit snapshot of a tuner, addressed by kind. */
export async function findTunerForAudit(
  kind: string,
  organizationId: string,
): Promise<Record<string, unknown> | null> {
  const parsed = TunerKindSchema.safeParse(kind);
  if (!parsed.success) return null;
  const trigger = await findTunerTrigger(organizationId, parsed.data);
  return trigger && { ...trigger, actor: undefined };
}

async function findTunerTrigger(
  organizationId: string,
  kind: TunerKind,
): Promise<ScheduleTrigger | null> {
  const triggers = await ScheduleTriggerModel.findTunerTriggers(organizationId);
  return triggers.find((t) => t.tunerKind === kind) ?? null;
}

function summarizeRun(
  run: ScheduleTriggerRun,
): NonNullable<TunerSummary["lastRun"]> {
  return {
    id: run.id,
    status: run.status,
    scan: run.tuner && {
      outcome: run.tuner.outcome,
      candidateCount: run.tuner.candidates.length,
    },
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    error: run.error,
  };
}
