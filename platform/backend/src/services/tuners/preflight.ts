import logger from "@/logging";
import { ScheduleTriggerRunModel, TunerSuggestionModel } from "@/models";
import type { ScheduleTrigger } from "@/types/schedule-trigger";
import {
  severityRank,
  type TunerCandidate,
  type TunerKind,
  type TunerRunOutcome,
  type TunerRunRecord,
} from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import {
  EMPTY_FINGERPRINT_HISTORY,
  suppressionVerdict,
} from "@/utils/tuner-suppression";
import { hasTunerAccess } from "./access";
import { TUNERS } from "./registry";

export type TunerPreflight =
  /** Another attempt of this run recorded its scan first and owns the run. */
  | { type: "taken" }
  /** Nothing for the agent to look at; the run succeeds without it. */
  | { type: "settled"; outcome: Exclude<TunerRunOutcome, "agent_ran"> }
  | { type: "run_agent"; message: string };

/**
 * Everything a tuner run does before its agent: recheck who it runs as and
 * what it runs, collect candidates in code, drop what history suppresses,
 * resolve what vanished, and finally record the scan on the run. A collection
 * error throws before anything is written, so it never resolves a suggestion.
 * The record marks the housekeeping done: a redelivered run (its first
 * attempt died after recording) resumes from it instead of scanning again,
 * and one that died before redoes the idempotent housekeeping.
 */
export async function runTunerPreflight(params: {
  runId: string;
  trigger: ScheduleTrigger & { tunerKind: TunerKind };
  agentHasRuntime: boolean;
  now: Date;
}): Promise<TunerPreflight> {
  const { trigger, now } = params;
  const tuner = TUNERS[trigger.tunerKind];
  const organizationId = trigger.organizationId;

  if (
    !(await hasTunerAccess({
      userId: trigger.actorUserId,
      organizationId,
      access: "update",
    }))
  ) {
    throw new Error(
      "Tuners are disabled, or the tuner's actor no longer holds tuner:update and log:admin",
    );
  }
  const agent = await tuner.findAgent(organizationId);
  if (!agent || agent.id !== trigger.agentId) {
    throw new Error("The tuner's built-in agent is not available");
  }
  if (params.agentHasRuntime) {
    throw new Error("A tuner agent must not run in an Agent Runtime");
  }

  const recorded = (await ScheduleTriggerRunModel.findById(params.runId))
    ?.tuner;
  if (recorded) {
    return proceed({ organizationId, trigger, record: recorded });
  }

  const scan = await tuner.collect({ organizationId, now });
  const history = await TunerSuggestionModel.historyByFingerprint({
    organizationId,
    fingerprints: scan.candidates.map((c) => c.fingerprint),
  });
  const fresh = scan.candidates.filter(
    (candidate) =>
      suppressionVerdict(
        history.get(candidate.fingerprint) ?? EMPTY_FINGERPRINT_HISTORY,
        candidate.severity,
        now,
      ).type !== "suppressed",
  );
  const forAgent = [...fresh]
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity))
    .slice(0, MAX_CANDIDATES_PER_RUN);
  const record: TunerRunRecord = {
    outcome:
      scan.candidates.length === 0
        ? "no_candidates"
        : forAgent.length === 0
          ? "all_suppressed"
          : "agent_ran",
    candidates: forAgent,
  };

  // A scan that hit a read limit cannot tell a vanished issue from an unread one.
  const resolved = scan.complete
    ? await TunerSuggestionModel.resolveVanished({
        organizationId,
        tunerKind: trigger.tunerKind,
        present: scan.candidates.map((c) => c.fingerprint),
        now,
      })
    : 0;
  await tuner.settle({ organizationId, userId: trigger.actorUserId });
  if (
    !(await ScheduleTriggerRunModel.claimTunerScan({
      runId: params.runId,
      record,
    }))
  ) {
    return { type: "taken" };
  }
  logger.info(
    {
      runId: params.runId,
      tunerKind: trigger.tunerKind,
      collected: scan.candidates.length,
      complete: scan.complete,
      fresh: fresh.length,
      forAgent: forAgent.length,
      resolved,
    },
    "Tuner preflight finished",
  );
  return proceed({ organizationId, trigger, record });
}

/** Unsuppressed candidates handed to the agent per run, most severe first. */
const MAX_CANDIDATES_PER_RUN = 25;
const HISTORY_PER_FINGERPRINT = 3;

async function proceed(params: {
  organizationId: string;
  trigger: ScheduleTrigger;
  record: TunerRunRecord;
}): Promise<TunerPreflight> {
  const { outcome, candidates } = params.record;
  switch (outcome) {
    case "no_candidates":
    case "all_suppressed":
      return { type: "settled", outcome };
    case "agent_ran":
      return {
        type: "run_agent",
        message: tunerMessage({
          instructions: params.trigger.messageTemplate,
          candidates,
          recent: await TunerSuggestionModel.recentByFingerprint({
            organizationId: params.organizationId,
            fingerprints: candidates.map((c) => c.fingerprint),
            perFingerprint: HISTORY_PER_FINGERPRINT,
          }),
        }),
      };
  }
}

function tunerMessage(params: {
  instructions: string;
  candidates: TunerCandidate[];
  recent: TunerSuggestion[];
}): string {
  const candidates = params.candidates.map((candidate) => ({
    ...candidate,
    history: params.recent
      .filter((s) => s.fingerprint === candidate.fingerprint)
      .map((s) => ({
        status: s.status,
        severity: s.severity,
        title: s.title,
        filedAt: s.createdAt.toISOString(),
        adminComment: s.comment,
      })),
  }));
  return `${params.instructions}\n\nCandidates (JSON):\n${JSON.stringify(candidates, null, 2)}`;
}
