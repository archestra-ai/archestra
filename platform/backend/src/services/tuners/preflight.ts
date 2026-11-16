import logger from "@/logging";
import { ScheduleTriggerRunModel, TunerSuggestionModel } from "@/models";
import type { ScheduleTrigger } from "@/types/schedule-trigger";
import type { TunerCandidate, TunerKind, TunerRunOutcome } from "@/types/tuner";
import type { TunerSuggestion } from "@/types/tuner-suggestion";
import {
  EMPTY_FINGERPRINT_HISTORY,
  suppressionVerdict,
} from "@/utils/tuner-suppression";
import { hasTunerAccess } from "./access";
import { TUNERS } from "./registry";

export type TunerPreflight =
  /** Another delivery of this run already scanned; do nothing. */
  | { type: "duplicate" }
  /** Nothing for the agent to look at; the run succeeds without it. */
  | { type: "settled"; outcome: Exclude<TunerRunOutcome, "agent_ran"> }
  | { type: "run_agent"; message: string };

const HISTORY_PER_FINGERPRINT = 3;

/**
 * Everything a tuner run does before its agent: recheck who it runs as and
 * what it runs, collect candidates in code, claim the run, resolve what
 * vanished, and drop what history suppresses. A collection error throws
 * before anything is written, so it never resolves a suggestion.
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

  const collected = await tuner.collect({ organizationId, now });
  const history = await TunerSuggestionModel.historyByFingerprint({
    organizationId,
    fingerprints: collected.map((c) => c.fingerprint),
  });
  const forAgent = collected.filter(
    (candidate) =>
      suppressionVerdict(
        history.get(candidate.fingerprint) ?? EMPTY_FINGERPRINT_HISTORY,
        candidate.severity,
        now,
      ).type !== "suppressed",
  );
  const outcome: TunerRunOutcome =
    collected.length === 0
      ? "no_candidates"
      : forAgent.length === 0
        ? "all_suppressed"
        : "agent_ran";

  if (
    !(await ScheduleTriggerRunModel.claimTunerScan({
      runId: params.runId,
      record: { outcome, candidates: forAgent },
    }))
  ) {
    return { type: "duplicate" };
  }

  const resolved = await TunerSuggestionModel.resolveVanished({
    organizationId,
    tunerKind: trigger.tunerKind,
    present: collected.map((c) => c.fingerprint),
    now,
  });
  await tuner.settle({ organizationId, userId: trigger.actorUserId });
  logger.info(
    {
      runId: params.runId,
      tunerKind: trigger.tunerKind,
      collected: collected.length,
      forAgent: forAgent.length,
      resolved,
    },
    "Tuner preflight finished",
  );

  switch (outcome) {
    case "no_candidates":
    case "all_suppressed":
      return { type: "settled", outcome };
    case "agent_ran":
      return {
        type: "run_agent",
        message: tunerMessage({
          instructions: trigger.messageTemplate,
          candidates: forAgent,
          recent: await TunerSuggestionModel.recentByFingerprint({
            organizationId,
            fingerprints: forAgent.map((c) => c.fingerprint),
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
